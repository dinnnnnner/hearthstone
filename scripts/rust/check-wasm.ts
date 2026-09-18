import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { loadServerRustRules } from '../../server/rust-rules';
const wasm='public/rules/tavern_rules.wasm';
const kernel=loadServerRustRules(wasm);
const cases=readFileSync('native/target/parity/cases.jsonl','utf8').trim().split('\n').map(l=>JSON.parse(l));
const summarize=(runtime:string)=>({runtime,cases:cases.length,mismatches:0,fullEngineGate:'rejected'});
for(const c of cases){
  try{const result=kernel.call(c.request);assert.ok(!c.error,c.name);assert.deepEqual(result,c.expected,c.name);}
  catch(e){if(!c.error||!(e instanceof Error)||e.message!==c.error)throw e;}
}
assert.throws(()=>kernel.requireFullEngine(),/完整规则尚未/);
console.log(JSON.stringify(summarize('node-wasm')));
await build({entryPoints:['src/rules/rust-browser.ts'],outfile:'native/target/browser-kernel.js',bundle:true,format:'esm',platform:'browser',define:{'import.meta.env.BASE_URL':'"/"'}});
const server=createServer((req,res)=>{
  const file=req.url==='/kernel.js'?'native/target/browser-kernel.js':req.url==='/rules/tavern_rules.wasm'?wasm:undefined;
  if(file){res.setHeader('Content-Type',file.endsWith('.wasm')?'application/wasm':'text/javascript');res.end(readFileSync(file));}
  else if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Rust parity</title>');}
  else{res.writeHead(404);res.end();}
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage();
 await page.goto(`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/`);
 await page.evaluate(async()=>{
  const mod=await import(/* @vite-ignore */ '/kernel.js');
  (window as any).kernel=await mod.loadRustRules();
 });
 for(let i=0;i<cases.length;i+=100){
  const results=await page.evaluate(batch=>batch.map(c=>{try{return {result:(window as any).kernel.call(c.request)}}catch(e){return {error:(e as Error).message}}}),cases.slice(i,i+100));
  results.forEach((r:any,j:number)=>{const c=cases[i+j];assert.deepEqual(r,c.error?{error:c.error}:{result:c.expected},c.name);});
 }
 const rejected=await page.evaluate(()=>{try{(window as any).kernel.requireFullEngine();return false}catch{return true}});
 assert.equal(rejected,true);
 console.log(JSON.stringify(summarize('browser-wasm')));
 writeFileSync('native/target/parity/wasm-report.json',JSON.stringify({node:summarize('node-wasm'),browser:summarize('browser-wasm'),meta:kernel.meta},null,2)+'\n');
}finally{await browser.close();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
