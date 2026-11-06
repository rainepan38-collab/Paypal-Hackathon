import 'dotenv/config';
import express from 'express';
import { resolve } from 'node:path';
import { db, queries } from './db.js';
import { usd, dollarsToCents } from './split.js';
import { createOrder, captureOrder, captureIsValid, verifyWebhook } from './paypal.js';
import { addMessage, getMessages, getThread, listThreads, members, isMember, threadForExpense } from './chat-db.js';
import { extractExpense } from './parser.js';
import { validateParticipants } from './participants.js';
import { authRoutes, loadSession, requireAuth, requireCsrf, sessionIsCurrent } from './auth.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((_req,res,next)=>{res.set({'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer'});next();});
const publicDir = resolve('./public');
const isConfigured = () => Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
const formatShare = share => `${share.person}: ${usd(share.amount_cents)}`;
const reply = (res, status, message) => res.status(status).json({error:message});
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
  } catch(err) { console.error('PayPal webhook failed'); res.sendStatus(503); }
});

app.use(express.json({limit:'32kb'}));
app.get('/health', (_req,res)=>res.json({ok:true,service:'splitmate-mobile',sandbox:true}));
app.use(loadSession);
authRoutes(app);
app.use('/api', requireAuth, (req,res,next)=> ['GET','HEAD','OPTIONS'].includes(req.method) ? next() : requireCsrf(req,res,next));
app.get('/api/config', (_req,res)=>res.json({
  aiEnabled:Boolean(process.env.GEMINI_API_KEY),
  paypalEnabled:isConfigured(),
  sandbox:true,
  warning:'PayPal Sandbox checkout credits the configured sandbox merchant, not a friend-to-friend PayPal transfer.'
}));
app.get('/api/chats',(req,res)=>res.json({threads:listThreads(req.user.id)}));
app.get('/api/chats/:thread/messages',(req,res)=>{
  const messages=getMessages(req.params.thread,req.user.id);
  return messages ? res.json({messages}) : reply(res,404,'Chat not found');
});
app.post('/api/chats/:thread/messages',async(req,res)=>{
  const thread=getThread(req.params.thread);
  const actor=req.user, text=String(req.body?.text||'').trim();
  if(!thread) return reply(res,404,'Chat not found');
  if(!isMember(thread.id,actor.id)) return reply(res,403,'You are not a member of this group.');
  if(!text || text.length>1000) return reply(res,400,'Write a message under 1,000 characters');
  addMessage(thread.id,actor.display_name,text,'text',null,actor.id);
  if(/^\s*@?splitmate\b/i.test(text)) {
    try {
      const context={organizer:actor,members:members(thread.id)};
      const parsed=await extractExpense(text,context);
      if(!sessionIsCurrent(req)) return reply(res,401,'Your session expired. Please log in again.');
      if(!isMember(thread.id,actor.id)) return reply(res,403,'You are not a member of this group.');
      const owed=validateParticipants(parsed.owedNames,{organizer:actor,members:members(thread.id)});
      db.transaction(()=>{
        const expense=queries.createDraft(actor,thread.id,parsed.description,parsed.totalCents,owed);
        addMessage(thread.id,'SplitMate','Here is the proposed split. Confirm before any payment requests are created.','expense_draft',expense.id);
      })();
    } catch(err) {
      if(!sessionIsCurrent(req)) return reply(res,401,'Your session expired. Please log in again.');
      if(!isMember(thread.id,actor.id)) return reply(res,403,'You are not a member of this group.');
      const peers=members(thread.id).filter(user=>user.id!==actor.id).map(user=>user.display_name);
      addMessage(thread.id,'SplitMate',`I couldn't prepare the split: ${String(err.message).slice(0,240)}\nTry: @SplitMate I paid $96 for dinner with ${peers.join(' and ')}. Split equally.`,'bot_error');
    }
  }
  res.json({ok:true});
});
app.post('/api/expenses/:id/confirm',(req,res)=>{
  const actor=req.user;
  const expense=queries.getExpense(req.params.id);
  const thread=threadForExpense(req.params.id);
  if(!expense || !thread) return reply(res,404,'Expense not found');
  if(!isMember(thread,actor.id)) return reply(res,403,'You are not a member of this group.');
  if(expense.organizer_user_id!==actor.id) return reply(res,403,'Only the organizer can confirm the split');
  if(expense.status!=='draft') return reply(res,409,'Already confirmed or cancelled');
  try {
    const shares=db.transaction(()=>{
      const result=queries.confirm(actor.id,expense.id);
      if(result) addMessage(thread,'SplitMate','The split is confirmed. Each participant can tap their own card and check out with PayPal Sandbox.','expense_confirmed',expense.id);
      return result;
    })();
    if(!shares) return reply(res,409,'Could not confirm');
    return res.json({ok:true,shares:shares.map(formatShare)});
  } catch(err){return reply(res,400,err.message);}
});
function canViewShare(share,userId) {
  return share && isMember(share.thread_id,userId) && [share.person_user_id,share.organizer_user_id].includes(userId);
}
app.use('/api/pay/:token',(req,res,next)=>{
  const share=queries.byToken(req.params.token);
  if(!canViewShare(share,req.user.id)) return reply(res,404,'Payment request not found for this account.');
  if(req.method==='POST' && share.person_user_id!==req.user.id) return reply(res,403,'Only the named participant can pay this share.');
  req.share=share;next();
});
app.get('/api/pay/:token',(req,res)=>{
  const share=req.share;
  if(!share) return reply(res,404,'Payment request not found');
  res.set('Cache-Control','no-store').json({ person:share.person, description:share.description,
    organizer:share.organizer, canPay:share.person_user_id===req.user.id,
    amount:usd(share.amount_cents),status:share.status,clientId:process.env.PAYPAL_CLIENT_ID||null });
});
app.post('/api/pay/:token/order',async(req,res)=>{
  const share=req.share;
  if(!share) return reply(res,404,'Payment request not found');
  if(share.status==='paid') return reply(res,409,'Already paid');
  try {
    if(share.paypal_order_id) return res.json({orderId:share.paypal_order_id});
    const order=await createOrder(share);
    if(!order.id) throw new Error('PayPal did not return an order ID');
    const won=queries.setOrder(share.id,order.id);
    return res.json({orderId:won ? order.id : queries.byToken(req.params.token)?.paypal_order_id});
  } catch(err){console.error('Request failed');return reply(res,502,'PayPal order failed. Verify Sandbox credentials.');}
});
app.post('/api/pay/:token/capture',async(req,res)=>{
  const share=req.share;
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
  } catch(err){console.error('Request failed');return reply(res,502,'PayPal capture failed. Check developer dashboard before retrying.');}
});
app.get('/pay/:token',(req,res)=>{
  if(!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  if(!canViewShare(queries.byToken(req.params.token),req.user.id)) return res.status(404).send('Payment request not found for this account. Log in as the named participant.');
  res.set('Cache-Control','no-store').sendFile(resolve(publicDir,'pay.html'));
});
app.get('/manifest.webmanifest',(_req,res)=>res.type('application/manifest+json').sendFile(resolve(publicDir,'manifest.webmanifest')));
app.get('/service-worker.js',(_req,res)=>res.type('application/javascript').sendFile(resolve(publicDir,'service-worker.js')));
app.use('/assets',express.static(publicDir,{fallthrough:false,maxAge:0}));
app.get('/login',(req,res)=>req.user ? res.redirect('/') : res.sendFile(resolve(publicDir,'login.html')));
app.get('/',(req,res)=>req.user ? res.sendFile(resolve(publicDir,'index.html')) : res.redirect('/login'));
app.use((err,_req,res,_next)=>{console.error('Request failed');res.status(500).json({error:'Unexpected server error'});});
const port=Number(process.env.PORT||3000);
if(process.env.NODE_ENV!=='test') app.listen(port,()=>console.log(`SplitMate Mobile running at http://localhost:${port}`));
export {app};
