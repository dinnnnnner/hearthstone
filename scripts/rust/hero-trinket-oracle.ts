import { makeMinion, type Game } from '../../src/engine';
import { createSeason, seasonPowerState, nativeOracleHooks as hooks } from '../../src/season/engine';
import { SEASON_HEROES } from '../../src/season/catalog';
import { TRINKETS } from '../../src/season/engine';
import { returningTrinkets } from '../../src/season/trinkets';
import { Random } from '../../rl/environment';
import { withSimulation } from '../../src/simulation';
type Add=(name:string,request:Record<string,unknown>,evaluate:()=>unknown)=>void;
export function addHeroTrinketCases(add:Add){
 function check(name:string,state:Game,operations:any[],seed:number){
  add(name,{command:'recruitBatch',state,operations,seed,uidCounter:17,recordLogs:true},()=>{
   const s=structuredClone(state),rng=new Random(seed);let draws=0,serial=17;const next=()=>{draws++;return rng.next()};const results:any[]=[];
   return withSimulation({uid:()=>`native-${++serial}`,recordLogs:true,recordFrames:false},()=>{
    for(const operation of operations){const op=structuredClone(operation);let result:any=null;
     const all=[...s.board,...s.hand,...s.shop,...s.discovery,...s.season!.spellShop];
     const ctx={s,board:s.board,rng:next,target:all.find(m=>m.uid===op.target),eventMinion:all.find(m=>m.uid===op.eventMinion),amount:op.amount};
     switch(op.op){
      case 'heroStart':hooks.heroStart(ctx);break;
      case 'heroEnd':hooks.heroEnd(ctx);break;
      case 'heroAction':result=hooks.expandedHeroAction(ctx,op.key,ctx.target)||null;break;
      case 'offerPowers':hooks.offerPowers(s,op.mode,next,op.selected||[]);break;
      case 'startPowerEffects':hooks.startPowerEffects(s,next);break;
      case 'heroWheel':hooks.heroWheel(ctx);break;
      case 'trinketStart':hooks.trinketStart(ctx,op.id,op.purchased,op.slot);break;
      case 'settleTrinkets':hooks.settleTrinkets(s,next);break;
      case 'trinketEvent':hooks.legacyTrinketEvent(ctx,op.event,op.slot);break;
      default:throw Error(`Unsupported hero test operation ${op.op}`);
     }results.push(structuredClone(result));
    }
    return {state:s,rng:rng.state,draws,uidCounter:serial,results};
   });
  });
 }
 let cardSerial=0;
 const card=(id:string,golden=false)=>{const m=makeMinion(id,golden);m.uid=`hero-fixture-${++cardSerial}`;return m;};
 function base(seed:number){const s=createSeason('s14_lich',new Random(seed).next);s.board=[];s.hand=[];s.shop=[];s.discovery=[];s.rewards=[];s.logs=[];s.season!.powers=[];s.season!.trinkets=[];s.season!.spellShop=[];s.season!.pendingDiscoveries=[];s.season!.pendingTrinketCards=[];s.turn=1+seed%18;s.tier=1+seed%6;s.gold=seed%21;s.season!.tribes=['野兽','恶魔','鱼人','机械','龙','海盗','元素','野猪人','纳迦','亡灵','畸变怪'] as any;
  s.board=[card('s14_BG25_001'),card('s14_BG_BOT_911'),card('s14_BG_DEEP_015')];s.shop=[card('s14_BG25_001'),card('s14_BG_BOT_911')];s.hand=[card('s14_BG25_001')];return s;
 }
 for(let i=0;i<SEASON_HEROES.length;i++)for(let n=0;n<8;n++){
  const s=base(i*8+n);const h=SEASON_HEROES[i];s.season!.powers=[h.id];
  s.season!.counters={'power:ragnaros:boughtCards':12,'power:edwin:boughtCards':n*4,cthunTurn:n%2?s.turn:0,cookieCount:n,eudoraDigs:n};
  s.season!.lastDead=n%2?['s14_BG25_001','s14_BG_BOT_911']:[];s.season!.lastEnemy=n%2?structuredClone(s.board):[];
  if(n%2)s.season!.lastSpell='s14_BG28_810';
  if(n%3===0)s.opponents[s.nextOpponent].board=structuredClone(s.board);
  check(`hero-start-end:${h.id}:${n}`,s,[{op:'heroStart'},{op:'heroEnd'}],i*8+n);
  check(`hero-action:${h.id}:${n}`,s,[{op:'heroAction',key:h.id.replace('s14_',''),target:n%3===0?undefined:seasonPowerState(s,h.id).targets[n%seasonPowerState(s,h.id).targets.length]?.uid}],i*8+n);
 }
 for(let i=0;i<150;i++){const s=base(i);check(`hero-offers:${i}`,s,[{op:'offerPowers',mode:['nguyen','genn','finley','replace','additional'][i%5],selected:i%2?['s14_saurfang']:[]}],i);check(`hero-wheel:${i}`,s,[{op:'heroWheel'}],i);}
 for(let i=0;i<TRINKETS.length;i++)for(let n=0;n<4;n++){
  const item=TRINKETS[i],s=base(i*4+n);s.season!.trinkets=[item.id];
  if(n===1){s.board=[];s.shop=[];s.hand=[];}
  if(n===2){s.hand.push(card('s14_BG36_520t'));s.hand.at(-1)!.lockedUntil=s.turn+2;s.season!.deity={id:'fixture',attack:2,health:3,golden:false};}
  if(n===3){s.hand=Array.from({length:10},()=>card('s14_BG25_001'));s.season!.trinketData={[`trinket:0:${item.id}`]:{turn:s.turn-2,type:'亡灵'}};}
  check(`trinket-start:${item.id}:${n}`,s,[{op:'trinketStart',id:item.id,purchased:n!==3,slot:0}],i*4+n);
  for(const event of new Set((returningTrinkets[item.id]||[]).filter(r=>!r.combatOnly && !['combat','empty','death','attack','attackBeast','afterAttack','rally','shieldLost'].includes(r.event)).map(r=>r.event))){
   const states=[s,structuredClone(s)];states[1].season!.counters={};for(let step=0;step<2;step++){
    check(`trinket-event:${item.id}:${event}:${n}:${step}`,states[step],[{op:'trinketEvent',event,eventMinion:s.board[0]?.uid,amount:100}],i*4+n+step);
   }
  }
 }
 for(let i=0;i<20;i++){const s=base(i);s.season!.pendingTrinketChoices=[{slot:0,school:i%2?'GREATER_TRINKET':'LESSER_TRINKET',free:i%3===0}];if(i%4===0)s.season!.kiriSlot=0;check(`trinket-settlement:${i}`,s,[{op:'settleTrinkets'}],i);}
}
