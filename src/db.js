import Database from 'better-sqlite3';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const filename = resolve(process.env.DB_PATH || './data/splitmate.sqlite');
mkdirSync(dirname(filename), { recursive: true });
export const db = new Database(filename);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  organizer TEXT NOT NULL,
  description TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  owed_names_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL REFERENCES expenses(id),
  person TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  token TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'unpaid',
  paypal_order_id TEXT UNIQUE,
  paypal_capture_id TEXT UNIQUE,
  paid_at TEXT
);
CREATE TABLE IF NOT EXISTS received_messages (id TEXT PRIMARY KEY, received_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS paypal_webhook_events (id TEXT PRIMARY KEY, processed_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);
export const queries = {
  claimMessage(id) { return db.prepare('INSERT OR IGNORE INTO received_messages(id) VALUES (?)').run(id).changes === 1; },
  createDraft(organizer, description, totalCents, owedNames) {
    db.prepare("UPDATE expenses SET status='cancelled' WHERE organizer=? AND status='draft'").run(organizer);
    const id = randomUUID();
    db.prepare('INSERT INTO expenses (id,organizer,description,total_cents,owed_names_json) VALUES (?,?,?,?,?)')
      .run(id, organizer, description, totalCents, JSON.stringify(owedNames));
    return this.getExpense(id);
  },
  getExpense(id) { return db.prepare('SELECT * FROM expenses WHERE id=?').get(id); },
  latestDraft(organizer) { return db.prepare("SELECT * FROM expenses WHERE organizer=? AND status='draft' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(organizer); },
  latestConfirmed(organizer) { return db.prepare("SELECT * FROM expenses WHERE organizer=? AND status='confirmed' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(organizer); },
  shares(expenseId) { return db.prepare('SELECT * FROM shares WHERE expense_id=? ORDER BY rowid').all(expenseId); },
  byToken(token) { return db.prepare(`SELECT s.*,e.description,e.organizer FROM shares s JOIN expenses e ON e.id=s.expense_id WHERE s.token=? AND e.status='confirmed'`).get(token); },
  byOrderId(id) { return db.prepare('SELECT * FROM shares WHERE paypal_order_id=?').get(id); },
  confirm(organizer, id, breakdown) {
    return db.transaction(() => {
      const e = this.getExpense(id);
      if (!e || e.organizer !== organizer || e.status !== 'draft') return null;
      db.prepare("UPDATE expenses SET status='confirmed' WHERE id=? AND status='draft'").run(id);
      for (const s of breakdown.filter(x => x.name !== organizer)) {
        db.prepare('INSERT INTO shares(id,expense_id,person,amount_cents,token) VALUES (?,?,?,?,?)')
          .run(randomUUID(), id, s.name, s.amountCents, randomBytes(24).toString('base64url'));
      }
      return this.shares(id);
    })();
  },
  setOrder(shareId, orderId) {
    const update = db.prepare("UPDATE shares SET paypal_order_id=? WHERE id=? AND paypal_order_id IS NULL AND status='unpaid'").run(orderId, shareId);
    return update.changes === 1;
  },
  markPaidByOrder(orderId, captureId) {
    const share = this.byOrderId(orderId);
    if (!share) return null;
    const result = db.prepare("UPDATE shares SET status='paid',paypal_capture_id=?,paid_at=CURRENT_TIMESTAMP WHERE id=? AND status='unpaid'")
      .run(captureId, share.id);
    return result.changes ? { ...share, status: 'paid' } : null;
  },
  claimPayPalEvent(id) { return db.prepare('INSERT OR IGNORE INTO paypal_webhook_events(id) VALUES (?)').run(id).changes === 1; }
};
