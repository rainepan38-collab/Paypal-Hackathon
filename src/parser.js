import { dollarsToCents } from './split.js';
import { validateParticipants } from './participants.js';

/** Local fallback is explicitly non-AI. For a real AI demo, set GEMINI_API_KEY. */
export function parseDemoExpense(text, context) {
  const content = String(text).replace(/^\s*@?splitmate\s*[:,-]?\s*/i,'');
  const amount = content.match(/\$\s*(\d{1,5}(?:\.\d{1,2})?)/);
  if (!amount) throw new Error('Include a total like $96. Example: @SplitMate I paid $96 for dinner with Alex and Sarah.');
  const participants = content.match(/\bwith\s+([\p{L}\s,&'-]+?)(?:[.!?]|\s+(?:split|equally|please)\b|$)/iu);
  if (!participants) throw new Error('Include the names after “with”, like “with Alex and Sarah”.');
  const names = participants[1].split(/\s*(?:,|\band\b|&)\s*/i).map(s=>s.trim()).filter(Boolean);
  if (!names.length || names.length > 9 || new Set(names.map(s=>s.toLowerCase())).size !== names.length)
    throw new Error('Name 1–9 different people.');
  const validatedNames = validateParticipants(names, context).map(user => user.display_name);
  const descriptionMatch = content.match(/\bfor\s+(.+?)\s+with\b/i);
  let description = descriptionMatch ? descriptionMatch[1] : 'Shared expense';
  description = description.replace(/^(?:the|a)\s+/i,'').trim().slice(0,100);
  return { description, totalCents:dollarsToCents(amount[1]), owedNames:validatedNames };
}
export async function extractExpense(text, context) {
  if (!process.env.GEMINI_API_KEY) return parseDemoExpense(text, context);
  const { parseExpense } = await import('./ai.js');
  return parseExpense(text.replace(/^\s*@?splitmate\s*[:,-]?\s*/i,''), context);
}
