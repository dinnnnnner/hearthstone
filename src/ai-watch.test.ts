import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choiceProbability, formatProbability, type PolicyDecision } from './ai-watch';
test('card probability sums mutually exclusive targets and placements, never different cards or operations',()=>{
 const d:PolicyDecision={id:'1',turn:1,mode:'search',choices:[
  {action:{type:'play',uid:'a',position:0},probability:.1,selected:false},
  {action:{type:'play',uid:'a',position:1},probability:.2,selected:true},
  {action:{type:'sell',uid:'a'},probability:.3,selected:false},
  {action:{type:'play',uid:'b'},probability:.4,selected:false},
 ]};
 const value=choiceProbability(d,'play','a')!;assert.ok(Math.abs(value.probability-.3)<1e-10);assert.equal(value.selected,true);
 assert.equal(choiceProbability(d,'sell','a')!.probability,.3);assert.equal(choiceProbability(d,'upgrade')!.legal,false);
 assert.equal(choiceProbability(undefined,'upgrade'),undefined);
});
test('small positive probabilities are visible instead of rounded to impossible zero',()=>{
 assert.equal(formatProbability(.00001),'<0.1%');assert.equal(formatProbability(0),'0.0%');assert.equal(formatProbability(.123),'12.3%');
});
