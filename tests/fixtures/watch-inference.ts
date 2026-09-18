/** Deterministic inference fixture for local spectator browser tests only. */
import { createServer } from 'node:http';
import { ACTIONS } from '../../rl/actions';
createServer(async (req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 try {
  const data=JSON.parse(raw);
  const rows=data.rows.map((row:{legal:number[];memory:number[]})=>{
   const priorities=['choosePower','discover','buyTrinket','play','cast','buy','upgrade','end'];
   const action=priorities.map(type=>row.legal.find(id=>ACTIONS[id].type===type)).find(id=>id!==undefined)??row.legal[0];
   return {action,memory:row.memory.map(n=>n+.01),...(data.probabilities?{selectionMode:'sample',probabilities:row.legal.map(id=>[id,row.legal.length === 1 ? 1 : id === action ? .6 : .4 / (row.legal.length - 1)])}:{})};
  });
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({rows}));
 } catch {res.writeHead(400);res.end('{}');}
}).listen(Number(process.env.WATCH_TEST_INFERENCE_PORT||8796),'127.0.0.1');
