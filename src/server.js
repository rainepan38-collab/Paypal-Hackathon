import 'dotenv/config';
import express from 'express';
import { resolve } from 'node:path';
import { queries } from './db.js';
import { equalSplit, usd, dollarsToCents } from './split.js';
import { createOrder, captureOrder, captureIsValid, verifyWebhook } from './paypal.js';
import { addMessage, allowedActors, getMessages, getThread, listThreads, linkExpense, threadForExpense } from './chat-db.js';
import { extractExpense } from './parser.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const publicDir = resolve('./public');
const isConfigured = () => Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
const formatShare = share => `${share.person}: ${usd(share.amount_cents)}`;
const reply = (res, status, message) => res.status(status).json({error:message});
const expectedNames = expense => [expense.organizer, ...JSON.parse(expense.owed_names_json)];
function postPaidMessage(share) {
  const thread = threadForExpense(share.expense_id);
  if (thread) addMessage(thread, 'SplitMate', `${share.person}'s ${usd(share.amount_cents)} sandbox payment was confirmed.`, 'payment_update', share.expense_id);
}

// Never use express.json() before the raw PayPal webhook endpoint.
app.post('/webhooks/paypal', express.raw({ type:'application/json', limit:'256kb' }), async (req,res) => {
  let event;
  try { event=JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }
  try {
    if (!await verifyWebhook(req.headers,event)) return res.sendStatus(401);
    if (!event?.id) return res.sendStatus(400);
    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      const capture = event.resource;
      const orderId = capture?.supplementary_data?.related_ids?.order_id;
      const share = orderId ? queries.byOrderId(orderId) : null;
      const amountValid = share && capture?.amount?.currency_code === 'USD' && (()=>{try{return dollarsToCents(capture.amount.value)===share.amount_cents;}catch{return false;}})();
      if (share && capture?.status==='COMPLETED' && capture?.id && amountValid) {
        const updated=queries.markPaidByOrder(orderId,capture.id);
        if(updated) postPaidMessage(updated);
      }
    }
    queries.claimPayPalEvent(event.id);
    res.sendStatus(200);
  } catch(err) { console.error('PayPal webhook error:',err); res.sendStatus(503); }
});

