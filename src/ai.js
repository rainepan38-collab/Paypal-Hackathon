import { GoogleGenAI } from '@google/genai';
import { dollarsToCents } from './split.js';

const schema = {
  type: 'object', additionalProperties: false,
  required: ['intent', 'description', 'total_amount', 'currency', 'owed_people', 'notes'],
  properties: {
    intent: { type: 'string', enum: ['create_expense', 'other'] },
    description: { type: 'string' },
    total_amount: { type: 'string' },
    currency: { type: 'string' },
    owed_people: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' }
  }
};

export async function parseExpense(message) {
  if (!process.env.GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY');
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  let response;
  try {
    response = await client.models.generateContent({
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      contents: message.slice(0, 1500),
      config: {
        temperature: 0,
        systemInstruction: `Extract equal-split requests for a restaurant or group expense assistant. Return JSON matching schema. Interpret the speaker as the ORGANIZER who already paid. 'owed_people' includes ONLY explicitly named other people who owe the organizer, never 'me', 'I', or the organizer. Example: 'I paid $90 with Alex and Sarah' means owed_people ['Alex','Sarah'] and three total participants counting organizer. Do not infer missing names or amounts. If unclear/unequal split, return intent='other' and notes explaining what to clarify. Only USD. Do not include phone numbers, contacts, or private chat contents.`,
        responseMimeType: 'application/json',
        responseJsonSchema: schema,
        httpOptions: { timeout: 30_000 }
      }
    });
  } catch (error) {
    // Provider errors may contain request details; keep them out of stored chats.
    if (error.status === 404) {
      throw new Error('Gemini model unavailable. Check GEMINI_MODEL and model access for your API key.');
    }
    throw new Error('Gemini extraction failed. Check GEMINI_API_KEY, model access, and quota, then try again.');
  }
  const raw = response.text;
  if (!raw) throw new Error('Gemini returned no extractable response. Please try again.');
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    throw new Error('Gemini returned invalid expense data. Please try again.');
  }
  if (!parsed || !['create_expense', 'other'].includes(parsed.intent) ||
      !['description', 'total_amount', 'currency', 'notes'].every(key => typeof parsed[key] === 'string') ||
      !Array.isArray(parsed.owed_people) || parsed.owed_people.some(name => typeof name !== 'string')) {
    throw new Error('Gemini returned invalid expense data. Please try again.');
  }
  if (parsed.intent !== 'create_expense') throw new Error(parsed.notes || 'Please include a total amount and the names of everyone who owes you. Equal splits only for now.');
  if (parsed.currency !== 'USD') throw new Error('The MVP currently supports USD only.');
  const names = parsed.owed_people.map(s => String(s).trim()).filter(Boolean);
  if (names.length < 1 || names.length > 9 || names.some(s => s.length > 60 || /^(me|i|you|myself)$/i.test(s))) {
    throw new Error('Please name 1–9 other people (excluding yourself).');
  }
  if (new Set(names.map(s => s.toLowerCase())).size !== names.length) throw new Error('Each person must be named once.');
  const description = String(parsed.description || 'Group expense').slice(0, 100);
  return { description, totalCents: dollarsToCents(parsed.total_amount), owedNames: names };
}
