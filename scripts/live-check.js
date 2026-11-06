import 'dotenv/config';
import { parseExpense } from '../src/ai.js';
import { demoUsers } from '../src/migrations.js';
const members=demoUsers.map(user=>({...user,display_name:user.name}));
let failed=false;
if(!process.env.GEMINI_API_KEY)console.log('Gemini live check skipped: no key configured.');
else {
  for(const [index,total] of [[0,96],[1,32],[2,60]]){
    const organizer=members[index];const peers=members.filter(user=>user.id!==organizer.id);
    try{
      const result=await parseExpense(`I paid $${total} for dinner with ${peers.map(user=>user.display_name).join(' and ')}. Split equally.`,{organizer,members});
      if(result.totalCents!==total*100 || result.owedNames.length!==2 || peers.some(user=>!result.owedNames.includes(user.display_name)))throw new Error('Extracted participants/amount did not match the sample.');
      console.log(`Gemini live check passed for ${organizer.display_name}: ${result.totalCents} cents, ${result.owedNames.join(', ')}.`);
    }catch(error){console.log(`Gemini live check failed: ${error.message}`);failed=true;break;}
  }
}
if(!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET)console.log('PayPal live check skipped: no Sandbox credentials configured.');
else if((process.env.PAYPAL_API_BASE||'https://api-m.sandbox.paypal.com')!=='https://api-m.sandbox.paypal.com'){
  console.log('PayPal live check refused: this check accepts the standard Sandbox API only.');failed=true;
}else{
  try{
    const response=await fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token',{
      method:'POST',signal:AbortSignal.timeout(15_000),headers:{Authorization:`Basic ${Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials'
    });
    const data=await response.json();
    if(!response.ok || !data.access_token){console.log(`PayPal Sandbox OAuth failed (HTTP ${response.status}).`);failed=true;}
    else console.log('PayPal Sandbox OAuth passed. No order or capture was created.');
  }catch{console.log('PayPal Sandbox OAuth request failed (network or timeout).');failed=true;}
}
if(failed)process.exitCode=1;