app.use(express.json({limit:'32kb'}));
app.get('/health', (_req,res)=>res.json({ok:true,service:'splitmate-mobile',sandbox:true}));
app.get('/api/config', (_req,res)=>res.json({
  aiEnabled:Boolean(process.env.GEMINI_API_KEY),
  paypalEnabled:isConfigured(),
  sandbox:true,
  warning:'PayPal Sandbox checkout credits the configured sandbox merchant, not a friend-to-friend PayPal transfer.'
}));
app.get('/api/chats',(_req,res)=>res.json({actors:allowedActors,threads:listThreads()}));
app.get('/api/chats/:thread/messages',(req,res)=>{
  const messages=getMessages(req.params.thread);
  return messages ? res.json({messages}) : reply(res,404,'Chat not found');
});
app.post('/api/chats/:thread/messages',async(req,res)=>{
  const thread=getThread(req.params.thread);
  const actor=req.body?.actor, text=String(req.body?.text||'').trim();
  if(!thread) return reply(res,404,'Chat not found');
  if(!allowedActors.includes(actor)) return reply(res,400,'Choose a demo participant');
  if(!text || text.length>1000) return reply(res,400,'Write a message under 1,000 characters');
  addMessage(thread.id,actor,text);
  if(/^\s*@?splitmate\b/i.test(text)) {
    try {
      const parsed=await extractExpense(text);
      if(parsed.owedNames.some(n=>n.toLowerCase()===actor.toLowerCase())) throw new Error('Do not list yourself among the people who owe you.');
      const expense=queries.createDraft(actor,parsed.description,parsed.totalCents,parsed.owedNames);
      equalSplit(expense.total_cents,expectedNames(expense));
      linkExpense(expense.id,thread.id);
      addMessage(thread.id,'SplitMate','Here is the proposed split. Confirm before any payment requests are created.','expense_draft',expense.id);
    } catch(err) {
      addMessage(thread.id,'SplitMate',`I couldn't prepare the split: ${String(err.message).slice(0,240)}\nTry: @SplitMate I paid $96 for dinner with Alex and Sarah. Split equally.`,'bot_error');
    }
  }
  res.json({ok:true});
});
app.post('/api/expenses/:id/confirm',(req,res)=>{
  const actor=req.body?.actor;
  if(!allowedActors.includes(actor)) return reply(res,400,'Invalid demo participant');
  const expense=queries.getExpense(req.params.id);
  const thread=threadForExpense(req.params.id);
  if(!expense || !thread) return reply(res,404,'Expense not found');
  if(expense.organizer!==actor) return reply(res,403,'Only the organizer can confirm the split');
  if(expense.status!=='draft') return reply(res,409,'Already confirmed or cancelled');
  try {
    const breakdown=equalSplit(expense.total_cents, expectedNames(expense));
    const shares=queries.confirm(actor,expense.id,breakdown);
    if(!shares) return reply(res,409,'Could not confirm');
    addMessage(thread,'SplitMate','The split is confirmed. Each participant can tap their own card and check out with PayPal Sandbox.','expense_confirmed',expense.id);
    return res.json({ok:true,shares:shares.map(formatShare)});
  } catch(err){return reply(res,400,err.message);}
});
app.get('/api/pay/:token',(req,res)=>{
  const share=queries.byToken(req.params.token);
  if(!share) return reply(res,404,'Payment request not found');
  res.set('Cache-Control','no-store').json({ person:share.person, description:share.description,
    amount:usd(share.amount_cents),status:share.status,clientId:process.env.PAYPAL_CLIENT_ID||null });
});
app.post('/api/pay/:token/order',async(req,res)=>{
  const share=queries.byToken(req.params.token);
  if(!share) return reply(res,404,'Payment request not found');
  if(share.status==='paid') return reply(res,409,'Already paid');
  try {
    if(share.paypal_order_id) return res.json({orderId:share.paypal_order_id});
    const order=await createOrder(share);
    if(!order.id) throw new Error('PayPal did not return an order ID');
    const won=queries.setOrder(share.id,order.id);
    return res.json({orderId:won ? order.id : queries.byToken(req.params.token)?.paypal_order_id});
  } catch(err){console.error(err);return reply(res,502,'PayPal order failed. Verify Sandbox credentials.');}
});
app.post('/api/pay/:token/capture',async(req,res)=>{
  const share=queries.byToken(req.params.token);
  if(!share) return reply(res,404,'Payment request not found');
  if(!req.body?.orderId || share.paypal_order_id!==req.body.orderId) return reply(res,400,'Order ID does not match share');
  if(share.status==='paid') return res.json({status:'COMPLETED',alreadyPaid:true});
  try {
    const result=await captureOrder(share,share.paypal_order_id);
    if(!captureIsValid(result,share.amount_cents,share.paypal_order_id)) return reply(res,409,'Capture pending or amount mismatch');
    const captureId=result.purchase_units[0].payments.captures[0].id;
    const updated=queries.markPaidByOrder(share.paypal_order_id,captureId);
    if(updated) postPaidMessage(updated);
    res.json({status:'COMPLETED'});
  } catch(err){console.error(err);return reply(res,502,'PayPal capture failed. Check developer dashboard before retrying.');}
});
app.get('/pay/:token',(req,res)=>{
  if(!queries.byToken(req.params.token)) return res.status(404).send('Payment request not found');
  res.set('Cache-Control','no-store').sendFile(resolve(publicDir,'pay.html'));
});
app.get('/manifest.webmanifest',(_req,res)=>res.type('application/manifest+json').sendFile(resolve(publicDir,'manifest.webmanifest')));
app.get('/service-worker.js',(_req,res)=>res.type('application/javascript').sendFile(resolve(publicDir,'service-worker.js')));
app.use('/assets',express.static(publicDir,{fallthrough:false,maxAge:'5m'}));
app.get('/',(_req,res)=>res.sendFile(resolve(publicDir,'index.html')));
app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:'Unexpected server error'});});
const port=Number(process.env.PORT||3000);
if(process.env.NODE_ENV!=='test') app.listen(port,()=>console.log(`SplitMate Mobile running at http://localhost:${port}`));
export {app};
