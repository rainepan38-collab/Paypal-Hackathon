import test from 'node:test';
import assert from 'node:assert/strict';
import { validateParticipants } from '../src/participants.js';
import { parseDemoExpense } from '../src/parser.js';
import { equalSplit } from '../src/split.js';
const members=['Jimmy','Alex','Sarah'].map(name=>({id:`user-${name.toLowerCase()}`,username:name.toLowerCase(),display_name:name}));
for(const [organizer,total,names,expected] of [[members[0],96,['Alex','Sarah'],[3200,3200,3200]],[members[1],32,['Jimmy','Sarah'],[1067,1067,1066]],[members[2],60,['Jimmy','Alex'],[2000,2000,2000]]]){
  test(`local parser supports ${organizer.display_name} as organizer`,()=>{
    const parsed=parseDemoExpense(`@SplitMate I paid $${total} for dinner with ${names.join(' and ')}. Split equally.`,{organizer,members});
    assert.deepEqual(parsed.owedNames,names);
    assert.deepEqual(equalSplit(parsed.totalCents,[organizer.display_name,...parsed.owedNames]).map(s=>s.amountCents),expected);
  });
}
test('legacy mapping is contextual and aliases cannot duplicate a participant',()=>{
  assert.equal(validateParticipants(['You'],{organizer:members[1],members})[0].id,'user-jimmy');
  assert.throws(()=>validateParticipants(['You'],{organizer:members[0],members}),/clarify/);
  assert.throws(()=>validateParticipants(['You']),/clarify/);
  assert.throws(()=>validateParticipants(['You'],{organizer:members[1],members:members.slice(1)}),/clarify/);
  assert.throws(()=>validateParticipants(['You','Jimmy'],{organizer:members[1],members}),/named once/);
});
