#!/usr/bin/env python3
"""Build, compare real TS combat traces, then benchmark the supported subset."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import statistics
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
RESULTS = HERE / 'results'
BINARY = HERE / 'target/release/tavern-combat-prototype'
ORACLE = HERE / 'oracle.cjs'


def run(command, **kwargs):
    return subprocess.run(command, cwd=ROOT, check=True, **kwargs)


def first_difference(a, b, path='$'):
    if type(a) is not type(b):
        return path
    if isinstance(a, dict):
        if a.keys() != b.keys():
            return path + '.keys'
        return next((found for k in a if (found := first_difference(a[k], b[k], path + '.' + k))), None)
    if isinstance(a, list):
        if len(a) != len(b):
            return path + '.length'
        return next((found for i, (x, y) in enumerate(zip(a, b)) if (found := first_difference(x, y, f'{path}[{i}]'))), None)
    return None if a == b else path


def measured(command, payload, name, core):
    # wait4's RSS can inherit the parent's pre-exec high water mark. Each benchmark
    # therefore reports its post-exec /proc/self/status VmHWM; retain wait4 for auditing.
    input_path = RESULTS / (name + '-input.json')
    output_path = RESULTS / (name + '-output.json')
    error_path = RESULTS / (name + '-stderr.txt')
    input_path.write_text(payload or '')
    files = [(os.POSIX_SPAWN_OPEN, 0, str(input_path), os.O_RDONLY, 0),
             (os.POSIX_SPAWN_OPEN, 1, str(output_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600),
             (os.POSIX_SPAWN_OPEN, 2, str(error_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)]
    previous = os.sched_getaffinity(0) if core is not None else None
    try:
        if core is not None:
            os.sched_setaffinity(0, {core})
        start = time.perf_counter()
        pid = os.posix_spawnp(command[0], command, os.environ, file_actions=files)
    finally:
        if previous is not None:
            os.sched_setaffinity(0, previous)
    _, status, usage = os.wait4(pid, 0)
    wall = time.perf_counter() - start
    if os.waitstatus_to_exitcode(status) != 0:
        raise RuntimeError(error_path.read_text())
    data = json.loads(output_path.read_text())
    assert data['ok'], data
    return {**data, 'process_wall_seconds': wall, 'wait4_peak_rss_mib': usage.ru_maxrss / 1024}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--random-cases', type=int, default=10000)
    parser.add_argument('--bench-cases', type=int, default=256)
    parser.add_argument('--repetitions', type=int, default=100)
    parser.add_argument('--rounds', type=int, default=5)
    args = parser.parse_args()
    if min(vars(args).values()) < 1:
        parser.error('all counts must be positive')
    if platform.system() != 'Linux':
        parser.error('RSS benchmark currently requires Linux wait4 semantics')
    os.chdir(ROOT)
    RESULTS.mkdir(exist_ok=True)
    manifest = str(HERE / 'Cargo.toml')
    run(['cargo', 'test', '--locked', '--manifest-path', manifest])
    run(['cargo', 'build', '--release', '--locked', '--manifest-path', manifest])
    run(['node', str(HERE / 'build.mjs')])
    case_path = RESULTS / 'cases.json'
    run(['node', str(ORACLE), 'fixtures', str(case_path), str(args.random_cases)])
    cases = json.loads(case_path.read_text())['cases']
    traces = 0
    # Bound trace memory and output size; fail with a replayable fixture on first difference.
    for offset in range(0, len(cases), 250):
        batch = {'cases': cases[offset:offset + 250]}
        batch_path = RESULTS / 'batch.json'
        batch_path.write_text(json.dumps(batch))
        ts = json.loads(run(['node', str(ORACLE), 'validate', str(batch_path)], capture_output=True, text=True).stdout)
        rust = json.loads(run([str(BINARY)], input=json.dumps(batch) + '\n', capture_output=True, text=True).stdout)
        assert ts['ok'] and rust['ok'], (ts.get('error'), rust.get('error'))
        assert len(ts['results']) == len(rust['results']) == len(batch['cases'])
        for case, expected, actual in zip(batch['cases'], ts['results'], rust['results']):
            difference = first_difference(expected, actual)
            if difference:
                failure = {'case': case, 'path': difference, 'ts': expected, 'rust': actual}
                (RESULTS / 'first-mismatch.json').write_text(json.dumps(failure, ensure_ascii=False, indent=2))
                raise AssertionError(f"{case['name']}: {difference}; see results/first-mismatch.json")
            traces += len(expected['trace'])
        if offset % 2000 == 0:
            print(f'Compared {min(offset + 250, len(cases))}/{len(cases)} cases', flush=True)
    # A deliberately corrupted result must not pass the comparison itself.
    assert first_difference({'damage': 5}, {'damage': 6}) == '$.damage'
    invalid = [
        {'cases': [{**cases[0], 'trinkets': ['unsupported']}]},
        {'cases': [{**cases[1], 'boards': [[{**cases[1]['boards'][0][0], 'card': 's14_BG36_109'}], []]}]},
        {'cases': [{**cases[1], 'boards': [[{**cases[1]['boards'][0][0], 'gift': 'unsupported'}], []]}]},
        {'cases': [{**cases[1], 'boards': [[{**cases[1]['boards'][0][0], 'keywords': ['unknown']}], []]}]},
    ]
    for bad in invalid:
        response = json.loads(run([str(BINARY)], input=json.dumps(bad)+'\n', capture_output=True, text=True).stdout)
        assert response['ok'] is False and response['error']
    # Nonempty random boards avoid making the performance number mostly empty battles.
    candidates = [c for c in cases if c['name'].startswith('random-') and all(c['boards'])]
    benchmark = candidates[:args.bench_cases]
    if len(benchmark) != args.bench_cases:
        raise ValueError('not enough nonempty random cases for benchmark')
    bench_path = RESULTS / 'bench.json'
    bench_path.write_text(json.dumps({'cases': benchmark}))
    payload = json.dumps({'cases': benchmark, 'repetitions': args.repetitions})+'\n'
    core = min(os.sched_getaffinity(0)) if hasattr(os, 'sched_getaffinity') else None
    measurements = {'typescript': [], 'rust': []}
    for trial in range(args.rounds):
        order = ['typescript', 'rust'] if trial % 2 == 0 else ['rust', 'typescript']
        for implementation in order:
            command = [str(BINARY)] if implementation == 'rust' else ['node', str(ORACLE), 'bench', str(bench_path), str(args.repetitions)]
            value = measured(command, payload if implementation == 'rust' else None, f'{implementation}-{trial}', core)
            measurements[implementation].append(value)
            print(f"{implementation} round {trial + 1}: {value['seconds']:.4f}s, RSS {value['peak_rss_mib']:.1f} MiB", flush=True)
    all_runs = measurements['typescript'] + measurements['rust']
    assert len({r['checksum'] for r in all_runs}) == 1, 'Benchmark outcome/RNG checksum differs'
    count = len(benchmark) * args.repetitions
    assert all(r['combats'] == count for r in all_runs)
    summary = {}
    for name, values in measurements.items():
        seconds = statistics.median(r['seconds'] for r in values)
        summary[name] = {'median_seconds': seconds, 'combats_per_second': count / seconds,
                         'median_process_wall_seconds': statistics.median(r['process_wall_seconds'] for r in values),
                         'median_peak_rss_mib': statistics.median(r['peak_rss_mib'] for r in values)}
    hashes = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in [ROOT/'src/season/engine.ts', ROOT/'src/engine.ts', ROOT/'src/simulation.ts',
                        HERE/'src/lib.rs', HERE/'src/main.rs', HERE/'oracle.ts', HERE/'Cargo.lock', HERE/'check.py']}
    report = {'scope': 'Six audited keyword-only cards; no hero powers, trinkets, gifts, deathrattles, auras or deities.',
              'validation': {'cases': len(cases), 'attack_traces': traces, 'mismatches': 0, 'invalid_requests_rejected': len(invalid),
                             'compared': ['attack targets', 'pre/post death boards', 'reborn identities/stats/positions', 'survivors', 'damage', 'RNG state and draw count']},
              'benchmark': {'cases': len(benchmark), 'repetitions': args.repetitions, 'combats_per_round': count, 'rounds': args.rounds,
                            'warmup_passes': 5, 'cpu_affinity': core, 'measurements': measurements, 'summary': summary,
                            'subset_speed_ratio': summary['typescript']['median_seconds']/summary['rust']['median_seconds']},
              'environment': {'platform': platform.platform(), 'machine': platform.machine(),
                              'node': subprocess.check_output(['node','--version'],text=True).strip(),
                              'rustc': subprocess.check_output(['rustc','--version'],text=True).strip()},
              'source_sha256': hashes, 'fixture_sha256': hashlib.sha256(case_path.read_bytes()).hexdigest(),
              'limitations': ['Synthetic keyword-only fixtures, not a sample of full-season training games.',
                              'TS uses the complete production combat dispatcher; Rust implements only the audited subset.',
                              'Core timings exclude process startup, JSON parsing, case preparation, warmup and Python IPC.',
                              'RSS is post-exec /proc/self/status VmHWM, including parsing, prepared inputs and runtime; not per-game memory. wait4 RSS is retained separately because it can inherit the parent high water mark.',
                              'No GPU inference, optimizer updates or end-to-end self-play benchmark.',
                              'Results establish parity with current TS behavior, not correctness against the official game.']}
    path = RESULTS / 'report.json'
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({'validation': report['validation'], 'summary': summary, 'subset_speed_ratio': report['benchmark']['subset_speed_ratio']},indent=2))
    print('Report:', path)


if __name__ == '__main__':
    main()
