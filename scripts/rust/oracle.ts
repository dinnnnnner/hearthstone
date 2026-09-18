import { addHeroTrinketCases } from './hero-trinket-oracle';
import { addRecruitCases } from './recruit-oracle';
import { writeFileSync, mkdirSync } from 'node:fs';
import { ALL_CARDS, getDef } from '../../src/data';
import { makeMinion } from '../../src/engine';
import { createSeason, minionCost, spellCost, minionUsesHealth, spellUsesHealth, refreshPayment, assertSeasonPool, giftTierRange, eligibleGifts, seasonTargets, seasonPowerState, offerTrinkets, trinketCost } from '../../src/season/engine';
import { nguyenPowerEligible, equipPowers } from '../../src/season/powers';
import { SEASON_HEROES, GIFTS, RAW_TRINKETS } from '../../src/season/catalog';
import { withSimulation } from '../../src/simulation';
// Build script exports private reference functions only into this test bundle.
import { nativeOracleHooks } from '../../src/season/engine';
import { Random } from '../../rl/environment';
const lines:string[]=[];
function add(name:string,request:Record<string,unknown>,evaluate:()=>unknown) {
  request=JSON.parse(JSON.stringify(request));
  try {lines.push(JSON.stringify({name,request,expected:JSON.parse(JSON.stringify(evaluate()))}));}
  catch(e){lines.push(JSON.stringify({name,request,error:e instanceof Error?e.message:String(e)}));}
}
const ids=[...new Set(ALL_CARDS.map(c=>c.id))];
for(const id of ids)for(const golden of [false,true])for(const fromPool of [false,true]) {
  const uid=`native-${id}-${golden}-${fromPool}`;
  add(`make:${uid}`,{command:'makeMinion',id,uid,golden,fromPool},()=>withSimulation({uid:()=>uid,recordFrames:false,recordLogs:false},()=>makeMinion(id,golden,fromPool)));
}
const random=new Random(89321);
for(const id of ids) {
  const m=makeMinion(id,false,true);m.uid='native-gold';m.attack+=Math.floor(random.next()*100);m.health+=Math.floor(random.next()*100);
  m.counters={deathStatsHealth:m.health};m.gift='BG36_MidGameEffect_000t22';
  add(`golden:${id}`,{command:'makeGolden',minion:m},()=>{const out=structuredClone(m);nativeOracleHooks.makeGolden(out);return out});
  const abilities=[...(getDef(id).abilities||[]),{event:'death',op:'summon',id:'BG25_001',amount:2,goldenAmount:5,summonGolden:false}];
  for(const a of abilities) for(const golden of [false,true]) {
    const source={...m,golden};add(`copy:${id}:${a.op}:${golden}`,{command:'copyAbility',minion:source,ability:a},()=>nativeOracleHooks.copiedAbility(source,a));
  }
}
const template=createSeason('s14_lich',()=>.37);
template.season!.powers=[];template.season!.trinkets=[];template.board=[];template.hand=[];template.shop=[];
for(const id of ids.filter(id=>getDef(id).kind!=='spell' && !getDef(id).abilities?.some(a=>a.op==='alwaysGolden'))) {
  // Triple comparison includes the whole source's native transform, prior to unrelated settlement effects.
  const parts=[1,2,3].map(i=>{const m=makeMinion(id);m.uid=`p${i}`;m.attack+=i;m.health+=2*i;m.copies={[id]:1};m.keywords=[...new Set([...m.keywords,'圣盾'] as typeof m.keywords)];
    m.magneticCount=i;m.counters={hammerAttack:i,volumizerHealth:i};m.extraAbilities=[{event:'death',op:'buff',attack:i,health:i}];
    if(i===2){m.gift='BG36_MidGameEffect_000t22';m.giftTurn=3;m.rebornNext=true;m.temporary={attack:1,health:2,keywords:['圣盾']};}return m;});
  const s=structuredClone(template);s.board=[parts[0]];s.hand=parts.slice(1);
  add(`triple:${id}`,{command:'mergeTriple',parts,uid:'merged',clockwork:false},()=>withSimulation({uid:()=> 'merged',recordFrames:false,recordLogs:false},()=>{
    nativeOracleHooks.triples(s);
    const m=s.hand[0];if(m.counters)delete m.counters.enteredTurn;
    return m;
  }));
}
const seasonIds=ids.filter(id=>id.startsWith('s14_'));
const itemIds=['BG32_MagicItem_957','BG35_MagicItem_743','BG36_MagicItem_202','BG30_MagicItem_701','BG32_MagicItem_821','BG32_MagicItem_822'];
for(let i=0;i<2000;i++) {
  const s=structuredClone(template);s.hero=SEASON_HEROES[i%SEASON_HEROES.length].id;delete s.season!.powers;
  s.turn=1+Math.floor(random.next()*20);s.season!.trinkets=itemIds.filter(()=>random.next()<.3);s.season!.trinketBuys=Math.floor(random.next()*4);
  s.season!.spellDiscount=Math.floor(random.next()*5);s.season!.freeRefresh=random.next()<.3?1:0;
  s.season!.nozdormuRefreshTurn=random.next()<.5?s.turn:0;
  const counters:Record<string,number>={};
  for(const key of ['eyePurchases','prizeMinionCost',`pirateBought:${s.turn}`,`prizeDiscount:${s.turn}`,`demonHealth:${s.turn}`,`spellHealth:${s.turn}`,'power:aranna:attacks','power:taethelan:boughtSpells'])counters[key]=Math.floor(random.next()*18);
  s.season!.counters=counters;
  const m=makeMinion(seasonIds[i%seasonIds.length]);if(random.next()<.3)m.counters={shopCost:Math.floor(random.next()*5),healthPurchase:1};
  s.board=seasonIds.filter(id=>getDef(id).abilities?.some(a=>['healthRefresh','timewarpSpellDiscount'].includes(a.op))).map((id,n)=>{
    const x=makeMinion(id,random.next()<.5);x.uid=`board-${n}`;x.counters={[`spellDiscount:${s.turn}`]:Math.floor(random.next()*5)};return x;});
  if(random.next()<.5)delete s.season!.healthRefreshUses;
  s.season!.healthRefreshes=Math.floor(random.next()*8);
  add(`prices:${i}`,{command:'prices',state:s,minion:m},()=>({minionCost:minionCost(s,m),spellCost:spellCost(s,m),minionUsesHealth:minionUsesHealth(s,m),spellUsesHealth:spellUsesHealth(m,s),refreshPayment:refreshPayment(s)}));
}
for(let i=0;i<100;i++){
 const s=createSeason('s14_lich',new Random(i).next);
 add(`pool:${i}`,{command:'assertPool',state:s},()=>{assertSeasonPool(s);return true});
 s.pool[Object.keys(s.pool)[0]]++;
 add(`bad-pool:${i}`,{command:'assertPool',state:s},()=>{assertSeasonPool(s);return true});
 const pool=Object.fromEntries(Object.keys(s.pool).map(id=>[id,Math.floor(random.next()*4)]));
 const state=structuredClone(template);state.pool=pool;state.tier=1+i%6;
 const rng=new Random(i);
 add(`draw:${i}`,{command:'drawMinion',pool,state,seed:i,tier:state.tier,uid:'draw'},()=>withSimulation({uid:()=> 'draw',recordFrames:false,recordLogs:false},()=>{
  const minion=nativeOracleHooks.draw(state,rng.next);return{pool:state.pool,minion:minion||null,rng:rng.state,draws:1};
 }));
}
for(let turn=1;turn<=30;turn++)add(`gift-tier:${turn}`,{command:'giftTierRange',turn},()=>giftTierRange(turn));
for(let i=0;i<2000;i++){
 const s=structuredClone(template);s.turn=1+i%20;s.tier=1+i%6;s.health=i%31;s.gold=i%11;s.upgrade=i%7;
 delete s.season!.powers;s.hero=SEASON_HEROES[i%SEASON_HEROES.length].id;
 s.season!.trinkets=['BG35_MagicItem_801','BG36_MagicItem_403','BG36_MagicItem_403t'].filter(()=>random.next()<.4);
 s.season!.heroPowerUses=i%5;s.season!.heroPowerUsesTurn=i%3;s.season!.elementalsPlayed=i%7;
 s.season!.counters={discarded:i%8,snakeUnlock:i%10,soldBaller:i%2,patchesDiscount:i%8,togwaggleDiscount:i%7,nobundoDiscount:i%3,automatonSummons:i%12};
 s.season!.buffs=Object.fromEntries(['volumizer','beast','undead','beetle','shop','spell','eternalPortrait'].map(k=>[k,{attack:i%7,health:i%5}]));
 s.season!.battlecries=i%7;s.season!.spellsCast=i%11;s.season!.goldenPlayed=i%6;
 const unit=(j:number)=>{const m=makeMinion(seasonIds[(i+j)%seasonIds.length],random.next()<.5);m.uid=`unit-${j}`;if(random.next()<.2)m.gift='BG36_MidGameEffect_000t22';if(random.next()<.3)m.keywords.push('圣盾');return m};
 s.board=Array.from({length:i%8},(_,j)=>unit(j+1));s.hand=Array.from({length:i%7},(_,j)=>unit(j+20));s.shop=[unit(50),unit(51)];s.season!.spellShop=[makeMinion('s14_BG28_810')];
 const m=unit(0);m.counters={hammerAttack:i%5,hammerHealth:i%2,volumizerAttack:i%3,volumizerHealth:i%4};
 const id=s.hero;
 add(`power:${i}`,{command:'powerState',state:s,id},()=>seasonPowerState(s,id));
 add(`nguyen:${i}`,{command:'nguyenPowerEligible',state:s,id},()=>nguyenPowerEligible(s,id));
 const powers=i%2?[id,'s14_millhouse']:['s14_reno',id];
 add(`equip:${i}`,{command:'equipPowers',state:s,ids:powers},()=>{const x=structuredClone(s);equipPowers(x,powers);return x});
 add(`gift-eligible:${i}`,{command:'eligibleGifts',state:s,minion:m},()=>eligibleGifts(s,m));
 const gift=GIFTS[i%GIFTS.length].id;
 add(`gift-attach:${i}`,{command:'attachDarkGift',state:s,minion:m,id:gift},()=>{const x=structuredClone(m);nativeOracleHooks.attachDarkGift(s,x,gift);return x});
 const event=['battlecry','cast','activate'][i%3];
 add(`targets:${i}`,{command:'targets',state:s,minion:m,event},()=>seasonTargets(s,m,event));
 add(`sync:${i}`,{command:'syncStats',state:s,minion:m,onBoard:i%2===0},()=>{const x=structuredClone(m);nativeOracleHooks.syncCardStats(s,x,i%2===0?[x,...s.board]:s.board);return x});
 add(`global:${i}`,{command:'applyGlobal',state:s,minion:m},()=>{const x=structuredClone(m);nativeOracleHooks.applyGlobal(s,x);return x});
 const item=RAW_TRINKETS[i%RAW_TRINKETS.length].id;
 add(`trinket-eligible:${i}`,{command:'canOfferTrinket',state:s,id:item},()=>nativeOracleHooks.canOfferTrinket(s,item));
 add(`trinket-cost:${i}`,{command:'trinketCost',state:s,id:item},()=>trinketCost(s,item));
 if(i<300){const school=i%2?'LESSER_TRINKET':'GREATER_TRINKET';const rng=new Random(i);let draws=0;
  add(`trinket-offer:${i}`,{command:'offerTrinkets',state:s,school,seed:i},()=>{const x=structuredClone(s);offerTrinkets(x,school,()=>{draws++;return rng.next()});return{state:x,rng:rng.state,draws}});
 }
}
addRecruitCases(add);
addHeroTrinketCases(add);
mkdirSync('native/target/parity' ,{recursive:true});
writeFileSync('native/target/parity/cases.jsonl',lines.join('\n')+'\n');console.log(JSON.stringify({cases:lines.length}));
