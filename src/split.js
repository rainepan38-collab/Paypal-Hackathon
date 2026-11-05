/** Money always stays as integer cents after input validation. */
export function dollarsToCents(raw) {
  const v = String(raw).trim().replace(/^\$/, '');
  if (!/^(?:0|[1-9]\d{0,4})(?:\.\d{1,2})?$/.test(v)) throw new Error('Enter a valid USD amount (max $99,999.99).');
  const [whole, fractional = ''] = v.split('.');
  const result = Number(whole) * 100 + Number(fractional.padEnd(2, '0'));
  if (result <= 0 || result > 1_000_000) throw new Error('Demo expenses must be between $0.01 and $10,000.00.');
  return result;
}
export function usd(cents) {
  if (!Number.isInteger(cents) || cents < 0) throw new Error('Invalid cents');
  return `$${(cents / 100).toFixed(2)}`;
}
export function equalSplit(totalCents, participantNames) {
  if (!Number.isInteger(totalCents) || totalCents <= 0) throw new Error('Invalid expense total');
  if (!Array.isArray(participantNames) || participantNames.length < 2 || participantNames.length > 10) {
    throw new Error('Need 2–10 participants including the organizer');
  }
  if (totalCents < participantNames.length) throw new Error('Amount too small to split into nonzero shares');
  const base = Math.floor(totalCents / participantNames.length);
  const remainder = totalCents % participantNames.length;
  return participantNames.map((name, i) => ({ name, amountCents: base + (i < remainder ? 1 : 0) }));
}
