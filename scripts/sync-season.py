"""Import a pinned HearthstoneJSON build; preserve source IDs and reproducible provenance."""
import json, re, hashlib, subprocess
from pathlib import Path
rules=json.loads(Path('src/season/current-rules.json').read_text())
BUILD=rules['build']
def read_build(build):
 cache=Path('/tmp') / f'hearthstone-{build}-zhCN.json'
 if not cache.exists():
  subprocess.run(['curl','--fail','--location','--retry','3','--user-agent','Mozilla/5.0',f'https://api.hearthstonejson.com/v1/{build}/zhCN/cards.json','--output',str(cache)],check=True)
 return cache.read_bytes()
raw=read_build(BUILD);base_raw=read_build(rules['baseBuild'])
base=json.loads(base_raw);latest=json.loads(raw);latest_by_id={c['id']:c for c in latest}
# 36.6 preloads September 22's pool and balance changes. Only these two cards
# were confirmed live early by Blizzard; preserve the pre-update rules elsewhere.
updates={latest_by_id[id]['dbfId'] for id in rules['liveCardUpdates']}
updates.update(latest_by_id[id]['battlegroundsPremiumDbfId'] for id in rules['liveCardUpdates'])
x=[c for c in base if c['dbfId'] not in updates]+[c for c in latest if c['dbfId'] in updates]
if rules.get('preview'):
 x=latest
preview=json.loads(Path('src/season/preview-pool.json').read_text()) if rules.get('preview') else None
by={c['dbfId']:c for c in x}
def clean(t):
 t=re.sub(r'<[^>]+>', '', t or '').replace('\n','').replace('[x]','')
 # Numbers can begin a real second sentence (e.g. Lockbox's five-turn reward).
 # Keep the full rules text; stripping numeric suffixes silently removed mechanics.
 t=re.split(r'(?<=。)\d+(?=使一个随从获得)',t)[0]
 if len(t)>8:
  t=re.split(r'(?<=[。！）])\d+(?='+re.escape(t[:6])+r')',t)[0]
 return t
minions=[c for c in x if c.get('isBattlegroundsPoolMinion') and not c.get('isBattlegroundsDuosExclusive') and c.get('techLevel',9)<=6 and c['id'] not in rules['bannedMinions']]
spells=[c for c in x if c.get('isBattlegroundsPoolSpell') and not c.get('isBattlegroundsDuosExclusive') and c.get('techLevel',9)<=6]
heroes=[c for c in x if c.get('battlegroundsHero') and not c.get('isBattlegroundsDuosExclusive')]
trinkets=[c for c in x if c.get('type')=='BATTLEGROUND_TRINKET' and not c.get('isBattlegroundsDuosExclusive')]
gifts=[c for c in x if c.get('isBattlegroundsDarkGift')]
if preview:
 minions=[c for c in x if c['id'] in preview['minions'] and c.get('techLevel',9)<=6]
 spells=[c for c in x if c['id'] in preview['spells']]
 heroes=[c for c in x if (c.get('battlegroundsHero') or c['id'] in ['BG36_HERO_000','BG36_HERO_002']) and not c.get('isBattlegroundsDuosExclusive') and c['id'] not in rules['heroBans']]
# Related cards are data only and never enter the recruit pool.
related=[c for c in x if c.get('set')=='BATTLEGROUNDS' and c.get('type') in ['MINION','SPELL','BATTLEGROUND_SPELL'] and not c.get('battlegroundsNormalDbfId') and not c.get('battlegroundsTimewarpCard') and not c.get('isBattlegroundsBuddy')]
def convert(c):
 g=by.get(c.get('battlegroundsPremiumDbfId'),{})
 p=by.get(c.get('heroPowerDbfId'),{})
 return {k:v for k,v in dict(id=c['id'],name=c['name'],tier=c.get('techLevel',1),attack=c.get('attack',0),health=c.get('health',0),cost=c.get('cost',0),text=clean(c.get('text','')),races=c.get('races',[]),mechanics=c.get('mechanics',[]),goldenText=clean(g.get('text','')),goldenAttack=g.get('attack'),goldenHealth=g.get('health'),goldenId=g.get('id'),armor=c.get('armor',0),power={'id':p.get('id'),'name':p.get('name'),'text':clean(p.get('text','')),'cost':p.get('cost',0)} if p else None,school=c.get('spellSchool'),related=by.get(c.get('battlegroundsRelatedCard'),{}).get('id')).items() if v is not None}
result={'meta':{'season':rules['season'],'patch':rules['patch'],'build':BUILD,'date':rules['asOf'],'source':f'https://api.hearthstonejson.com/v1/{BUILD}/zhCN/cards.json','sha256':hashlib.sha256(raw).hexdigest(),'baseBuild':rules['baseBuild'],'baseSource':f'https://api.hearthstonejson.com/v1/{rules["baseBuild"]}/zhCN/cards.json','baseSha256':hashlib.sha256(base_raw).hexdigest(),'liveCardUpdates':rules['liveCardUpdates'],'rulesSources':rules['sources'],'poolDefinition':'36.4.2 pool plus confirmed 36.6 live additions and bans; excludes scheduled 36.6.1 changes; non-Duos, Tier 1–6','trinketPoolVerified':False},'minions':list(map(convert,minions)),'spells':list(map(convert,spells)),'heroes':list(map(convert,heroes)),'trinkets':list(map(convert,trinkets)),'gifts':list(map(convert,gifts)),'related':list(map(convert,related))}
result['retiredHeroes']=[convert(c) for c in x if c['id'] in rules.get('heroBans', [])]
if preview:
 result['meta']['preview']=True
 result['meta']['scheduledRelease']=rules['scheduledRelease']
 result['meta']['poolDefinition']='Explicit 36.6.1 announcement pool; preview enabled by user before official launch; non-Duos, Tier 1–6'
Path('src/season/snapshot.json').write_text(json.dumps(result,ensure_ascii=False,separators=(',',':')))
print({k:len(v) for k,v in result.items() if isinstance(v,list)})
Path('docs/season-provenance.json').write_text(json.dumps(result['meta'],ensure_ascii=False,indent=2))
