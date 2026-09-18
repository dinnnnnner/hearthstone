import { writeFileSync,mkdirSync } from 'node:fs';
import { createSeason,actSeason } from '../../src/season/engine';
import { makeMinion } from '../../src/engine';
import { SEASON_CARDS,SEASON_HEROES } from '../../src/season/catalog';
import { observe } from '../../rl/observation';
import { observeEntities,ENTITY_SCHEMA } from '../../rl/entities';
import { candidates,ACTIONS } from '../../rl/actions';
import { Random } from '../../rl/environment';
const cases:any[]=[];
const add=(name:string,command:string,state:any,expected:any,extra={})=>cases.push({name,request:{command,state,...extra},expected});
for(let seed=0;seed<180;seed++){
 const rng=new Random(seed);let s=createSeason(SEASON_HEROES[seed%SEASON_HEROES.length].id,rng.next);
 s.seatIndex=seed%8;s.board=[];s.hand=[];
 for(let i=0;i<Math.min(seed%8,7);i++)s.board.push(makeMinion(SEASON_CARDS[Math.floor(rng.next()*SEASON_CARDS.length)].id));
 for(let i=0;i<seed%5;i++)s.hand.push(makeMinion(SEASON_CARDS[Math.floor(rng.next()*SEASON_CARDS.length)].id));
 if(seed%2)s.aiActionUsage={turn:s.turn,freezes:0,moves:seed%6};
 if(seed%3===0){s.turn=9;s.scouting=[{turn:8,warband:'3亡灵',battle:{opponent:s.opponents[0].name,result:'win',damage:5}},{turn:7,warband:'混合'}]}
 s.season!.counters??={};s.season!.counters.test=seed;s.season!.counters['汉字😀']=seed*2;
 add(`observe-${seed}`,'observe',s,observe(s,seed%10,64),{steps:seed%10,limit:64});
 add(`entities-${seed}`,'observeEntities',s,observeEntities(s,seed%10,64),{steps:seed%10,limit:64});
 add(`candidates-${seed}`,'actionCandidates',s,[...candidates(s)]);
}
cases.push({name:'actions',request:{command:'actionSchema'},expected:ACTIONS},{name:'entity-schema',request:{command:'entitySchema'},expected:ENTITY_SCHEMA});
mkdirSync('native/target/parity',{recursive:true});writeFileSync('native/target/parity/observation.jsonl',cases.map(c=>JSON.stringify(c)).join('\n')+'\n');
console.log('observation fixtures '+cases.length);
