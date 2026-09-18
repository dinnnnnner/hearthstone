"""Forward one training job's health snapshots through authenticated TLS SMTP."""
import argparse
import datetime as dt
from email.message import EmailMessage
from email.utils import formatdate
import fcntl
import hashlib
import json
from pathlib import Path
import smtplib
import ssl
import time


def read_json(path):
    return json.loads(Path(path).read_text())


def snapshot_key(row):
    return hashlib.sha256(f"{row['job_pid']}:{row['utc']}".encode()).hexdigest()


def should_send(row, state, mode, minimum_seconds=0, now=None):
    if snapshot_key(row) == state.get('lastSent'):
        return False
    if mode != 'all' and row['healthy'] and not row.get('watch_complete'):
        return False
    changed_alert = not row['healthy'] and (state.get('lastHealthy', True) or row.get('issues',[]) != state.get('lastIssues',[]))
    if not state.get('acceptedUtc') or row.get('watch_complete') or changed_alert:
        return True
    now = now or dt.datetime.now(dt.timezone.utc)
    return (now-dt.datetime.fromisoformat(state['acceptedUtc'])).total_seconds() >= minimum_seconds


def load_snapshot(config, job_path, job):
    if config.get('format') != 'supervised-basic':
        row = read_json(job_path.parent / 'health/latest.json')
        if row['job_pid'] != job['pid']:
            raise ValueError('Health snapshot belongs to a different training job')
        return row
    state = read_json(job_path.parent / 'status.json')
    if state['pid'] != config['supervisorPid'] or Path(state['job']).resolve() != job_path.resolve():
        raise ValueError('Supervisor snapshot belongs to a different training job')
    completed = state['stage'] == 'stopped'
    timestamp = state.get('finished') or state.get('updated') or state['started']
    issues = list(state.get('warnings', [])) + list(state.get('failures', []))
    if state.get('error'):issues.append('Supervisor exception; inspect its log')
    if not completed:
        now = dt.datetime.now(dt.timezone.utc)
        if (now-dt.datetime.fromisoformat(timestamp)).total_seconds() > 90:
            issues.append('巡检状态超过 90 秒未更新')
            timestamp = now.isoformat()
        try:
            fields = Path(f'/proc/{state["pid"]}/stat').read_text().rsplit(') ',1)[1].split()
            valid = fields[0] != 'Z' and fields[19] == str(config['supervisorBirth'])
        except OSError:valid = False
        if not valid:issues.append('训练巡检进程已退出或身份不匹配')
    resource = state.get('resources', {})
    row = dict(job_pid=state['pid'],utc=timestamp,stage=state['stage'],watch_complete=completed,
               healthy=not issues and state.get('reason') not in ('health_stop','supervisor_exception'),issues=issues,
               episode_label='新评分续训累计',members=[])
    for member in state.get('members', []):
        if 'episodes' in member and 'iteration' in member:
            row['members'].append(dict(depth=member['depth'],episodes=member['episodes'],iteration=member['iteration'],
                                       stage='已结束' if member.get('finished') else state['stage']))
    for source,target in [('cpu_percent','cpu_percent_since_previous_check'),('ram_gib','memory_gib'),('disk_free_gib','disk_free_gib')]:
        if source in resource:row[target]=resource[source]
    if 'gpu_percent' in resource:
        row['gpu'] = f"{resource['gpu_percent']}, {resource['vram_used_mib']}, {resource.get('gpu_power_w','?')}"
    return row


