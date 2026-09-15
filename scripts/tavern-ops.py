#!/usr/bin/env python3
"""Operate the existing three-host tavern installation; never store SSH passwords."""
import argparse
import ast
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import time

REPO = Path(__file__).resolve().parents[1]
TEMPLATES = REPO / 'scripts/tavern-ops-templates'
TRAINING_SERVERS = {
    'west': ('root@connect.westb.seetacloud.com', '51735'),
    'legacy': ('root@connect.nmb2.seetacloud.com', '34884'),
}
TRAINING, TRAINING_PORT = TRAINING_SERVERS['west']
COMPUTE = 'zich@100.97.24.15'
PUBLIC = 'root@100.121.69.44'
ROOT = '/root/tavern-four-hour-20260914/population'
PYTHON = '/root/miniconda3/bin/python'
RUNTIME = '/root/autodl-tmp/tavern-mixed-popular-20260914/rl/python'
CONTROL = str(Path.home()/'.cache/tavern-ops/training-west-ssh')


def run(command, capture=False, **kwargs):
    result = subprocess.run(list(map(str, command)), check=True, text=True,
                            stdout=subprocess.PIPE if capture else None, **kwargs)
    return result.stdout if capture else result


def ssh_args(host):
    return ['ssh', '-p', TRAINING_PORT, '-o', f'ControlPath={CONTROL}', TRAINING] if host == TRAINING else ['ssh', host]


def ssh(host, command, capture=False):
    return run([*ssh_args(host), command], capture=capture)


def remote_python(host, code):
    python = PYTHON if host == TRAINING else 'python3'
    return ssh(host, python+' -c '+shlex.quote(code), capture=True)


def copy_to(host, files, directory):
    args = ['scp', '-r', '-o', 'BatchMode=yes']
    if host == TRAINING: args += ['-P', TRAINING_PORT, '-o', f'ControlPath={CONTROL}']
    run([*args, *files, host+':'+directory+'/'])


def copy_from(host, path, target):
    args = ['scp', '-r', '-o', 'BatchMode=yes']
    if host == TRAINING: args += ['-P', TRAINING_PORT, '-o', f'ControlPath={CONTROL}']
    run([*args, host+':'+path, target])


