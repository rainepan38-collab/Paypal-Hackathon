const form = document.getElementById('loginForm');
const message = document.getElementById('loginMessage');
const button = document.getElementById('loginButton');
let csrfToken;
async function loadSession() {
  const response = await fetch('/api/auth/session',{cache:'no-store'});
  if (!response.ok) throw new Error('Could not connect. Refresh and try again.');
  const session = await response.json();
  csrfToken = session.csrfToken;
  return session;
}
function destination() {
  const next = new URLSearchParams(location.search).get('next');
  return next && /^\/pay\/[A-Za-z0-9_-]+$/.test(next) ? next : '/';
}
form.addEventListener('submit',async event => {
  event.preventDefault();
  button.disabled = true;
  message.textContent = '';
  try {
    if (!csrfToken) await loadSession();
    const response = await fetch('/api/auth/login',{
      method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},
      body:JSON.stringify({username:form.elements.username.value.trim(),password:form.elements.password.value})
    });
    const result = await response.json();
    form.elements.password.value = '';
    if (!response.ok) {
      if (response.status === 403) await loadSession();
      throw new Error(result.error || 'Sign in failed.');
    }
    localStorage.setItem('splitmate-auth-change',String(Date.now()));
    location.replace(destination());
  } catch(error) { message.textContent = error.message; }
  finally { button.disabled = false; }
});
loadSession().then(session => { if (session.user) location.replace(destination()); }).catch(error => { message.textContent = error.message; }).finally(() => { button.disabled = false; });
