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


def should_send(row, state, mode):
    return (snapshot_key(row) != state.get('lastSent') and
            (mode == 'all' or not row['healthy'] or row.get('watch_complete')))


def message(config, row, job):
    checked = dt.datetime.fromisoformat(row['utc']).astimezone(dt.timezone(dt.timedelta(hours=8)))
    deadline = dt.datetime.fromisoformat(job['deadlineUtc']).astimezone(checked.tzinfo)
    status = '异常' if not row['healthy'] else '已结束' if row.get('watch_complete') else '正常'
    lines = [f'巡检时间：{checked:%Y-%m-%d %H:%M:%S} 北京时间',
             f'巡检结果：{status}', f'训练状态：{row["stage"]}',
             f'计划截止：{deadline:%Y-%m-%d %H:%M:%S} 北京时间', '']
    for member in row.get('members', []):
        depth = {0: 64, 1: 256, 2: 1024}.get(member['index'], '?')
        lines.append(f'{depth} 层：累计 {member["episodes"]} 局，更新 {member["iteration"]} 次，阶段 {member["stage"]}')
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
    job_path = Path(config['job'])
    job = read_json(job_path)
    output = Path(config['output'])
    output.mkdir(parents=True, exist_ok=True)
    state_path = output / 'state.json'
    with (output / 'mail.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        while True:
            try:
                row = read_json(job_path.parent / 'health/latest.json')
                if row['job_pid'] != job['pid']:
                    raise ValueError('Health snapshot belongs to a different training job')
                msg = message(config, row, job)
                if args.preview:
                    print(msg.as_string())
                    return
                state = read_json(state_path) if state_path.exists() else {}
                if should_send(row, state, config['mode']):
                    deliver(config, msg)
                    state.update(lastSent=snapshot_key(row), snapshotUtc=row['utc'],
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