def message(config, row, job):
    checked = dt.datetime.fromisoformat(row['utc']).astimezone(dt.timezone(dt.timedelta(hours=8)))
    deadline = dt.datetime.fromisoformat(job['deadlineUtc']).astimezone(checked.tzinfo) if job.get('deadlineUtc') else None
    status = '异常' if not row['healthy'] else '已结束' if row.get('watch_complete') else '正常'
    lines = [f'巡检时间：{checked:%Y-%m-%d %H:%M:%S} 北京时间',
             f'巡检结果：{status}', f'训练状态：{row["stage"]}',
             f'计划截止：{deadline:%Y-%m-%d %H:%M:%S} 北京时间' if deadline else '持续训练，无预设停止时间', '']
    for member in row.get('members', []):
        depth = member.get('depth', {0: 64, 1: 256, 2: 1024}.get(member.get('index'), '?'))
        lines.append(f'{depth} 层：{row.get("episode_label","累计")} {member["episodes"]} 局，更新 {member["iteration"]} 次，阶段 {member["stage"]}')
    if 'cpu_percent_since_previous_check' in row:
        lines.append(f'CPU 配额利用率：{row["cpu_percent_since_previous_check"]:.1f}%')
    if 'gpu' in row:
        lines.append('GPU 瞬时读数（利用率 %、显存 MiB、功率 W）：' + row['gpu'])
    if 'memory_gib' in row:
        lines.append(f'容器内存：{row["memory_gib"]:.1f} GiB')
    if 'disk_free_gib' in row:
        lines.append(f'剩余磁盘：{row["disk_free_gib"]:.1f} GiB')
    if row.get('issues'):
        lines.extend(['', '发现的问题：', *row['issues']])
    msg = EmailMessage()
    msg['From'] = config['sender']
    msg['To'] = config['recipient']
    msg['Subject'] = f'[酒馆训练巡检] {status} {checked:%m-%d %H:%M}'
    msg['Date'] = formatdate(localtime=False)
    msg['Message-ID'] = f'<tavern-{snapshot_key(row)}@{config["sender"].rsplit("@", 1)[1]}>'
    msg.set_content('\n'.join(lines))
    return msg


def deliver(config, msg):
    secret = Path(config['passwordFile'])
    if secret.stat().st_mode & 0o077:
        raise ValueError('SMTP authorization file must have mode 600 or stricter')
    password = secret.read_text().strip()
    if not password:
        raise ValueError('SMTP authorization file is empty')
    client = smtplib.SMTP_SSL(config['host'], config['port'], timeout=20,
                             context=ssl.create_default_context())
    try:
        client.login(config['sender'], password)
        refused = client.send_message(msg, from_addr=config['sender'], to_addrs=[config['recipient']])
        if refused:
            raise RuntimeError('SMTP recipient refused')
    finally:
        # A failed QUIT after accepted DATA must not trigger another delivery.
        try:
            client.quit()
        except (OSError, smtplib.SMTPException):
            client.close()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--config', type=Path, required=True)
    p.add_argument('--preview', action='store_true', help='Print the current email without sending')
    p.add_argument('--once', action='store_true')
    args = p.parse_args()
    config = read_json(args.config)
    if config['mode'] not in ('all', 'alerts'):
        p.error('mode must be all or alerts')
    if config.get('minimumSeconds',0)<0:p.error('minimumSeconds must be nonnegative')
    job_path = Path(config['job'])
    job = read_json(job_path)
    output = Path(config['output'])
    output.mkdir(parents=True, exist_ok=True)
    state_path = output / 'state.json'
    with (output / 'mail.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        while True:
            try:
                row = load_snapshot(config, job_path, job)
                msg = message(config, row, job)
                if args.preview:
                    print(msg.as_string())
                    return
                state = read_json(state_path) if state_path.exists() else {}
                if should_send(row, state, config['mode'], config.get('minimumSeconds',0)):
                    deliver(config, msg)
                    state.update(lastSent=snapshot_key(row), snapshotUtc=row['utc'],
                                 lastHealthy=row['healthy'],lastIssues=row.get('issues',[]),
                                 acceptedUtc=dt.datetime.now(dt.timezone.utc).isoformat())
                    tmp = state_path.with_suffix('.next')
                    tmp.write_text(json.dumps(state, indent=2) + '\n')
                    tmp.replace(state_path)
                    print(json.dumps(dict(event='smtp_accepted', **state)), flush=True)
                if args.once or row.get('watch_complete'):
                    return
            except Exception as error:
                # Never log server error text or credentials.
                print(json.dumps(dict(event='mail_failed', errorType=type(error).__name__)), flush=True)
                if args.once or args.preview:
                    raise SystemExit(1)
                time.sleep(50)
            time.sleep(10)


if __name__ == '__main__':
    main()
