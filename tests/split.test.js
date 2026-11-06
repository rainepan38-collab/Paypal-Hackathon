import test from 'node:test';
import assert from 'node:assert/strict';
import { dollarsToCents, equalSplit, usd } from '../src/split.js';
test('USD conversion safely uses integer cents', () => {
  assert.equal(dollarsToCents('96.00'), 9600);
  assert.equal(dollarsToCents('0.01'), 1);
  assert.throws(() => dollarsToCents('3.14159'));
});
test('equal split preserves total and allocates remainder deterministically', () => {
  assert.deepEqual(equalSplit(10000, ['You', 'Alex', 'Sarah']), [
    { name: 'You', amountCents: 3334 },
    { name: 'Alex', amountCents: 3333 },
    { name: 'Sarah', amountCents: 3333 }
  ]);
  assert.equal(usd(3334), '$33.34');
});
test('reject impossible split', () => assert.throws(() => equalSplit(1, ['You','A'])));
