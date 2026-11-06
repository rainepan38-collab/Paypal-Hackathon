import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDemoExpense } from '../src/parser.js';

test('parse group dinner from example',()=>{
  const result=parseDemoExpense('@SplitMate I paid $96 for dinner with Alex and Sarah. Split equally.');
  assert.equal(result.totalCents,9600);
  assert.equal(result.description,'dinner');
  assert.deepEqual(result.owedNames,['Alex','Sarah']);
});
test('parse comma-separated names',()=>{
  const result=parseDemoExpense('@SplitMate paid $60 for groceries with Alex, Sarah and Jo.');
  assert.deepEqual(result.owedNames,['Alex','Sarah','Jo']);
});
test('reject missing amount',()=>{
  assert.throws(()=>parseDemoExpense('I paid for dinner with Alex and Sarah.'),/Include a total/);
});
test('reject duplicate names',()=>{
  assert.throws(()=>parseDemoExpense('I paid $50 with Alex and Alex.'),/different people/);
});
