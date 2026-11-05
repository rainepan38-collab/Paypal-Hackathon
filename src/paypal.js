import { dollarsToCents } from './split.js';

const base = () => process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';

async function oauthToken() {
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) throw new Error('Missing PayPal Sandbox credentials');
  const credentials = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const response = await fetch(`${base()}/v1/oauth2/token`, {
    method: 'POST', headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!response.ok) throw new Error(`PayPal OAuth ${response.status}: ${(await response.text()).slice(0, 600)}`);
  return (await response.json()).access_token;
}
async function paypalFetch(path, { method = 'GET', body, requestId } = {}) {
  const token = await oauthToken();
  const response = await fetch(`${base()}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(requestId ? { 'PayPal-Request-Id': requestId } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`PayPal ${response.status}: ${JSON.stringify(json).slice(0, 800)}`);
  return json;
}
export async function createOrder(share) {
  return paypalFetch('/v2/checkout/orders', {
    method: 'POST', requestId: `splitmate-create-${share.id}`,
    body: {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: share.expense_id.slice(0, 36),
        custom_id: share.id.slice(0, 36),
        description: 'SplitMate Sandbox expense demo',
        amount: { currency_code: 'USD', value: (share.amount_cents / 100).toFixed(2) }
      }],
      payment_source: { paypal: { experience_context: { shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' } } }
    }
  });
}
export async function captureOrder(share, orderId) {
  return paypalFetch(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: 'POST', requestId: `splitmate-capture-${share.id}` });
}
export async function verifyWebhook(headers, event) {
  if (!process.env.PAYPAL_WEBHOOK_ID) throw new Error('PAYPAL_WEBHOOK_ID missing');
  const payload = {
    auth_algo: headers['paypal-auth-algo'],
    cert_url: headers['paypal-cert-url'],
    transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'],
    transmission_time: headers['paypal-transmission-time'],
    webhook_id: process.env.PAYPAL_WEBHOOK_ID,
    webhook_event: event
  };
  if (Object.values(payload).some(v => !v)) return false;
  const result = await paypalFetch('/v1/notifications/verify-webhook-signature', { method: 'POST', body: payload });
  return result.verification_status === 'SUCCESS';
}
export function captureIsValid(orderData, expectedCents, expectedOrderId) {
  if (orderData.id !== expectedOrderId || orderData.status !== 'COMPLETED') return false;
  const purchaseUnit = orderData.purchase_units?.[0];
  const capture = purchaseUnit?.payments?.captures?.[0];
  if (capture?.status !== 'COMPLETED' || capture?.amount?.currency_code !== 'USD') return false;
  try { return dollarsToCents(capture.amount.value) === expectedCents; } catch { return false; }
}
