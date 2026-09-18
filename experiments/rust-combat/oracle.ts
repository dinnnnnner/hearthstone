/** Differential oracle calls the production TS engine, never a second TS port. */
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createSeason, seasonCombat } from '../../src/season/engine';
import { makeMinion, type Game, type Minion } from '../../src/engine';
import { getDef, type Keyword } from '../../src/data';
import { withSimulation } from '../../src/simulation';

type Unit = { uid: number; card: string; attack: number; health: number; golden: boolean; keywords: Keyword[] };
type Case = { name: string; seed: number; turn: number; living: number; tiers: [number, number]; boards: [Unit[], Unit[]] };
const cards = ['s14_BG25_001','s14_BG_BOT_911','s14_BG_DEEP_015','s14_BGS_034','s14_BGS_119','s14_BGS_131'];
const keywords: Keyword[] = ['嘲讽','圣盾','复生','剧毒','风怒','烈毒','潜行'];
class Random {
  state: number; draws = 0;
  constructor(seed: number) { this.state = seed >>> 0; }
  next = () => {
    this.state = (this.state + 0x6d2b79f5) >>> 0; this.draws++;
    let t = Math.imul(this.state ^ this.state >>> 15, this.state | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function unit(uid: number, attack = 2, health = 3, ks: Keyword[] = [], card = cards[0], golden = false): Unit {
  return { uid, card, attack, health, keywords: ks, golden };
}
function fixtures(count: number): Case[] {
  const cases: Case[] = [];
  const add = (name: string, a: Unit[], b: Unit[], seed = 1, turn = 1, living = 8) =>
    cases.push({ name, seed, turn, living, tiers: [6,6], boards: [a,b] });
  add('empty', [], []);
  add('empty-defender', [unit(1)], []);
  add('empty-attacker', [], [unit(2)]);
  add('zero-attack-stalemate', [unit(1,0)], [unit(2,0)]);
  add('simultaneous-death', [unit(1,3,3)], [unit(2,3,3)]);
  add('zero-damage-preserves-shield', [unit(1,0,3,['圣盾'])], [unit(2,1,8,['圣盾'])]);
  add('taunt-and-stealth', [unit(1,4,9,['风怒'])], [unit(2,2,4,['嘲讽','潜行']),unit(3,1,4,['嘲讽']),unit(4,1,4)]);
  add('all-stealthed', [unit(1,4,9)], [unit(2,2,4,['潜行']),unit(3,1,4,['嘲讽','潜行'])]);
  add('shield-blocks-venom', [unit(1,1,9,['烈毒','风怒'])], [unit(2,1,5,['圣盾']),unit(3,1,5)]);
  add('permanent-poison', [unit(1,1,9,['剧毒','风怒'])], [unit(2,1,99),unit(3,1,99)]);
  add('mutual-reborn', [unit(1,3,3,['复生'])], [unit(2,3,3,['复生'])]);
  add('golden-reborn-resets-buffs', [unit(1,50,1,['复生'],cards[3],true)], [unit(2,1,100)]);
  add('windfury-attacker-dies', [unit(1,4,1,['风怒','复生'],cards[4])], [unit(2,4,7),unit(3,1,3)]);
  add('dead-attacker-index', [unit(1,1,1),unit(2,4,4),unit(3,6,8)], [unit(4,2,3),unit(5,4,8)]);
  add('180-step-guard', [unit(1,1,1000000000)], [unit(2,1,1000000000)]);
  for (const turn of [1,3,4,7,8,20]) for (const living of [4,5,8]) {
    add(`damage-cap-${turn}-${living}`, Array.from({length:7},(_,i)=>unit(i+1,5,5,[],cards[1])), [], 0, turn, living);
  }
  const r = new Random(123456789), choose = <T>(a: T[]): T => a[Math.floor(r.next()*a.length)];
  for (let i = 0; i < count; i++) {
    let uid = 0;
    const boards = [0,1].map(() => Array.from({length:Math.floor(r.next()*8)}, () =>
      unit(++uid, Math.floor(r.next()*40), 1+Math.floor(r.next()*60), keywords.filter(()=>r.next()<.22), choose(cards), r.next()<.3))) as Case['boards'];
    cases.push({ name:`random-${i}`, seed:Math.floor(r.next()*4294967296), turn:1+Math.floor(r.next()*20), living:1+Math.floor(r.next()*8), tiers:[1+Math.floor(r.next()*6),1+Math.floor(r.next()*6)], boards });
  }
  return cases;
}
const template = createSeason('s14_lich', () => .37);
template.shop=[]; template.hand=[]; template.pool={}; template.season!.initialPool={};
template.season!.powers=[]; template.season!.trinkets=[]; template.season!.buffs={};
template.season!.counters={}; template.season!.combatEffects={}; delete template.season!.deity;
function games(c: Case): [Game, Game] {
  return c.boards.map((b, side) => {
    const s = structuredClone(template);
    s.turn=c.turn; s.tier=c.tiers[side]; s.opponents=s.opponents.slice(0,c.living-1);
    s.board=b.map(m=>{
      if (!cards.includes(m.card)) throw Error(`Unsupported oracle card ${m.card}`);
      if (getDef(m.card).abilities?.length) throw Error(`Card acquired an unsupported ability: ${m.card}`);
      const card=makeMinion(m.card,m.golden); return {...card,uid:`m${m.uid}`,attack:m.attack,health:m.health,keywords:[...m.keywords]};
    });
    return s;
  }) as [Game,Game];
}
function normalize(m: Minion): Unit {
  return {uid:Number(m.uid.slice(1)),card:m.id,attack:m.attack,health:m.health,golden:m.golden,keywords:keywords.filter(k=>m.keywords.includes(k))};
}
function run(c: Case, pair: [Game,Game], trace: boolean) {
  const r = new Random(c.seed); let uid=Math.max(0,...c.boards.flat().map(m=>m.uid))+1;
  const battle=withSimulation({uid:()=>`m${uid++}`,recordFrames:trace,recordLogs:false},()=>seasonCombat(pair[0],pair[1].board,pair[1].tier,r.next,pair[1]));
  if (!trace) return {damage:battle.damage,result:battle.result,rng_draws:r.draws};
  const boards=(f: typeof battle.frames[number])=>[f.allies.map(normalize),f.enemies.map(normalize)];
  return { result:battle.result,damage:battle.damage,boards:boards(battle.frames.at(-1)!),rng_state:r.state,rng_draws:r.draws,
    trace:battle.frames.flatMap((f,i)=>f.attacker ? [{attacker:Number(f.attacker.slice(1)),target:Number(f.target!.slice(1)),before_deaths:boards(f),after_deaths:boards(battle.frames[i+1])}] : []) };
}
const [command, file, amount] = process.argv.slice(2);
if(command==='fixtures') {
  const cases=fixtures(Number(amount || 2000)); writeFileSync(file,JSON.stringify({cases}));
  console.log(JSON.stringify({cases:cases.length}));
} else {
  const {cases} = JSON.parse(readFileSync(file,'utf8')) as {cases:Case[]};
  const pairs=cases.map(games);
  if(command==='validate') console.log(JSON.stringify({ok:true,results:cases.map((c,i)=>run(c,pairs[i],true))}));
  else if(command==='bench') {
    const repetitions=Number(amount || 20);
    for(let warmup=0;warmup<5;warmup++) cases.forEach((c,i)=>run(c,pairs[i],false));
    let checksum=0; const start=performance.now();
    for(let rep=0;rep<repetitions;rep++) cases.forEach((c,i)=>{
      const r=run(c,pairs[i],false); checksum+=r.damage+r.rng_draws+(r.result==='win'?1:r.result==='loss'?2:0);
    });
    const seconds=(performance.now()-start)/1000;
    const peak_rss_mib=Number(readFileSync('/proc/self/status','utf8').match(/^VmHWM:\s+(\d+)/m)![1])/1024;
    console.log(JSON.stringify({ok:true,combats:cases.length*repetitions,seconds,checksum,peak_rss_mib}));
  } else throw Error('Expected fixtures, validate or bench');
}
