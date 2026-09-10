"""Import a pinned HearthstoneJSON build; preserve source IDs and reproducible provenance."""
import json, re, hashlib, subprocess
from pathlib import Path
BUILD='251332'
cache=Path('/tmp') / f'hearthstone-{BUILD}-zhCN.json'
if not cache.exists():
 subprocess.run(['curl','--fail','--location','--retry','3',f'https://api.hearthstonejson.com/v1/{BUILD}/zhCN/cards.json','--output',str(cache)],check=True)
raw=cache.read_bytes()
x=json.loads(raw);by={c['dbfId']:c for c in x}
def clean(t):
 t=re.sub(r'<[^>]+>', '', t or '').replace('\n','').replace('[x]','')
 # Numbers can begin a real second sentence (e.g. Lockbox's five-turn reward).
 # Keep the full rules text; stripping numeric suffixes silently removed mechanics.
 t=re.split(r'(?<=。)\d+(?=使一个随从获得)',t)[0]
 if len(t)>8:
  t=re.split(r'(?<=[。！）])\d+(?='+re.escape(t[:6])+r')',t)[0]
 return t
minions=[c for c in x if c.get('isBattlegroundsPoolMinion') and not c.get('isBattlegroundsDuosExclusive') and c.get('techLevel',9)<=6]
spells=[c for c in x if c.get('isBattlegroundsPoolSpell') and not c.get('isBattlegroundsDuosExclusive') and c.get('techLevel',9)<=6]
heroes=[c for c in x if c.get('battlegroundsHero') and not c.get('isBattlegroundsDuosExclusive')]
trinkets=[c for c in x if c.get('type')=='BATTLEGROUND_TRINKET' and not c.get('isBattlegroundsDuosExclusive')]
gifts=[c for c in x if c.get('isBattlegroundsDarkGift')]
# Related cards are data only and never enter the recruit pool.
related=[c for c in x if c.get('set')=='BATTLEGROUNDS' and c.get('type') in ['MINION','SPELL','BATTLEGROUND_SPELL'] and not c.get('battlegroundsNormalDbfId') and not c.get('battlegroundsTimewarpCard') and not c.get('isBattlegroundsBuddy')]
def convert(c):
 g=by.get(c.get('battlegroundsPremiumDbfId'),{})
 p=by.get(c.get('heroPowerDbfId'),{})
 return {k:v for k,v in dict(id=c['id'],name=c['name'],tier=c.get('techLevel',1),attack=c.get('attack',0),health=c.get('health',0),cost=c.get('cost',0),text=clean(c.get('text','')),races=c.get('races',[]),mechanics=c.get('mechanics',[]),goldenText=clean(g.get('text','')),goldenAttack=g.get('attack'),goldenHealth=g.get('health'),goldenId=g.get('id'),armor=c.get('armor',0),power={'id':p.get('id'),'name':p.get('name'),'text':clean(p.get('text','')),'cost':p.get('cost',0)} if p else None,school=c.get('spellSchool'),related=by.get(c.get('battlegroundsRelatedCard'),{}).get('id')).items() if v is not None}
result={'meta':{'season':14,'patch':'36.4.2','build':BUILD,'date':'2026-09-08','source':f'https://api.hearthstonejson.com/v1/{BUILD}/zhCN/cards.json','sha256':hashlib.sha256(raw).hexdigest(),'poolDefinition':'isBattlegroundsPoolMinion, non-Duos, Tier 1–6','trinketPoolVerified':False},'minions':list(map(convert,minions)),'spells':list(map(convert,spells)),'heroes':list(map(convert,heroes)),'trinkets':list(map(convert,trinkets)),'gifts':list(map(convert,gifts)),'related':list(map(convert,related))}
Path('src/season/snapshot.json').write_text(json.dumps(result,ensure_ascii=False,separators=(',',':')))
print({k:len(v) for k,v in result.items() if isinstance(v,list)})
Path('docs/season-provenance.json').write_text(json.dumps(result['meta'],ensure_ascii=False,indent=2))
