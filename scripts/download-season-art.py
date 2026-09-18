"""Download actual art and Chinese card renders by source card ID, no name guessing."""
import json,subprocess,concurrent.futures
from pathlib import Path
s=json.loads(Path('src/season/snapshot.json').read_text())
ids={c['id'] for group in ['minions','spells','heroes','gifts'] for c in s[group]}
ids.update(json.loads(Path('src/season/trinket-pool.json').read_text())['ids'])
ids.update(c['id'] for c in json.loads(Path('src/season/trinket-dependencies.json').read_text())['cards'])
ids.update(json.loads(Path('src/season/tier-seven-pool.json').read_text()))
ids.update(['BGFYM_000','BGFYM_011','BGFYM_002t'])
ids.update(c['id'] for c in s['related'] if c['id'].startswith('BGS_Treasures_') or 'MagicItem_' in c['id'])
Path('public/art').mkdir(exist_ok=True);Path('public/cards').mkdir(exist_ok=True)
def fetch(job):
 id,kind=job;folder='art' if kind=='orig' else 'cards';p=Path(f'public/{folder}/{id}.png')
 if p.exists() and p.read_bytes()[:8]==b'\x89PNG\r\n\x1a\n':return None
 url=f'https://art.hearthstonejson.com/v1/{"orig" if kind=="orig" else "render/latest/zhCN/512x"}/{id}.png'
 temp=p.with_suffix('.tmp');r=subprocess.run(['curl','-Ls','--retry','2','--max-time','30','-w','%{http_code}',url,'-o',str(temp)],capture_output=True,text=True)
 if r.stdout=='200' and temp.exists() and temp.read_bytes()[:8]==b'\x89PNG\r\n\x1a\n':temp.rename(p);return None
 temp.unlink(missing_ok=True);return {'id':id,'kind':kind,'status':r.stdout}
related=json.loads(Path('scripts/related-art.json').read_text())
jobs=[(id,k) for id in sorted(ids) for k in ['orig','render']]
jobs.extend((id,'orig') for id in related if id not in ids)
with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:failed=[v for v in ex.map(fetch,jobs) if v]
Path('docs/art-manifest.json').write_text(json.dumps({'source':'https://art.hearthstonejson.com','note':'Art/renders fetched by exact IDs; render endpoint is latest and may update independently of pinned game data.','cards':sorted(ids),'relatedArt':related,'failed':failed},ensure_ascii=False,indent=2))
print('asset requests',len(jobs),'failed',len(failed));print(failed[:20])

Path('src/season/assets.json').write_text(json.dumps({'art':sorted(p.stem for p in Path('public/art').glob('*.png')),'renders':sorted(p.stem for p in Path('public/cards').glob('*.png'))},separators=(',',':')))
