const $ = id => document.getElementById(id);
const state = { user:null, csrfToken:null, thread:localStorage.getItem('splitmate-demo-thread')||'weekend-crew', threads:[], messages:[], busy:false, prevSignature:'' };
const api = async (url,init={})=>{
  const response=await fetch(url,{...init,headers:{'Content-Type':'application/json',...(state.csrfToken?{'X-CSRF-Token':state.csrfToken}:{}),...(init.headers||{})},cache:'no-store'});
  const body=await response.json().catch(()=>({}));
  if(response.status===401){document.body.classList.add('session-loading');location.replace('/login');}
  if(!response.ok) throw new Error(body.error||`Request failed (${response.status})`);
  return body;
};
const money = n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n/100);
const thread = ()=>state.threads.find(t=>t.id===state.thread)||state.threads[0];
function node(tag,cls,text){const el=document.createElement(tag); if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;}
function toast(text){$('toast').textContent=text;$('toast').classList.add('show');clearTimeout(toast._timer);toast._timer=setTimeout(()=>$('toast').classList.remove('show'),3200);}
function time(ms){return new Date(ms).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});}
function empty(el){el.replaceChildren();}
function setThread(id,open=true){state.thread=id;localStorage.setItem('splitmate-demo-thread',id);state.prevSignature='';const t=thread();$('headerTitle').textContent=t.name;$('detailTitle').textContent=t.name;$('headerAvatar').textContent=t.emoji;$('detailAvatar').textContent=t.emoji;$('headerSub').textContent=t.subtitle;renderMembers();$('composer').placeholder=`Message ${t.name}...`;if(open)$('shell').classList.add('chat-open');renderThreads();refresh(true).catch(err=>toast(err.message));}
function renderThreads(){empty($('threadList'));for(const t of state.threads){const btn=node('button',`thread ${state.thread===t.id?'selected':''}`);btn.type='button';btn.setAttribute('aria-label',`Open ${t.name}`);const ava=node('div','thread-ava',t.emoji);ava.style.background=t.color;const copy=node('div','thread-copy');copy.append(node('strong','',t.name),node('p','',t.subtitle));btn.append(ava,copy,node('span','thread-time','›'));btn.onclick=()=>setThread(t.id);$('threadList').append(btn);}}
function renderMembers(){
  const target=$('groupMembers');empty(target);
  const people=thread().members;$('memberCount').textContent=people.length;
  for(const person of people){
    const row=node('div','member');const info=node('div','');
    info.append(node('strong','',person.name),node('small','',person.id===state.user.id?'Signed in':'Group member'));
    row.append(node('div',`member-ava ${person.username}`,person.avatar),info);target.append(row);
  }
}
async function verifySession(){
  const session=await api('/api/auth/session');
  if(!session.user || (state.user && session.user.id!==state.user.id)){
    document.body.classList.add('session-loading');location.replace('/login');throw new Error('Your account session changed.');
  }
  state.csrfToken=session.csrfToken;
  return session;
}
function renderExpenseDraft(message,container){
  const e=message.expense;if(!e)return;
  const box=node('div','expense-inner');box.append(node('div','expense-topline','SPLIT PROPOSAL'),node('div','expense-title',e.description),node('div','expense-total',money(e.totalCents)));
  const base=Math.floor(e.totalCents/e.names.length),remainder=e.totalCents%e.names.length;
  e.names.forEach((person,index)=>{
    const line=node('div','expense-person');const p=node('span','',person===e.organizer?`${person} (paid upfront)`:person);const a=node('b','',money(base+(index<remainder?1:0)));line.append(p,a);box.append(line);
  });
  box.append(node('div','expense-info',e.status==='draft'?'Review this split first. No requests have been sent.':'This proposal is no longer editable.'));
  if(e.status==='draft'){
    const button=node('button','card-action',state.user.id===e.organizerId?'Confirm & create requests':`Only ${e.organizer} can confirm`);button.disabled=state.user.id!==e.organizerId||state.busy;
    button.onclick=async()=>{button.disabled=true;try{await api(`/api/expenses/${encodeURIComponent(e.id)}/confirm`,{method:'POST',body:JSON.stringify({})});toast('Split confirmed! Payment requests created.');await refresh(true);}catch(err){toast(err.message);}finally{button.disabled=state.user.id!==e.organizerId;}};
    box.append(button);
  }
  container.append(box);
}
async function copyLink(token){const url=new URL(`/pay/${encodeURIComponent(token)}`,location.origin).href;try{await navigator.clipboard.writeText(url);toast('Payment link copied!');}catch{window.prompt('Copy this payment URL:',url);}}
function renderConfirmed(message,container){
  const e=message.expense;if(!e)return;
  const box=node('div','expense-inner');box.append(node('div','expense-topline','PAYMENT REQUESTS READY'),node('div','expense-title',e.description),node('div','expense-total',money(e.totalCents)));
  const note=node('div','expense-info','Each share has its own PayPal Sandbox checkout. Only the named participant can pay. Test funds go to the configured merchant.');box.append(note);container.append(box);
  const shares=node('div','confirmed-shares');
  e.shares.forEach(s=>{
    const line=node('div','share-line');const person=node('div','');person.append(node('div','share-name',s.person),node('div','share-amount',money(s.amountCents)));
    const actions=node('div','share-actions');
    if(s.status==='paid'){actions.append(node('span','status-pill paid','✓ Paid'));}
    else {
      actions.append(node('span','status-pill','Unpaid'));
      if(state.user.id===s.personId||state.user.id===e.organizerId){const go=node('button','card-secondary',state.user.id===s.personId?'Pay now':'Open');go.onclick=()=>{location.href=`/pay/${encodeURIComponent(s.token)}`;};actions.append(go);}
      if(s.token){const copy=node('button','card-secondary','↗');copy.title=`Copy ${s.person}'s payment link`;copy.setAttribute('aria-label',`Copy ${s.person}'s payment link`);copy.onclick=()=>copyLink(s.token);actions.append(copy);}
    }
    line.append(person,actions);shares.append(line);
  });
  container.append(shares);
}
function renderMessages(){
  const messages=$('messages'),nearBottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<140;
  empty(messages);
  const date=node('div','date-divider','GROUP CONVERSATION');messages.append(date);
  for(const msg of state.messages){
    const row=node('div',`message-row ${msg.senderId===state.user.id?'mine':''} ${msg.sender==='SplitMate'?'bot':''}`);
    if(msg.senderId!==state.user.id)row.append(node('div','sender-name',msg.sender));
    const bubble=node('div','message-bubble');
    if(msg.sender==='SplitMate'){
      const label=node('div','bot-label');label.append(node('span','bot-mark','✦'),node('span','','SplitMate assistant'));bubble.append(label);
      if(msg.text)bubble.append(node('div','bot-body',msg.text));
      if(msg.kind==='expense_draft')renderExpenseDraft(msg,bubble);
      if(msg.kind==='expense_confirmed')renderConfirmed(msg,bubble);
    } else bubble.textContent=msg.text;
    row.append(bubble,node('div','chat-timestamp',time(msg.createdAt)));messages.append(row);
  }
  if(nearBottom || !state.prevSignature)messages.scrollTop=messages.scrollHeight;
  updateSummary();
}
function updateSummary(){
  const target=$('summaryContent');empty(target);
  const latest=[...state.messages].reverse().find(m=>m.kind==='expense_confirmed'&&m.expense);
  if(!latest){target.append(node('p','','No expenses yet. Ask SplitMate to split one!'));return;}
  const e=latest.expense;const paid=e.shares.filter(s=>s.status==='paid').reduce((sum,s)=>sum+s.amountCents,0);
  const owing=e.shares.reduce((sum,s)=>sum+s.amountCents,0);
  target.append(node('div','summary-big',money(owing-paid)),node('div','summary-sub',`${e.description} · Outstanding from ${e.shares.length} shares`));
  const bar=node('div','summary-bar');const progress=node('span');progress.style.width=`${owing?paid/owing*100:0}%`;bar.append(progress);target.append(bar,node('div','summary-sub',`${e.shares.filter(s=>s.status==='paid').length} of ${e.shares.length} paid`));
}
async function refresh(force=false){
  await verifySession();
  const active=state.thread;
  const data=await api(`/api/chats/${encodeURIComponent(active)}/messages`);
  if(active!==state.thread)return;
  const signature=JSON.stringify(data.messages);
  if(force||signature!==state.prevSignature){state.messages=data.messages;renderMessages();state.prevSignature=signature;}
}
async function send(event){
  event.preventDefault();if(state.busy)return;
  const text=$('composer').value.trim();if(!text)return;
  state.busy=true;$('sendBtn').disabled=true;$('composer').value='';
  try{await api(`/api/chats/${encodeURIComponent(state.thread)}/messages`,{method:'POST',body:JSON.stringify({text})});await refresh(true);}catch(err){$('composer').value=text;toast(err.message);}finally{state.busy=false;$('sendBtn').disabled=false;renderMessages();$('composer').focus();}
}
async function init(){
  const session=await verifySession();state.user=session.user;
  localStorage.removeItem('splitmate-demo-person');
  const meta=await api('/api/chats');state.threads=meta.threads;
  if(!state.threads.length)throw new Error('This account has no groups.');
  if(!state.threads.some(t=>t.id===state.thread))state.thread=state.threads[0].id;
  $('accountName').textContent=state.user.name;
  $('personAvatar').textContent=state.user.avatar;
  $('headerUserAvatar').textContent=state.user.avatar;
  $('headerUserName').textContent=state.user.name;
  $('logoutBtn').onclick=async()=>{
    $('logoutBtn').disabled=true;
    try{await api('/api/auth/logout',{method:'POST',body:'{}'});document.body.classList.add('session-loading');
      localStorage.setItem('splitmate-auth-change',String(Date.now()));location.replace('/login');
    }catch(error){toast(error.message);$('logoutBtn').disabled=false;}
  };
  document.body.classList.remove('session-loading');
  $('composeForm').onsubmit=send;
  $('composer').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();$('composeForm').requestSubmit();}};
  $('exampleBtn').onclick=()=>{
    const peers=thread().members.filter(person=>person.id!==state.user.id).map(person=>person.name);
    $('composer').value=`@SplitMate I paid $96 for dinner with ${peers.join(' and ')}. Split equally.`;
    $('composer').focus();
  };
  $('backBtn').onclick=()=>$('shell').classList.remove('chat-open');
  const dialog=$('infoDialog');$('infoBtn').onclick=()=>dialog.showModal();$('closeInfo').onclick=()=>dialog.close();$('gotIt').onclick=()=>dialog.close();
  try {const config=await api('/api/config');$('modeLabel').textContent=config.aiEnabled?'✦ Gemini enabled.':'Rule-based demo · add API key for AI';}catch{}
  setThread(state.thread,false);
  setInterval(()=>{if(document.visibilityState==='visible')refresh().catch(()=>{});},2500);
  if('serviceWorker' in navigator)navigator.serviceWorker.register('/service-worker.js').catch(()=>{});
}
init().catch(error=>{console.error(error);toast(`Could not load app: ${error.message}`);});

window.addEventListener('storage',event=>{if(event.key==='splitmate-auth-change'){document.body.classList.add('session-loading');location.replace('/login');}});
window.addEventListener('pageshow',event=>{if(event.persisted){document.body.classList.add('session-loading');location.reload();}});
