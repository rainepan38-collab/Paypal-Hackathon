import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

// Every integration test uses fake credentials and isolated in-memory SQLite.
test('authenticated multi-user chat and Sandbox payments', async t => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV:'test',DB_PATH:':memory:',DOTENV_CONFIG_QUIET:'true',SESSION_SECRET:randomBytes(48).toString('hex'),
    SESSION_TTL_HOURS:'8',PUBLIC_BASE_URL:'',GEMINI_API_KEY:'test-key',GEMINI_MODEL:'gemini-2.5-flash',
    PAYPAL_CLIENT_ID:'test-client',PAYPAL_CLIENT_SECRET:'test-secret',PAYPAL_API_BASE:'https://api-m.sandbox.paypal.com',PAYPAL_WEBHOOK_ID:'test-webhook'
  });
  const { app } = await import('../src/server.js');
  const { db, queries } = await import('../src/db.js');
  const { setPassword } = await import('../src/auth.js');
  const server = app.listen(0,'127.0.0.1');
  t.after(async()=>{
    await new Promise(resolve=>server.close(resolve));
    db.close();process.env=saved;
  });
  await once(server,'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  let extraction, prompt, gate;
  let orderNumber=0;
  const orderAmounts=new Map();
  const json=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const target=String(url);
    if(target.startsWith(base))return realFetch(url,options);
    if(target.includes('generativelanguage.googleapis.com')){
      const body=JSON.parse(options.body);
      prompt=body.systemInstruction.parts[0].text;
      if(gate)await gate();
      return json({candidates:[{content:{parts:[{text:JSON.stringify(extraction)}]}}]});
    }
    assert.ok(target.startsWith('https://api-m.sandbox.paypal.com/'),'Only Sandbox merchant is contacted');
    if(target.endsWith('/v1/oauth2/token'))return json({access_token:'fake-token'});
    if(target.endsWith('/v2/checkout/orders')){
      const body=JSON.parse(options.body);
      assert.equal(body.purchase_units[0].amount.currency_code,'USD');
      const id=`order-${++orderNumber}`;
      orderAmounts.set(id,body.purchase_units[0].amount.value);
      return json({id});
    }
    if(target.endsWith('/capture')){
      const id=target.split('/').at(-2);
      return json({id,status:'COMPLETED',purchase_units:[{payments:{captures:[{
        id:`capture-${id}`,status:'COMPLETED',amount:{currency_code:'USD',value:orderAmounts.get(id)}
      }]}}]});
    }
    if(target.endsWith('/verify-webhook-signature'))return json({verification_status:'SUCCESS'});
    throw new Error('Unexpected external request');
  });
  function client(){
    return {
      cookie:'',csrf:null,lastCookie:'',
      async request(path,body,expected=200,extra={}){
        const response=await fetch(base+path,{
          ...(body!==undefined?{method:'POST',body:JSON.stringify(body)}:{}),redirect:'manual',
          headers:{'Content-Type':'application/json',...(this.cookie?{Cookie:this.cookie}:{}),...(this.csrf?{'X-CSRF-Token':this.csrf}:{}),...extra}
        });
        const setCookie=response.headers.get('set-cookie');
        if(setCookie){this.lastCookie=setCookie;this.cookie=setCookie.split(';')[0];}
        assert.equal(response.status,expected,`${path} returned ${response.status}`);
        const data=await response.json().catch(()=>({}));
        if(data.csrfToken)this.csrf=data.csrfToken;
        return data;
      },
      async bootstrap(){return this.request('/api/auth/session');},
      async login(name,password){await this.bootstrap();return this.request('/api/auth/login',{username:name,password});}
    };
  }
  const clients={Jimmy:client(),Alex:client(),Sarah:client()};
  const passwords=Object.fromEntries(Object.keys(clients).map(name=>[name,randomBytes(5).toString('hex')]));
  const anonymous=client();
  await t.test('anonymous access and missing CSRF are rejected',async()=>{
    await anonymous.request('/health');
    await anonymous.request('/api/chats',undefined,401);
    await anonymous.request('/api/chats/weekend-crew/messages',{actor:'Jimmy',text:'forged'},401);
    await anonymous.request('/api/auth/login',{username:'Jimmy',password:'fake-password-value'},403);
    const root=await fetch(base,{redirect:'manual'});
    assert.equal(root.status,302);assert.equal(root.headers.get('location'),'/login');
    await anonymous.bootstrap();
    await anonymous.request('/api/auth/login',{username:'Jimmy',password:'fake-password-value'},401);
  });
  await t.test('accounts start locked and only store bcrypt password hashes',async()=>{
    for(const name of Object.keys(clients)){
      assert.equal(queries.userByName(name).password_hash,null);
      await setPassword(queries.userByName(name).id,passwords[name]);
      const hash=queries.userByName(name).password_hash;
      assert.match(hash,/^\$2[aby]\$12\$/);
      assert.notEqual(hash,passwords[name]);
      assert.ok(await bcrypt.compare(passwords[name],hash));
    }
    assert.equal(queries.userByName('You'),undefined);
  });
  await t.test('login verifies passwords, rotates sessions, and sets safe cookies',async()=>{
    for(const [name,c] of Object.entries(clients)){
      await c.bootstrap();const original=c.cookie;
      await c.request('/api/auth/login',{username:name,password:'wrong-password-value'},401);
      const session=await c.request('/api/auth/login',{username:name.toLowerCase(),password:passwords[name]});
      assert.equal(session.user.name,name);assert.notEqual(c.cookie,original);
      assert.match(c.lastCookie,/HttpOnly/);assert.match(c.lastCookie,/SameSite=Lax/);
      assert.doesNotMatch(c.lastCookie,/; Secure/);
      const stale=client();stale.cookie=original;
      await stale.request('/api/chats',undefined,401);
      const config=await c.request('/api/config');assert.equal(config.sandbox,true);
      const {threads}=await c.request('/api/chats');
      assert.equal(threads.length,2);assert.equal(threads[0].subtitle,'Jimmy, Alex, Sarah');
      assert.ok(!JSON.stringify(threads).includes('password_hash'));
      assert.ok(db.prepare('SELECT id_hash FROM sessions WHERE user_id=?').get(session.user.id).id_hash!==c.cookie.split('=')[1]);
    }
  });
  await t.test('account switching requires logout, and CSRF checks token and origin',async()=>{
    const c=clients.Jimmy;
    await c.request('/api/auth/login',{username:'Alex',password:passwords.Alex},409);
    await c.request('/api/chats/weekend-crew/messages',{text:'blocked'},403,{'X-CSRF-Token':'wrong'});
    await c.request('/api/chats/weekend-crew/messages',{text:'blocked'},403,{Origin:'https://evil.example'});
    await c.request('/api/chats/weekend-crew/messages',{text:'blocked'},403,{'Sec-Fetch-Site':'cross-site'});
    await c.request('/api/chats/weekend-crew/messages',{actor:'Sarah',text:'Sent by Jimmy, despite forged actor'});
    const {messages}=await c.request('/api/chats/weekend-crew/messages');
    assert.equal(messages.at(-1).senderId,'user-jimmy');
  });
  const drafts={};
  for(const [name,total,owed,amounts] of [
    ['Jimmy','96',['Alex','Sarah'],[3200,3200,3200]],
    ['Alex','32',['Jimmy','Sarah'],[1067,1067,1066]],
    ['Sarah','60',['Jimmy','Alex'],[2000,2000,2000]]
  ]){
    await t.test(`${name} creates and confirms an accurate split as authenticated organizer`,async()=>{
      extraction={intent:'create_expense',description:name==='Sarah'?'groceries':'dinner',total_amount:total,currency:'USD',owed_people:owed,notes:''};
      const c=clients[name];
      await c.request('/api/chats/weekend-crew/messages',{actor:'Untrusted client identity',text:`@SplitMate I paid $${total} for ${extraction.description} with ${owed.join(' and ')}. Split equally.`});
      assert.match(prompt,new RegExp(`"name":"${name}"`));
      assert.match(prompt,/Valid group members:.*Jimmy.*Alex.*Sarah/);
      const {messages}=await c.request('/api/chats/weekend-crew/messages');
      const draft=messages.filter(m=>m.kind==='expense_draft').at(-1).expense;
      drafts[name]=draft;
      assert.equal(draft.organizer,name);assert.equal(draft.organizerId,`user-${name.toLowerCase()}`);
      const other=clients[owed[0]];
      await other.request(`/api/expenses/${draft.id}/confirm`,{actor:name},403);
      await c.request(`/api/expenses/${draft.id}/confirm`,{actor:owed[0]});
      await c.request(`/api/expenses/${draft.id}/confirm`,{},409);
      const shares=queries.shares(draft.id);
      assert.deepEqual(shares.map(s=>s.amount_cents),amounts.slice(1));
      assert.equal(shares.reduce((sum,s)=>sum+s.amount_cents,amounts[0]),Number(total)*100);
      assert.deepEqual(shares.map(s=>s.person),owed);
    });
  }
  await t.test('legacy You maps to Jimmy for Alex, in AI and local fallback paths',async()=>{
    extraction={intent:'create_expense',description:'dinner',total_amount:'32',currency:'USD',owed_people:['You','Sarah'],notes:''};
    await clients.Alex.request('/api/chats/weekend-crew/messages',{text:'@SplitMate I paid $32 for dinner with You and Sarah. Split equally.'});
    let {messages}=await clients.Alex.request('/api/chats/weekend-crew/messages');
    assert.deepEqual(messages.at(-1).expense.names,['Alex','Jimmy','Sarah']);
    delete process.env.GEMINI_API_KEY;
    await clients.Alex.request('/api/chats/weekend-crew/messages',{text:'@SplitMate I paid $32 for dinner with You and Sarah. Split equally.'});
    ({messages}=await clients.Alex.request('/api/chats/weekend-crew/messages'));
    assert.deepEqual(messages.at(-1).expense.names,['Alex','Jimmy','Sarah']);
    process.env.GEMINI_API_KEY='test-key';
  });
  await t.test('unknown, duplicate, self, and ambiguous legacy participants are rejected',async()=>{
    for(const [name,owed] of [['Jimmy',['You','Sarah']],['Alex',['Jimmy','You']],['Sarah',['Sarah','Alex']],['Jimmy',['Mallory','Sarah']]]){
      extraction={intent:'create_expense',description:'dinner',total_amount:'32',currency:'USD',owed_people:owed,notes:''};
      const count=db.prepare('SELECT COUNT(*) n FROM expenses').get().n;
      await clients[name].request('/api/chats/weekend-crew/messages',{text:'@SplitMate split dinner'});
      assert.equal(db.prepare('SELECT COUNT(*) n FROM expenses').get().n,count);
      const {messages}=await clients[name].request('/api/chats/weekend-crew/messages');
      assert.equal(messages.at(-1).kind,'bot_error');
    }
  });
  await t.test('group membership controls messages, participants and confirmations',async()=>{
    extraction={intent:'create_expense',description:'rent',total_amount:'60',currency:'USD',owed_people:['Sarah'],notes:''};
    await clients.Jimmy.request('/api/chats/roommates/messages',{text:'@SplitMate I paid $60 with Sarah.'});
    const pending=queries.getExpense(db.prepare("SELECT id FROM expenses WHERE description='rent' AND status='draft'").get().id);
    db.prepare('DELETE FROM group_members WHERE thread_id=? AND user_id=?').run('roommates','user-sarah');
    const {threads}=await clients.Sarah.request('/api/chats');assert.equal(threads.length,1);
    await clients.Sarah.request('/api/chats/roommates/messages',undefined,404);
    await clients.Sarah.request('/api/chats/roommates/messages',{text:'not allowed'},403);
    await clients.Sarah.request(`/api/expenses/${pending.id}/confirm`,{},403);
    await clients.Jimmy.request(`/api/expenses/${pending.id}/confirm`,{},400);
    extraction={intent:'create_expense',description:'rent',total_amount:'60',currency:'USD',owed_people:['Sarah'],notes:''};
    await clients.Jimmy.request('/api/chats/roommates/messages',{text:'@SplitMate I paid $60 with Sarah.'});
    const {messages}=await clients.Jimmy.request('/api/chats/roommates/messages');assert.equal(messages.at(-1).kind,'bot_error');
    db.prepare('INSERT INTO group_members VALUES(?,?)').run('roommates','user-sarah');
  });
  await t.test('payment links require login and named-payer authorization; capture tracks payment once',async()=>{
    const share=queries.shares(drafts.Jimmy.id)[0];
    await anonymous.request(`/api/pay/${share.token}`,undefined,401);
    const page=await fetch(base+`/pay/${share.token}`,{redirect:'manual'});
    assert.equal(page.status,302);assert.match(page.headers.get('location'),/^\/login\?next=/);
    await clients.Sarah.request(`/api/pay/${share.token}`,undefined,404);
    await clients.Jimmy.request(`/api/pay/${share.token}/order`,{},403);
    assert.equal((await clients.Jimmy.request(`/api/pay/${share.token}`)).canPay,false);
    const c=clients.Alex;
    assert.equal((await c.request(`/api/pay/${share.token}`)).organizer,'Jimmy');
    const {orderId}=await c.request(`/api/pay/${share.token}/order`,{});
    assert.equal(orderAmounts.get(orderId),'32.00');
    await c.request(`/api/pay/${share.token}/capture`,{orderId:'wrong'},400);
    assert.equal((await c.request(`/api/pay/${share.token}/capture`,{orderId})).status,'COMPLETED');
    assert.equal((await c.request(`/api/pay/${share.token}/capture`,{orderId})).alreadyPaid,true);
    assert.equal((await c.request(`/api/pay/${share.token}`)).status,'paid');
    const {messages}=await c.request('/api/chats/weekend-crew/messages');
    assert.equal(messages.filter(m=>m.kind==='payment_update' && m.expense?.id===drafts.Jimmy.id).length,1);
  });
  await t.test('webhook signature verification and idempotent payment updates remain intact',async()=>{
    const share=queries.shares(drafts.Jimmy.id)[1];
    const {orderId}=await clients.Sarah.request(`/api/pay/${share.token}/order`,{});
    const event={id:'webhook-event',event_type:'PAYMENT.CAPTURE.COMPLETED',resource:{id:'webhook-capture',status:'COMPLETED',amount:{currency_code:'USD',value:'32.00'},supplementary_data:{related_ids:{order_id:orderId}}}};
    const send=headers=>fetch(base+'/webhooks/paypal',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(event)});
    assert.equal((await send({})).status,401);
    const headers={'paypal-auth-algo':'test','paypal-cert-url':'https://api.paypal.com/cert','paypal-transmission-id':'test','paypal-transmission-sig':'test','paypal-transmission-time':'test'};
    assert.equal((await send(headers)).status,200);assert.equal((await send(headers)).status,200);
    assert.equal(queries.byToken(share.token).status,'paid');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM chat_messages WHERE kind='payment_update' AND expense_id=?").get(drafts.Jimmy.id).n,2);
  });
  await t.test('logout invalidates the old session and switching requires the new password',async()=>{
    const c=clients.Jimmy;const stale=client();stale.cookie=c.cookie;stale.csrf=c.csrf;
    await c.request('/api/auth/logout',{});
    await stale.request('/api/chats',undefined,401);
    await c.bootstrap();
    await c.request('/api/auth/login',{username:'Alex',password:passwords.Jimmy},401);
    const switched=await c.request('/api/auth/login',{username:'Alex',password:passwords.Alex});
    assert.equal(switched.user.name,'Alex');
    await c.request('/api/auth/logout',{});await c.login('Jimmy',passwords.Jimmy);
  });
  await t.test('absolute session expiration and tampering revoke access',async()=>{
    const c=clients.Jimmy;const tampered=client();tampered.cookie=c.cookie.slice(0,-1)+(c.cookie.endsWith('a')?'b':'a');
    await tampered.request('/api/chats',undefined,401);
    db.prepare('UPDATE sessions SET expires_ms=? WHERE user_id=?').run(Date.now()-1,'user-jimmy');
    await c.request('/api/chats',undefined,401);
    await c.login('Jimmy',passwords.Jimmy);
  });
  await t.test('a logout during Gemini extraction cannot create a new draft',async()=>{
    let unblock,entered;
    const ready=new Promise(resolve=>{entered=resolve;});
    const wait=new Promise(resolve=>{unblock=resolve;});
    gate=async()=>{entered();await wait;};
    extraction={intent:'create_expense',description:'dinner',total_amount:'96',currency:'USD',owed_people:['Alex','Sarah'],notes:''};
    const count=db.prepare('SELECT COUNT(*) n FROM expenses').get().n;
    const c=clients.Jimmy;
    const pending=c.request('/api/chats/weekend-crew/messages',{text:'@SplitMate I paid $96 with Alex and Sarah.'},401);
    await ready;await c.request('/api/auth/logout',{});unblock();await pending;gate=null;
    assert.equal(db.prepare('SELECT COUNT(*) n FROM expenses').get().n,count);
    await c.login('Jimmy',passwords.Jimmy);
  });
  await t.test('HTTPS proxy responses use Secure cookies',async()=>{
    const c=client();await c.request('/api/auth/session',undefined,200,{'X-Forwarded-Proto':'https'});
    assert.match(c.lastCookie,/; Secure/);
  });
  await t.test('password resets revoke sessions and basic login rate limiting blocks attempts',async()=>{
    await setPassword('user-sarah',passwords.Sarah);
    await clients.Sarah.request('/api/chats',undefined,401);
    db.prepare('DELETE FROM login_limits').run();
    const c=client();await c.bootstrap();
    for(let i=0;i<8;i++)await c.request('/api/auth/login',{username:'Sarah',password:'incorrect-password'},401);
    await c.request('/api/auth/login',{username:'Sarah',password:passwords.Sarah},429);
    db.prepare('UPDATE login_limits SET expires_ms=?').run(Date.now()-1);
    await c.request('/api/auth/login',{username:'Sarah',password:passwords.Sarah});
  });
});
