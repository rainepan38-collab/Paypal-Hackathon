const token = location.pathname.split('/').filter(Boolean).at(-1);
let csrfToken;
const $ = id => document.getElementById(id);
function say(message) { $('message').textContent = message; }
async function requestJson(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(csrfToken ? {'X-CSRF-Token':csrfToken} : {}) }, cache:'no-store' });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) location.replace(`/login?next=${encodeURIComponent(location.pathname)}`);
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
async function waitForPayPal() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (window.paypal?.createInstance) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('PayPal v6 SDK did not load. Check your internet connection.');
}
async function main() {
  const auth = await requestJson('/api/auth/session');
  if (!auth.user) { location.replace(`/login?next=${encodeURIComponent(location.pathname)}`); return; }
  csrfToken = auth.csrfToken;
  $('account').textContent = auth.user.name;
  const details = await requestJson(`/api/pay/${encodeURIComponent(token)}`);
  $('description').textContent = details.description;
  $('person').textContent = details.person;
  $('organizer').textContent = details.organizer;
  $('amount').textContent = details.amount;
  $('state').textContent = details.status.toUpperCase();
  if (details.status === 'paid') { say('✅ This share has already been paid.'); return; }
  if (!details.canPay) { say(`Sign out from chats and log in as ${details.person} to pay. You can reshare this link with them.`); return; }
  if (!details.clientId) { say('PayPal Sandbox is not configured yet.'); return; }
  await waitForPayPal();
  const sdk = await window.paypal.createInstance({ clientId: details.clientId, components: ['paypal-payments'], pageType: 'checkout' });
  const eligible = await sdk.findEligibleMethods({ currencyCode: 'USD' });
  if (!eligible.isEligible('paypal')) { say('PayPal checkout is not eligible in this browser/region.'); return; }
  const session = sdk.createPayPalOneTimePaymentSession({
    onApprove: async ({ orderId }) => {
      say('Payment approved. Capturing and verifying...');
      try {
        const result = await requestJson(`/api/pay/${encodeURIComponent(token)}/capture`, {
          method: 'POST', body: JSON.stringify({ orderId })
        });
        if (result.status !== 'COMPLETED') throw new Error('Payment has not completed.');
        $('state').textContent = 'PAID';
        $('paypal-btn').hidden = true;
        say('✅ Payment completed in PayPal Sandbox!');
      } catch (error) { say(`Payment not confirmed: ${error.message}`); }
    },
    onCancel: () => say('Payment cancelled. Nothing was charged.'),
    onError: error => { console.error(error); say('PayPal checkout error. Please retry.'); }
  });
  const btn = $('paypal-btn');
  btn.hidden = false;
  btn.addEventListener('click', async () => {
    try {
      say('Opening PayPal checkout...');
      const orderPromise = requestJson(`/api/pay/${encodeURIComponent(token)}/order`, { method: 'POST' })
        .then(data => ({ orderId: data.orderId }));
      await session.start({ presentationMode: 'auto' }, orderPromise);
    } catch (error) { say(error.message); }
  });
  say('Ready. Use a PayPal Sandbox personal test account at checkout.');
}
main().catch(error => { console.error(error); say(error.message); });

window.addEventListener('storage',event=>{if(event.key==='splitmate-auth-change') location.reload();});
window.addEventListener('pageshow',event=>{if(event.persisted) location.reload();});
