#!/usr/bin/env python3
"""Compare native shared-library responses with the production TS reference fixtures."""
import json
from pathlib import Path
import sys
from collections import Counter
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'rl/python'))
from tavern_rl.native_rules import NativeRules

native=NativeRules()
counts=Counter();failures=[]
for line in (ROOT/'native/target/parity/cases.jsonl').read_text().splitlines():
    case=json.loads(line);kind=case['name'].split(':')[0]
    try:
        actual=native.call(**case['request'])
        if 'error' in case or actual!=case.get('expected'):
            failures.append({'name':case['name'],'expected':case.get('expected',case.get('error')),'actual':actual})
    except Exception as error:
        if str(error)!=case.get('error'):
            failures.append({'name':case['name'],'expected':case.get('expected',case.get('error')),'actualError':str(error)})
    counts[kind]+=1
if failures:
    (ROOT/'native/target/parity/native-failures.json').write_text(json.dumps(failures[:10],ensure_ascii=False,indent=2))
    raise AssertionError(f'{len(failures)} differences; see native/target/parity/native-failures.json')
try:
    native.require_full_engine()
except RuntimeError as error:
    assert 'RUST_ENGINE_INCOMPLETE' in str(error)
else:
    raise AssertionError('Incomplete engine must not enable full games')
report={'runtime':'python-native','cases':sum(counts.values()),'counts':dict(counts),'mismatches':0,'fullEngineGate':'rejected'}
(ROOT/'native/target/parity/native-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(report,ensure_ascii=False))
