const CACHE='splitmate-mobile-auth-v3';
const staticAssets=['/assets/app.css','/assets/app.js','/assets/pay.css','/assets/pay.js','/assets/icon-192.png','/assets/icon-512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(staticAssets)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('splitmate-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==location.origin)return;
  if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/pay/')||url.pathname.startsWith('/webhooks/'))return;
  if(url.pathname.startsWith('/assets/'))event.respondWith(fetch(event.request).then(response=>{if(response.ok){const clone=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,clone));}return response;}).catch(()=>caches.match(event.request)));
});
