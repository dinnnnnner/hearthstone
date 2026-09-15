"""Check legal actions, recurrent isolation and latency on public observation fixtures."""
import argparse
import json
from pathlib import Path
import resource
from .serve import Policy
from .recruit_search import SearchConfig


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('model', type=Path)
    parser.add_argument('fixtures', type=Path, help='JSON array of public rows: entities, legal, memory, previous')
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--time-ms', type=int, default=1000)
    args = parser.parse_args()
    policy = Policy(args.model, args.bundle, SearchConfig(time_ms=args.time_ms))
    reports = []
    try:
        for row in json.loads(args.fixtures.read_text()):
            request = dict(contract=policy.metadata['contract'], rows=[row])
            direct = policy.predict(request)['rows'][0]
            result = policy.predict(request | dict(search=True))
            chosen = result['rows'][0]
            assert chosen['action'] in row['legal'], 'Search returned an illegal action'
            assert chosen['memory'] == direct['memory'], 'Search polluted real recurrent state'
            urgent = policy.predict(request | dict(search=True, searchTimeMs=0))['rows'][0]
            assert urgent['search']['simulations'] == 0
            assert urgent['memory'] == direct['memory']
            reports.append(dict(turn=row['entities'][0]['details']['turn'], action=chosen['action'],
                                elapsed_ms=result['elapsedMs'], search=chosen['search']))
        report = dict(metadata=policy.metadata, python_peak_rss_mib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024,
                      memory_isolation=True, authoritative_mask=True, deadline_direct_policy=True,
                      scope='Functional/latency fixtures with reset recurrent memory; not a playing-strength evaluation', fixtures=reports)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
        print(json.dumps({k: v for k, v in report.items() if k != 'metadata'}, ensure_ascii=False))
    finally:
        policy.search.close()


if __name__ == '__main__': main()
