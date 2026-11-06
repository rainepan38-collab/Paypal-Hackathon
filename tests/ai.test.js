import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExpense } from '../src/ai.js';
import { extractExpense } from '../src/parser.js';

const expense = {
  intent: 'create_expense', description: 'dinner', total_amount: '96.00',
  currency: 'USD', owed_people: ['Alex', 'Sarah'], notes: ''
};

function setup(t, result = expense) {
  const saved = { ...process.env };
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  delete process.env.GEMINI_MODEL;
  t.after(() => { process.env = saved; });
  return t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ text: typeof result === 'string' ? result : JSON.stringify(result) }] }, finishReason: 'STOP' }]
  }), { headers: { 'Content-Type': 'application/json' } }));
}

test('Gemini SDK sends structured extraction request and returns integer cents', async t => {
  const fetch = setup(t);
  const result = await extractExpense('@SplitMate I covered dinner, $96 total; Alex and Sarah owe equal shares.');
  assert.deepEqual(result, { description: 'dinner', totalCents: 9600, owedNames: ['Alex', 'Sarah'] });
  const [url, options] = fetch.mock.calls[0].arguments;
  assert.match(String(url), /gemini-2\.5-flash:generateContent/);
  const body = JSON.parse(options.body);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.generationConfig.responseJsonSchema.type, 'object');
  assert.match(body.systemInstruction.parts[0].text, /ORGANIZER/);
  assert.doesNotMatch(body.contents[0].parts[0].text, /@SplitMate/);
});

test('Gemini model override and input length limit are honored', async t => {
  const fetch = setup(t);
  process.env.GEMINI_MODEL = 'custom-model';
  await parseExpense('x'.repeat(2000));
  const [url, options] = fetch.mock.calls[0].arguments;
  assert.match(String(url), /custom-model:generateContent/);
  assert.equal(JSON.parse(options.body).contents[0].parts[0].text.length, 1500);
});

for (const [label, result, expected] of [
  ['clarification', { ...expense, intent: 'other', notes: 'Please specify an equal split.' }, /specify an equal split/],
  ['non-USD currency', { ...expense, currency: 'EUR' }, /USD only/],
  ['duplicate names', { ...expense, owed_people: ['Alex', 'alex'] }, /named once/],
  ['organizer pronoun', { ...expense, owed_people: ['me'] }, /yourself/],
  ['missing names', { ...expense, owed_people: null }, /invalid expense data/],
  ['invalid amount', { ...expense, total_amount: '96.001' }, /valid USD amount/],
  ['invalid JSON', 'not JSON', /invalid expense data/],
  ['empty response', '', /no extractable response/]
]) {
  test(`Gemini rejects ${label}`, async t => {
    setup(t, result);
    await assert.rejects(parseExpense('Split dinner'), expected);
  });
}

test('provider failures are sanitized and do not silently fall back', async t => {
  setup(t);
  globalThis.fetch = async () => { throw new Error('sensitive provider details'); };
  await assert.rejects(extractExpense('I paid $96 with Alex and Sarah.'), error => {
    assert.match(error.message, /Gemini extraction failed/);
    assert.doesNotMatch(error.message, /sensitive provider details/);
    return true;
  });
});

test('without a Gemini key the local parser still works, even with a legacy key', async t => {
  setup(t);
  delete process.env.GEMINI_API_KEY;
  process.env.OPENAI_API_KEY = 'unused-legacy-key';
  assert.equal((await extractExpense('I paid $96 with Alex and Sarah.')).totalCents, 9600);
  await assert.rejects(parseExpense('Split dinner'), /Missing GEMINI_API_KEY/);
});

test('unavailable Gemini models produce actionable feedback', async t => {
  setup(t);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: {
    code: 404, status: 'NOT_FOUND', message: 'Model unavailable'
  } }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(parseExpense('Split dinner'), /Gemini model unavailable.*GEMINI_MODEL/);
});
