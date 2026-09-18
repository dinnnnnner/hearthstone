import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
import { ALL_CARDS, getDef, POOL_COPIES, SHOP_SIZE, UPGRADE_COST, HEROES } from '../../src/data';
import { SEASON_CARDS, SEASON_RELATED, SEASON_SPELLS, SEASON_HEROES, GIFTS, SEASON_META, ALL_TRIBES, HERO_TRIBES } from '../../src/season/catalog';
import { TRINKETS } from '../../src/season/engine';
import { returningTrinkets } from '../../src/season/trinkets';
import rules from '../../src/season/current-rules.json';
import trinketDependencies from '../../src/season/trinket-dependencies.json';
import tierSevenPool from '../../src/season/tier-seven-pool.json';
import trinketTypes from '../../src/season/trinket-types.json';
import { boardPowerTargets, shopPowerTargets, mixedPowerTargets } from '../../src/season/expanded-heroes';
import { SEASON_HERO_DEFINITIONS, RAW_TRINKETS, AI_SEASON_HEROES } from '../../src/season/catalog';
const cards=[...new Set(ALL_CARDS.map(c=>c.id))].map(getDef);
const catalog={seasonRelated:SEASON_RELATED.map(c=>c.id),seasonMeta:SEASON_META,aiHeroPool:AI_SEASON_HEROES.map(h=>h.id),trinketDependencies,prizes:{1:["004","013","029","033","040","100","110"],2:["006","009","010","012","014","018","026","030","101"],3:["011","015","019","020","034","037","039","104"],4:["016","022","023","025","028","032","106"]},schema:'tavern-native-catalog-v1',patch:SEASON_META.patch,rules,cards,heroes:HEROES,
  minionPool:SEASON_CARDS.map(c=>c.id),spellPool:SEASON_SPELLS.map(c=>c.id),heroPool:SEASON_HEROES.map(h=>h.id),gifts:GIFTS,trinkets:TRINKETS,
  tavernSpellIds:[...new Set([...SEASON_SPELLS,...SEASON_RELATED.filter(c=>c.spellSchool==="TAVERN")].map(c=>c.id))],tierSevenPool,trinketRules:returningTrinkets,trinketTypes,rawTrinkets:RAW_TRINKETS,powerDefinitions:SEASON_HERO_DEFINITIONS,powerTargets:{board:[...boardPowerTargets],shop:[...shopPowerTargets],mixed:[...mixedPowerTargets]},tribes:ALL_TRIBES,heroTribes:HERO_TRIBES,poolCopies:POOL_COPIES,shopSize:SHOP_SIZE,upgradeCost:UPGRADE_COST};
const content=JSON.stringify(catalog);
writeFileSync('native/data/catalog.json',content+'\n');
const source=ts.createSourceFile('engine.ts',readFileSync('src/season/engine.ts','utf8'),ts.ScriptTarget.Latest,true);
const handlers: Record<string,string[]>={};
function visit(node: ts.Node, owner='module') {
  if(ts.isFunctionDeclaration(node)&&node.name) owner=node.name.text;
  if(ts.isCaseClause(node)&&ts.isStringLiteral(node.expression)) (handlers[owner]??=[]).push(node.expression.text);
  node.forEachChild(child=>visit(child,owner));
}
visit(source);
const abilities=cards.flatMap(c=>(c.abilities||[]).map(a=>({...a,card:c.id})));
const manifest={schema:'tavern-rust-migration-v1',patch:SEASON_META.patch,catalogSha256:createHash('sha256').update(content+'\n').digest('hex'),
  counts:{definitions:cards.length,minions:SEASON_CARDS.length,spells:SEASON_SPELLS.length,heroes:SEASON_HEROES.length,gifts:GIFTS.length,trinkets:TRINKETS.length},
  operations:[...new Set(abilities.map(a=>a.op))].sort(),events:[...new Set(abilities.map(a=>a.event))].sort(),
  handlers:Object.fromEntries(Object.entries(handlers).map(([k,v])=>[k,[...new Set(v)]])),
  requiredRuntimes:['python-native','node-wasm','browser-wasm'],fullEngineReady:false};
writeFileSync('native/data/migration.json',JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({counts:manifest.counts,operations:manifest.operations.length,catalogSha256:manifest.catalogSha256}));
