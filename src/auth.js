import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, queries, publicUser } from './db.js';

const production = process.env.NODE_ENV === 'production';
let secret = process.env.SESSION_SECRET;
if (!secret || Buffer.byteLength(secret) < 32) {
  if (production) throw new Error('SESSION_SECRET must contain at least 32 bytes in production.');
  secret = randomBytes(48).toString('base64url');
  if (process.env.NODE_ENV !== 'test') console.warn('Using an ephemeral development session secret. Set SESSION_SECRET to keep sessions across restarts.');
}
const hours = Number(process.env.SESSION_TTL_HOURS || 8);
if (!Number.isFinite(hours) || hours <= 0 || hours > 168) throw new Error('SESSION_TTL_HOURS must be between 0 and 168.');
const lifetime = hours * 3_600_000;
const cookieName = 'splitmate.sid';
const digest = value => createHmac('sha256', secret).update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
// Unknown users still incur a bcrypt comparison; this value is never an account password.
const dummyHash = await bcrypt.hash(random(), 12);
const fail = (res, status, error) => res.status(status).json({ error });
function cookieOptions(req) { return { httpOnly: true, sameSite: 'lax', secure: production || req.secure, path: '/' }; }
function tokenFrom(req) {
  const value = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  return value && /^[\w-]{43}$/.test(value) ? value : null;
}
export function loadSession(req, res, next) {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_ms<=?').run(now);
  db.prepare('DELETE FROM login_limits WHERE expires_ms<=?').run(now);
  const token = tokenFrom(req);
  req.session = token ? db.prepare('SELECT * FROM sessions WHERE id_hash=? AND expires_ms>?').get(digest(token), now) : null;
  req.user = req.session?.user_id ? queries.user(req.session.user_id) : null;
  if (req.user && !req.user.password_hash) {
    db.prepare('DELETE FROM sessions WHERE id_hash=?').run(req.session.id_hash);
    req.session = null;
    req.user = null;
  }
  res.set('Cache-Control', 'no-store');
  next();
}
function newSession(req, res, userId = null) {
  const token = random();
  const session = { id_hash: digest(token), user_id: userId, csrf_token: random(), expires_ms: Date.now() + (userId ? lifetime : 15 * 60_000) };
  db.transaction(() => {
    if (req.session) db.prepare('DELETE FROM sessions WHERE id_hash=?').run(req.session.id_hash);
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(session.id_hash, session.user_id, session.csrf_token, session.expires_ms);
  })();
  res.cookie(cookieName, token, { ...cookieOptions(req), maxAge: session.expires_ms - Date.now() });
  req.session = session;
  return session;
}
export function requireAuth(req, res, next) {
  if (!req.user) return fail(res, 401, 'Please log in.');
  next();
}
export function requireCsrf(req, res, next) {
  const supplied = req.get('X-CSRF-Token');
  const expected = req.session?.csrf_token;
  if (!supplied || !expected || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return fail(res, 403, 'Session verification failed. Refresh and try again.');
  if (req.get('Sec-Fetch-Site') === 'cross-site') return fail(res, 403, 'Cross-site requests are not allowed.');
  const origin = req.get('Origin');
  const allowed = process.env.PUBLIC_BASE_URL ? new URL(process.env.PUBLIC_BASE_URL).origin : `${req.protocol}://${req.get('host')}`;
  if (origin && origin !== allowed) return fail(res, 403, 'Cross-site requests are not allowed.');
  next();
}
export function sessionIsCurrent(req) {
  return Boolean(req.user && req.session && db.prepare('SELECT 1 FROM sessions WHERE id_hash=? AND user_id=? AND expires_ms>?').get(req.session.id_hash, req.user.id, Date.now()));
}
const bucketKeys = req => [
  [digest(`ip:${req.ip}`), 30],
  [digest(`user:${String(req.body?.username || '').trim().toLowerCase().slice(0,80)}`), 8]
];
export function authRoutes(app) {
  app.get('/api/auth/session', (req,res) => {
    if (!req.session) newSession(req,res);
    res.json({ user: publicUser(req.user) || null, csrfToken: req.session.csrf_token, expiresAt: req.session.expires_ms });
  });
  app.post('/api/auth/login', requireCsrf, async (req,res) => {
    if (req.user) return fail(res,409,'Log out before switching accounts.');
    const buckets = bucketKeys(req);
    if (buckets.some(([key,limit]) => (db.prepare('SELECT attempts FROM login_limits WHERE bucket=?').get(key)?.attempts || 0) >= limit)) {
      res.set('Retry-After','900');
      return fail(res,429,'Too many login attempts. Try again in 15 minutes.');
    }
    // Count before awaiting bcrypt, so parallel attempts cannot bypass the limiter.
    for (const [key] of buckets) db.prepare(`INSERT INTO login_limits VALUES(?,1,?)
      ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1`).run(key,Date.now()+900_000);
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().slice(0,80) : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const user = queries.userByName(username);
    const validLength = Buffer.byteLength(password) >= 10 && Buffer.byteLength(password) <= 72;
    const valid = await bcrypt.compare(validLength ? password : '', user?.password_hash || dummyHash);
    if (!validLength || !valid || !user?.password_hash) return fail(res,401,'Invalid username or password.');
    // Logout, password reset, or a parallel login must invalidate this in-flight login.
    if (!db.prepare('SELECT 1 FROM sessions WHERE id_hash=? AND user_id IS NULL AND expires_ms>?').get(req.session.id_hash, Date.now()) ||
        queries.user(user.id)?.password_hash !== user.password_hash) return fail(res,409,'Login session changed. Refresh and try again.');
    const session = newSession(req,res,user.id);
    for (const [key] of buckets) db.prepare('UPDATE login_limits SET attempts=MAX(0,attempts-1) WHERE bucket=?').run(key);
    res.json({ user: publicUser(user), csrfToken: session.csrf_token, expiresAt: session.expires_ms });
  });
  app.post('/api/auth/logout', requireAuth, requireCsrf, (req,res) => {
    db.prepare('DELETE FROM sessions WHERE id_hash=?').run(req.session.id_hash);
    res.clearCookie(cookieName,cookieOptions(req));
    res.json({ ok:true });
  });
}
export function validatePassword(password) {
  if (typeof password !== 'string' || Buffer.byteLength(password) < 10 || Buffer.byteLength(password) > 72) throw new Error('Passwords must contain 10–72 UTF-8 bytes.');
}
export async function setPassword(userId, password) {
  validatePassword(password);
  const hash = await bcrypt.hash(password, 12);
  db.transaction(() => {
    if (!db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash,userId).changes) throw new Error('Unknown account');
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
  })();
}
