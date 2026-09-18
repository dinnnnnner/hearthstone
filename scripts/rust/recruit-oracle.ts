import { getDef } from '../../src/data';
import { makeMinion, type Game } from '../../src/engine';
import { createSeason, releasePlayerCards, nativeOracleHooks as hooks } from '../../src/season/engine';
import { SEASON_CARDS, SEASON_SPELLS, SEASON_HEROES } from '../../src/season/catalog';
import { Random } from '../../rl/environment';
import { withSimulation } from '../../src/simulation';
type Add=(name:string,request:Record<string,unknown>,evaluate:()=>unknown)=>void;
export function addRecruitCases(add:Add){
 function check(name:string,state:Game,operations:any[],seed:number,logs=true){
  const request={command:'recruitBatch',state,operations,seed,uidCounter:17,recordLogs:logs};
  add(name,request,()=>{
   const s=structuredClone(state);const rng=new Random(seed);let draws=0,serial=17;
   const next=()=>{draws++;return rng.next()};const results:any[]=[];
   return withSimulation({uid:()=>`native-${++serial}`,recordLogs:logs,recordFrames:false},()=>{
    for(const operation of operations){const op=structuredClone(operation);let result:any=null;
     switch(op.op){
      case 'darkDiscover':hooks.darkDiscover(s,next);break;
      case 'applyShop':{const m=op.minion;hooks.applyShop(s,m);result=m;break;}
      case 'scale':hooks.scale(s,op.key,op.attack,op.health);break;
      case 'gain':{const all=[...s.board,...s.hand,...s.shop,...s.discovery];const m=all.find(x=>x.uid===op.uid)!;const source=all.find(x=>x.uid===op.source?.uid)||op.source;hooks.gain({s,board:s.board,rng:next,source},m,op.attack,op.health);break;}
      case 'effect':case 'runEvent':case 'triggerBattlecry':{const all=[...s.board,...s.hand,...s.shop,...s.discovery];const m=op.uid?all.find(x=>x.uid===op.uid)!:op.minion;
       const ctx={s,board:s.board,rng:next,target:all.find(x=>x.uid===op.target),eventMinion:all.find(x=>x.uid===op.eventMinion),fromHand:op.fromHand,permanentSpell:op.permanentSpell,trinket:op.trinket};
       if(op.op==='effect')hooks.effect(ctx,m,op.ability);else if(op.op==='triggerBattlecry')hooks.triggerBattlecry(ctx,m);else hooks.run(ctx,m,op.event);break;}
      case 'putHand':{const card=op.minion;hooks.putHand(s,card,op.markEntered);result=card;break;}
      case 'trinketCard':hooks.trinketCard(s,op.minion);break;
      case 'flushTrinketCards':hooks.flushTrinketCards(s);break;
      case 'triples':hooks.triples(s);break;
      case 'reward':hooks.reward(s,op.tier);break;
      case 'releasePlayerCards':releasePlayerCards(s);break;
      case 'queueDiscovery':hooks.queueDiscover(s,op.kind,op.options);break;
      case 'copyDiscovery':hooks.copyDiscovery(s,op.ids,next);break;
      case 'nextDiscovery':hooks.nextDiscovery(s,next);break;
      case 'drawSpell':result=hooks.drawSpell(s,next,op.cost===undefined?undefined:(d:any)=>d.cost===op.cost)||null;break;
      case 'gold':hooks.gold(s,op.amount);break;
      case 'trinketGold':hooks.trinketGold(s,op.amount);break;
      case 'deityGain':hooks.deityGain(s,op.attack,op.health);break;
      default:throw Error(`Unsupported native recruitment operation: ${op.op}`);
     }
     results.push(structuredClone(result));
    }
    return {state:s,rng:rng.state,draws,uidCounter:serial,results};
   });
  });
 }
 function base(seed:number){const s=createSeason('s14_lich',new Random(seed).next);s.board=[];s.hand=[];s.shop=[];s.discovery=[];s.rewards=[];s.logs=[];s.season!.powers=[];s.season!.pendingDiscoveries=[];s.season!.pendingTrinketCards=[];s.turn=1+seed%18;s.tier=1+seed%6;return s;}
 const random=new Random(83924);
 const card=(id:string,golden=false)=>{const m=makeMinion(id,golden,true);m.uid=`fixture-${Math.floor(random.next()*1e12)}`;return m};
 for(let i=0;i<600;i++){
  const s=base(i);s.season!.tribes=['元素','海盗','畸变怪','机械','亡灵'];
  s.season!.buffs={undead:{attack:i%5,health:i%4},beast:{attack:i%7,health:i%2}};
  const kinds=['minion','spell','chooseCard','minion','copy','cookie'];const kind=kinds[i%6];
  const opts:any={};if(i%4===0)opts.tiers=[1+i%7];if(i%5===0)opts.tribe=['元素','机械','野兽'][i%3];if(i%7===0)opts.magnetic=true;if(i%11===0)opts.typed=true;if(i%13===0)opts.mechanic='BATTLECRY';
  if(kind==='copy'||kind==='cookie'){opts.options=[SEASON_CARDS[i%SEASON_CARDS.length].id,SEASON_CARDS[(i+1)%SEASON_CARDS.length].id];opts.golden=i%2===0;opts.both=i%4===0;}
  if(i%9===0)opts.darkGift=true;
  if(i%10===0)for(const id in s.pool)s.pool[id]=0;
  check(`recruit-discovery:${i}`,s,[{op:'queueDiscovery',kind:'minion',options:{tiers:[99]}},{op:'queueDiscovery',kind,options:opts},{op:'nextDiscovery'},{op:'nextDiscovery'}],i,i%2===0);
  check(`recruit-spell:${i}`,s,[{op:'drawSpell',...(i%3?{}:{cost:i%6})},{op:'drawSpell'}],i,false);
 }
 for(let i=0;i<300;i++){
  const s=base(i);const id=SEASON_CARDS[i%SEASON_CARDS.length].id;
  s.season!.powers=i%4===0?['s14_clockwork']:[];
  s.season!.trinkets=i%3===0?['BG30_MagicItem_439','BG35_MagicItem_713']:[];
  s.season!.deity={id:'test',attack:1,health:2,golden:false};
  s.board=[card('s14_BG36_109',i%2===0),card('s14_BG34_Giant_327'),card(id)];
  s.board[0].counters={awakenedDeity:1};
  s.hand=[card(id),card(id),card(id),card(id),card(id)];s.hand.forEach((m,j)=>{m.attack+=j;m.health+=j*2;if(j===2){m.gift='BG36_MidGameEffect_000t22';m.giftTurn=3;}});
  if(i%5===0)s.rewards=[1,2,3,4,5,6];
  s.season!.pendingTrinketCards=[card(id),card('s14_BG25_001')];
  check(`recruit-triples:${i}`,s,[{op:'triples'},{op:'flushTrinketCards'},{op:'triples'},{op:'reward'},{op:'releasePlayerCards'}],i);
  const m=card(id);
  check(`recruit-hand:${i}`,s,[{op:'putHand',minion:m,markEntered:i%2===0},{op:'trinketCard',minion:card(id)},{op:'deityGain',attack:3,health:7},{op:'reward',tier:7}],i,false);
 }
 const wildcard=SEASON_CARDS.find(d=>d.abilities?.some(a=>a.op==='elementalWildcard'))!;
 const elemental=SEASON_CARDS.find(d=>d.races?.includes('元素')&&d.id!==wildcard.id)!;
 for(let i=0;i<20;i++){
  const s=base(i);s.board=[card(elemental.id)];s.hand=[card(wildcard.id),card(elemental.id)];s.season!.powers=i%2?[]:['s14_clockwork'];
  check(`recruit-wildcard:${i}`,s,[{op:'triples'},{op:'reward'}],i);
 }
 for(let i=0;i<100;i++){
  const s=base(i);s.gold=i%23;s.season!.maxGold=10+i%5;s.season!.temporaryGoldCap=i%2?30:0;
  s.season!.trinkets=i%2?['BG35_MagicItem_812']:[];
  s.hand=Array.from({length:i%11},()=>card('s14_BG25_001'));
  s.season!.pendingDiscoveries=[{kind:'minion',creationPart:card('s14_BG25_001')}];s.season!.activeDiscovery={kind:'minion',creationPart:card('s14_BG25_001')};
  check(`recruit-economy:${i}`,s,[{op:'trinketGold',amount:i%7},{op:'gold',amount:4},{op:'gold',amount:-3},{op:'reward'},{op:'releasePlayerCards'}],i);
  check(`recruit-copy:${i}`,s,[{op:'copyDiscovery',ids:[SEASON_SPELLS[0].id,SEASON_SPELLS[1].id,SEASON_SPELLS[0].id,SEASON_SPELLS[3].id]},{op:'nextDiscovery'}],i);
 }
 for(let i=0;i<200;i++){
  const s=base(i);s.board=[card(SEASON_CARDS[i%SEASON_CARDS.length].id)];if(i%5===0)for(const id in s.pool)s.pool[id]=0;
  check(`recruit-dark:${i}`,s,[{op:'darkDiscover'}],i);
 }
 const gainIds=[...SEASON_CARDS.filter(d=>d.abilities?.some(a=>['handEchoStats','healthOnAttackGain','elementalGrantAura','globalStats'].includes(a.op))).map(d=>d.id),'s14_BG34_500','s14_BG31_035','s14_TB_BaconShop_HP_033t','s14_TB_BaconShop_HERO_33_Buddy'];
 for(let i=0;i<300;i++){
  const s=base(i);s.board=Array.from({length:7},(_,j)=>card(gainIds[(i+j)%gainIds.length],i%2===0));s.hand=[card(SEASON_CARDS[i%SEASON_CARDS.length].id),card(gainIds[i%gainIds.length]),card(SEASON_SPELLS[0].id)];
  s.shop=[card(SEASON_CARDS[(i+2)%SEASON_CARDS.length].id)];s.season!.trinkets=['BG36_MagicItem_380','BG35_MagicItem_156','BG35_MagicItem_924'];s.season!.powers=['s14_saurfang'];
  s.season!.counters={trinketElementals:i%13,'power:saurfang:boughtMinions':i%12};s.season!.buffs={elementalGrant:{attack:i%4,health:i%3},shop:{attack:1,health:2},lowShop:{attack:2,health:1},'shopType:元素':{attack:3,health:4}};
  s.season!.deity={id:'test',attack:2,health:3,golden:false};s.board[0].counters={deityMirrorTurn:s.turn,deityMirrorCopies:2,awakenedDeity:1};
  check(`recruit-gain:${i}`,s,[{op:'gain',uid:s.board[0].uid,attack:i%7-2,health:i%5,source:s.board[i%7]},{op:'applyShop',minion:s.shop[0]},{op:'scale',key:['undead','beast','beastCombat','shop','elementalShop','lowShop'][i%6],attack:2,health:3}],i);
 }
 const effects=['buff','gem','deathStats','setStats','doubleAttack','scale','gold','goldNext','goldCap','freeRefresh','discountSpell','fodder','armor','spell','generate','randomSpell','draw','drawType','drawId','discoverMinion','discoverSpell','handStats','golden','steal','stealHighest','rally','damageAll'];
 for(let i=0;i<1350;i++){
  const s=base(i);s.season!.powers=['s14_rakanishu'];s.season!.trinkets=['BG36_MagicItem_373','BG36_MagicItem_371','BG32_MagicItem_801t','BG30_MagicItem_943'];s.season!.buffs={spell:{attack:2,health:3},gem:{attack:3,health:2}};
  s.board=Array.from({length:4},(_,j)=>card('s14_BG25_001',j%2===0));s.shop=[card('s14_BG_BOT_911'),card('s14_BG_DEEP_015')];s.hand=[card(SEASON_SPELLS[i%SEASON_SPELLS.length].id),card('s14_BG25_001'),card('s14_BG_BOT_911')];
  s.board[0].extraAbilities=[{event:'gemPlayed',op:'buff',target:'self',attack:2,health:3}];
  const m=card(i%2?SEASON_SPELLS[i%SEASON_SPELLS.length].id:'s14_BG25_001',i%3===0);m.tempSpell=i%5===0;
  const op=effects[i%effects.length];const targets=['self','selected','all','others','boardAndHand','shop','handLeft','randomHand','adjacent','golden','shielded','left','random','randomFour','menagerie','event'];
  const a:any={event:i%2?'cast':'battlecry',op,target:targets[Math.floor(i/effects.length)%targets.length],attack:i%7-1,health:i%5,amount:1+i%2,id:'BG25_001',key:op==='scale'?'gem':undefined};
  if(op==='spell'||op==='generate')a.id='BG20_GEM';
  if(i%4===0)a.keyword='圣盾';if(i%6===0)a.toggle=true;if(i%7===0)a.noScale=true;
  if(op==='buff'&&i%9===0)a.key='nagaWindfury';
  if(op==='discoverMinion'&&i%2)a.key='currentTier';
  s.board.unshift(m);if(op==='rally')s.board[1].extraAbilities=[];
  check(`recruit-effect:${i}`,s,[{op:'effect',uid:m.uid,ability:a,target:s.board[1].uid,eventMinion:s.board[2].uid,fromHand:i%2===0,permanentSpell:i%3===0,...(i%4===0?{trinket:true}:{})}],i);
 }
 for(let i=0;i<3;i++){
  const s=base(i);s.board=[card('s14_BG25_001')];
  check(`recruit-missing-definition:${i}`,s,[{op:'queueDiscovery',kind:'copy',options:{options:['nonexistent','s14_BG25_001']}},{op:'nextDiscovery'},{op:'effect',uid:s.board[0].uid,ability:{event:'battlecry',op:'generate',id:'missing'}}],i);
 }
 const extraEffects=['majorityDraw','majorityDiscover','buffType','roogug','rewind','baller','lobster','craft','craftScale','battlecry'];
 for(let i=0;i<400;i++){
  const s=base(i);s.board=Array.from({length:4},()=>card('s14_BG25_001'));s.hand=[card('s14_BG_BOT_911')];s.shop=[card('s14_BG_DEEP_015')];
  const op=extraEffects[i%extraEffects.length];const sourceDef=(op==='craft'||op==='craftScale')?SEASON_CARDS.find(d=>d.abilities?.some(a=>a.op===op)):undefined;
  const m=card(sourceDef?.id||'s14_BG25_001',i%3===0);m.extraTribes=['野兽','元素'];s.board.unshift(m);
  if(op==='battlecry')m.extraAbilities=[{event:'battlecry',op:'buff',target:'self',attack:2,health:3}];
  s.season!.trinkets=i%2?['BG30_MagicItem_868']:[];
  const ability=sourceDef?.abilities?.find(a=>a.op===op)||{event:'battlecry',op,target:i%2?'shop':'self',attack:2,health:3};
  check(`recruit-extra-effect:${i}`,s,[{op:'effect',uid:m.uid,ability,target:s.board[1].uid}],i);
 }
 const brann=SEASON_CARDS.find(d=>d.abilities?.some(a=>a.op==='brann'))!;
 for(let i=0;i<150;i++){
  const s=base(i);const m=card('s14_BG25_001',i%2===0);m.extraTribes=['龙'];m.extraAbilities=[{event:'battlecry',op:'buff',target:'selected',attack:1,health:2},{event:'battlecry',op:'gold',amount:1}];
  s.board=[m,card(brann.id,i%3===0),card('s14_BG_BOT_911')];s.board[2].extraAbilities=[{event:'battlecryTriggered',op:'buff',target:'event',attack:2,health:1}];
  s.season!.trinkets=['BG36_MagicItem_215','BG32_MagicItem_416','BG36_MagicItem_203'];
  check(`recruit-battlecry:${i}`,s,[{op:'triggerBattlecry',uid:m.uid,...(i%2?{target:s.board[2].uid}:{})},{op:'triggerBattlecry',uid:m.uid}],i);
 }
 for(let i=0;i<20;i++){
  const s=base(i);s.turn=10+i%6;
  check(`recruit-gift-seven:${i}`,s,[{op:'queueDiscovery',kind:'minion',options:{tiers:[7],darkGift:true}},{op:'nextDiscovery'}],i);
 }
}