def connect():
    Path(CONTROL).parent.mkdir(parents=True, exist_ok=True)
    check = subprocess.run(['ssh', '-S', CONTROL, '-O', 'check', TRAINING],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if check.returncode:
        run(['ssh', '-M', '-N', '-f', '-S', CONTROL, '-o', 'ControlPersist=2h',
             '-o', 'ConnectTimeout=15', '-p', TRAINING_PORT, TRAINING])


def state():
    return json.loads(remote_python(TRAINING, f"from pathlib import Path;print(Path({ROOT!r}+'/status.json').read_text())"))


def require_stopped(s):
    if s['stage'] not in ('time_limit', 'interrupted') or any(m['pid'] is not None for m in s['members']):
        raise RuntimeError('训练尚未停止。先用 status 查看进度；需要提前停止时用 stop。')


def render(tag, hours=2, model='all', workers=16, games=16, sequence_batch_size=None, fused_adam=None, sampling_processes=1, mps=False, training_graphs=None):
    if model not in ('all', '64', '256', '1024') or min(workers, games) < 1 or workers > games:
        raise ValueError('Choose a valid model and positive workers <= games')
    if sequence_batch_size is not None and sequence_batch_size < 1:
        raise ValueError('Sequence batch size must be positive')
    if not 1 <= sampling_processes <= workers:
        raise ValueError('Sampling processes must be between 1 and workers')
    directory = Path('/tmp')/('tavern-ops-'+tag)
    directory.mkdir(mode=0o700)
    for template in TEMPLATES.glob('*.py'):
        source = template.read_text().replace('__TAG__', tag).replace('__HOURS__', repr(hours))
        if template.name == 'resume.py':
            active = [] if model == 'all' else ['--active-members', str(['64','256','1024'].index(model))]
            source = source.replace("workers=16;games=16;active_members=[]", f"workers={workers};games={games};active_members={active!r}")
            performance = []
            if sequence_batch_size is not None: performance += ['--sequence-batch-size', str(sequence_batch_size)]
            if fused_adam is not None: performance += ['--fused-adam' if fused_adam else '--no-fused-adam']
            if training_graphs is not None: performance += ['--training-graphs' if training_graphs else '--no-training-graphs']
            if sampling_processes > 1: performance += ['--sampling-processes',str(sampling_processes)]
            source = source.replace('performance_args=[]', f'performance_args={performance!r}')
            source = source.replace('use_mps=False', f'use_mps={mps!r}')
        ast.parse(source)
        (directory/template.name).write_text(source)
    return directory


def stop():
    # Validate the current PID before signalling, because status can survive reboots.
    code = f"""import json,os,signal,time
from pathlib import Path
root=Path({ROOT!r});s=json.loads((root/'status.json').read_text())
if s['stage']!='running':raise SystemExit('当前没有运行中的自我对战')
pid=s['pid'];cmd=(Path('/proc')/str(pid)/'cmdline').read_bytes().decode().split('\\x00')
assert '/root/tavern-human-current-06cd2177/population_resume.py' in cmd and str(root) in cmd
os.kill(pid,signal.SIGTERM)
for _ in range(60):
 time.sleep(1);s=json.loads((root/'status.json').read_text())
 if s['stage']=='interrupted' and all(m['pid'] is None for m in s['members']):
  print(json.dumps(s));break
else:raise SystemExit('停止尚未确认，请检查状态；没有强制杀进程')
"""
    print(remote_python(TRAINING, code))


def train(work, tag, hours):
    s = state()
    require_stopped(s)
    remote = '/root/tavern-ops/'+tag
    ssh(TRAINING, 'mkdir -p '+shlex.quote(remote))
    copy_to(TRAINING, [work/'resume.py'], remote)
    output = ssh(TRAINING, PYTHON+' '+remote+'/resume.py', capture=True)
    (work/'resume.json').write_text(output)
    receipt = json.loads(output)
    time.sleep(3)
    s = state()
    if s['pid'] != receipt['pid'] or s['stage'] not in ('preparing', 'running'):
        raise RuntimeError('续训启动检查未通过，请查看 '+remote+'/population.log')
    end = datetime.datetime.fromisoformat(receipt['deadlineUtc']).astimezone(datetime.timezone(datetime.timedelta(hours=8)))
    print(f"已启动 {hours:g} 小时续训；北京时间 {end:%Y-%m-%d %H:%M:%S} 停止。")
    depths=[str([64,256,1024][i]) for i in s.get('active_members',[0,1,2])]
    print('本次更新模型：'+ '、'.join(depths)+' 层；每个模型 '+str(s['workers_per_learner'])+' 并行，每轮 '+str(s['games_per_iteration'])+' 局。')
    print('训练日志：'+remote+'/population.log')


def published_base_models(models, exported):
    # Search variants are independently frozen services. A PPO publication must
    # preserve their endpoint/checkpoint instead of assigning unrelated weights.
    base = [model for model in models if model.get('search') is not True]
    if [m['id'] for m in base] != [m['id'] for m in exported]:
        raise RuntimeError('模型选择项发生变化，需要更新部署配置')
    return base


def publication_plan(models, reports, include_search=False):
    bases = published_base_models(models, reports)
    plan = []
    for i, (base, report) in enumerate(zip(bases, reports)):
        for key in ('episodes', 'checkpointSha256'): base[key] = report[key]
        plan.append(dict(id=base['id'], source=report['id'], unit='tavern-model@'+base['id'],
                         port=[18890,18892,18894][i], search=False, **{k:report[k] for k in ('episodes','checkpointSha256','hashes')}))
        if include_search:
            depth = [64,256,1024][i]
            variants = [m for m in models if m.get('search') is True and m['id'].startswith(f'deep{depth}-search-')]
            if len(variants) != 1: raise RuntimeError(f'Expected one search model for depth {depth}')
            variant = variants[0]
            for key in ('episodes','checkpointSha256'): variant[key] = report[key]
            plan.append(dict(id=f'deep{depth}-search', source=report['id'], unit=f'tavern-deep{depth}-search',
                             port=[18896,18900,18902][i], search=True, **{k:report[k] for k in ('episodes','checkpointSha256','hashes')}))
    return plan


def publish(work, tag, include_search=False, wait_for_idle=False):
    require_stopped(state())
    if not (REPO/'node_modules/@playwright/test').exists():
        raise RuntimeError('缺少项目依赖，请先在仓库运行 npm ci')
    health = json.loads(ssh(PUBLIC, 'curl -fsS http://127.0.0.1:8787/tavern-api/health', capture=True))
    models = json.loads(ssh(PUBLIC, 'cat /opt/bobs-tavern/current/inference-models.json', capture=True))
    remote = '/root/tavern-ops/'+tag
    ssh(TRAINING, 'mkdir -p '+shlex.quote(remote))
    copy_to(TRAINING, [work/'export_all.py', REPO/'scripts/export-inference.py'], remote)
    ssh(TRAINING, 'OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 PYTHONPATH='+RUNTIME+' '+PYTHON+' '+remote+'/export_all.py')
    copy_from(TRAINING, remote+'/export', work)
    copy_from(TRAINING, remote+'/report.json', work)
    report = json.loads((work/'report.json').read_text())
    for model, r in zip(published_base_models(models, report['models']), report['models']):
        for name, digest in r['hashes'].items():
            assert hashlib.sha256((work/'export'/model['id']/name).read_bytes()).hexdigest() == digest
        metadata = json.loads((work/'export'/model['id']/'metadata.json').read_text())
        assert metadata['contract'] == health['ai']['contract'], '线上观察契约与模型不同'
        for key in ('episodes','checkpointSha256'): model[key] = r[key]
    plan = publication_plan(models, report['models'], include_search)
    (work/'deployment.json').write_text(json.dumps(plan,indent=2)+'\n')
    (work/'inference-models.json').write_text(json.dumps(models,ensure_ascii=False,indent=2)+'\n')
    verification = dict(stage='staged', release=tag+'-models', models=models, training=report)
    (work/'model-verification.json').write_text(json.dumps(verification,indent=2)+'\n')
    incoming='.local/share/tavern-models/incoming-'+tag
    ssh(COMPUTE, 'mkdir -p '+incoming)
    copy_to(COMPUTE, [work/n for n in ['export','report.json','deployment.json','stage_compute.py','activate_compute.py','preflight.py']], incoming)
    ssh(COMPUTE, 'python3 '+incoming+'/stage_compute.py')
    copy_from(COMPUTE, incoming+'/preflight-results.json', work)
    public_work='/tmp/tavern-ops-'+tag
    ssh(PUBLIC, 'mkdir -p '+public_work)
    copy_to(PUBLIC, [work/n for n in ['inference-models.json','model-verification.json','stage_public.py','activate_public.py']], public_work)
    rollback=ssh(PUBLIC, 'python3 '+public_work+'/stage_public.py', capture=True)
    (work/'public-rollback.json').write_text(rollback)
    run([sys.executable, work/'deploy.py', *(['--wait-for-idle'] if wait_for_idle else [])])
    env=dict(os.environ,TEST_BASE_URL='https://8.153.150.101',TAVERN_TEST_PATH='/tavern/')
    run(['npx','playwright','test','tests/ai-models.spec.ts','--workers=1'],cwd=REPO,env=env)
    final=json.loads(ssh(PUBLIC,'curl -fsS http://127.0.0.1:8787/tavern-api/health',capture=True))
    assert final['ok'] and final['ai']['errors']==0 and final['ai']['fallbackRounds']==0
    assert all(m['available'] and m['decisions']>0 for m in final['ai']['models'])
    verification.update(stage='verified',health=final,preflight=json.loads((work/'preflight-results.json').read_text()),browserTest='passed')
    (work/'model-verification.json').write_text(json.dumps(verification,indent=2)+'\n')
    copy_to(PUBLIC,[work/'model-verification.json'],'/opt/bobs-tavern/releases/'+tag+'-models')
    ssh(PUBLIC,'chown root:bobs-tavern /opt/bobs-tavern/releases/'+tag+'-models/model-verification.json')
    (REPO/'deploy/inference-models.json').write_text((work/'inference-models.json').read_text())
    print('三个模型已上线并通过对局测试。刷新客户端后新开对局即可使用。')


def main():
    global CONTROL, TRAINING, TRAINING_PORT
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--training-server',choices=TRAINING_SERVERS,default='west',help='west is the Blackwell server; legacy is the stopped 3080 Ti')
    parser.add_argument('--control-path',help='Existing SSH control socket, optional')
    sub=parser.add_subparsers(dest='action',required=True)
    sub.add_parser('status',help='查看训练和线上模型状态')
    sub.add_parser('stop',help='提前停止自我对战，保留已保存检查点')
    p=sub.add_parser('publish',help='正常停训后导出、上线并测试模型')
    p.add_argument('--include-search',action='store_true',help='Also update all three search variants to the exported weights')
    p=sub.add_parser('train',help='从当前完整检查点继续训练')
    p.add_argument('--hours',type=float,required=True)
    p.add_argument('--model',choices=['all','64','256','1024'],default='all',help='Only update this model; other models remain opponents')
    p.add_argument('--workers',type=int,default=16,help='Simulators per active learner')
    p.add_argument('--games',type=int,default=16,help='Complete games collected before each PPO update')
    p.add_argument('--sequence-batch-size',type=int,help='Explicitly override saved recurrent PPO batch')
    p.add_argument('--fused-adam',action=argparse.BooleanOptionalAction,default=None)
    p.add_argument('--training-graphs',action=argparse.BooleanOptionalAction,default=None)
    p.add_argument('--sampling-processes',type=int,default=1)
    p.add_argument('--mps',action='store_true',help='Enable NVIDIA MPS for concurrent CUDA sampler processes')
    sub.add_parser('check',help='只验证本地模板语法，不连接服务器')
    args=parser.parse_args()
    TRAINING,TRAINING_PORT=TRAINING_SERVERS[args.training_server]
    CONTROL=args.control_path or str(Path.home()/'.cache/tavern-ops'/('training-'+args.training_server+'-ssh'))
    hours=getattr(args,'hours',2)
    if not math.isfinite(hours) or hours<=0:parser.error('--hours 必须是正数')
    tag=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S')+'-'+str(os.getpid())
    if getattr(args,'workers',16)<1 or getattr(args,'games',16)<getattr(args,'workers',16):
        parser.error('--games must be at least --workers, both positive')
    if getattr(args,'sequence_batch_size',None) is not None and args.sequence_batch_size < 1:
        parser.error('--sequence-batch-size must be positive')
    if not 1 <= getattr(args,'sampling_processes',1) <= getattr(args,'workers',16):
        parser.error('--sampling-processes must be between 1 and --workers')
    work=render(tag,hours,getattr(args,'model','all'),getattr(args,'workers',16),getattr(args,'games',16),getattr(args,'sequence_batch_size',None),getattr(args,'fused_adam',None),getattr(args,'sampling_processes',1),getattr(args,'mps',False),getattr(args,'training_graphs',None))
    try:
        if args.action=='check': print('模板语法检查通过。');return
        connect()
        if args.action=='status':
            print(json.dumps(state(),ensure_ascii=False,indent=2))
            print(ssh(PUBLIC,'curl -fsS http://127.0.0.1:8787/models',capture=True));return
        if args.action=='stop':stop();return
        if args.action=='train':train(work,tag,hours)
        elif args.action=='publish':publish(work,tag,args.include_search)
    finally:
        archive=Path.home()/'.local/share/tavern-ops/jobs'/tag
        archive.parent.mkdir(parents=True,exist_ok=True)
        shutil.copytree(work,archive)
        print('本次文件：'+str(archive))


if __name__=='__main__':
    try:main()
    except (RuntimeError,subprocess.CalledProcessError,AssertionError) as error:
        print('操作未完成：'+str(error),file=sys.stderr);sys.exit(1)
