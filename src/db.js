import Database from 'better-sqlite3';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { migrateDatabase } from './migrations.js';
import { equalSplit } from './split.js';

export const filename = process.env.DB_PATH === ':memory:' ? ':memory:' : resolve(process.env.DB_PATH || './data/splitmate.sqlite');
if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
export const db = new Database(filename);
db.pragma('foreign_keys = ON');
export const migrationBackup = await migrateDatabase(db, filename);
db.pragma('journal_mode = WAL');
if (filename !== ':memory:') chmodSync(filename, 0o600);
if (migrationBackup) console.log(`Identity migration completed; private backup: ${migrationBackup}`);
export const publicUser = user => user && ({ id: user.id, username: user.username, name: user.display_name, avatar: user.display_name[0] });
export const queries = {
  user(id) { return db.prepare('SELECT * FROM users WHERE id=?').get(id); },
  userByName(username) { return db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(username); },
  createDraft(organizer, threadId, description, totalCents, owedUsers) {
    return db.transaction(() => {
      const participants = [organizer, ...owedUsers];
      if (new Set(participants.map(user => user.id)).size !== participants.length || participants.length < 2 || participants.length > 10) throw new Error('Invalid expense participants');
      for (const user of participants) {
        if (!db.prepare('SELECT 1 FROM group_members WHERE thread_id=? AND user_id=?').get(threadId, user.id)) throw new Error('Expense participants must belong to this group');
      }
      equalSplit(totalCents, participants.map(user => user.display_name));
      db.prepare(`UPDATE expenses SET status='cancelled' WHERE organizer_user_id=? AND status='draft'
        AND id IN (SELECT expense_id FROM chat_expenses WHERE thread_id=?)`).run(organizer.id, threadId);
      const id = randomUUID();
      db.prepare('INSERT INTO expenses(id,organizer,organizer_user_id,description,total_cents,owed_names_json) VALUES(?,?,?,?,?,?)')
        .run(id, organizer.display_name, organizer.id, description, totalCents, JSON.stringify(owedUsers.map(user => user.display_name)));
      participants.forEach((user, index) => db.prepare('INSERT INTO expense_participants VALUES(?,?,?)').run(id, user.id, index));
      db.prepare('INSERT INTO chat_expenses VALUES(?,?)').run(id, threadId);
      return this.getExpense(id);
    })();
  },
  getExpense(id) { return db.prepare('SELECT * FROM expenses WHERE id=?').get(id); },
  participants(id) { return db.prepare('SELECT u.* FROM expense_participants p JOIN users u ON u.id=p.user_id WHERE p.expense_id=? ORDER BY p.position').all(id); },
  shares(id) { return db.prepare('SELECT * FROM shares WHERE expense_id=? ORDER BY rowid').all(id); },
  byToken(token) { return db.prepare(`SELECT s.*,e.description,e.organizer,e.organizer_user_id,c.thread_id
    FROM shares s JOIN expenses e ON e.id=s.expense_id JOIN chat_expenses c ON c.expense_id=e.id
    WHERE s.token=? AND e.status='confirmed'`).get(token); },
  byOrderId(id) { return db.prepare('SELECT * FROM shares WHERE paypal_order_id=?').get(id); },
  confirm(organizerId, id) {
    return db.transaction(() => {
      const expense = this.getExpense(id);
      if (!expense || expense.organizer_user_id !== organizerId || expense.status !== 'draft') return null;
      const participants = this.participants(id);
      const threadId = db.prepare('SELECT thread_id FROM chat_expenses WHERE expense_id=?').get(id)?.thread_id;
      if (!threadId || participants.some(user => !db.prepare('SELECT 1 FROM group_members WHERE thread_id=? AND user_id=?').get(threadId,user.id))) {
        throw new Error('All expense participants must still belong to this group.');
      }
      const expected = [expense.organizer, ...JSON.parse(expense.owed_names_json)];
      if (participants.length !== expected.length || participants[0]?.id !== organizerId ||
          participants.some((user, index) => user.display_name !== expected[index])) throw new Error('Please create a new split using current group member names.');
      const breakdown = equalSplit(expense.total_cents, participants.map(user => user.display_name));
      db.prepare("UPDATE expenses SET status='confirmed' WHERE id=?").run(id);
      participants.slice(1).forEach((user, index) => {
        db.prepare('INSERT INTO shares(id,expense_id,person,person_user_id,amount_cents,token) VALUES(?,?,?,?,?,?)')
          .run(randomUUID(), id, user.display_name, user.id, breakdown[index + 1].amountCents, randomBytes(24).toString('base64url'));
      });
      return this.shares(id);
    })();
  },
  setOrder(shareId, orderId) {
    return db.prepare("UPDATE shares SET paypal_order_id=? WHERE id=? AND paypal_order_id IS NULL AND status='unpaid'").run(orderId, shareId).changes === 1;
  },
  markPaidByOrder(orderId, captureId) {
    const share = this.byOrderId(orderId);
    if (!share) return null;
    const result = db.prepare("UPDATE shares SET status='paid',paypal_capture_id=?,paid_at=CURRENT_TIMESTAMP WHERE id=? AND status='unpaid'").run(captureId, share.id);
    return result.changes ? { ...share, status: 'paid' } : null;
  },
  claimPayPalEvent(id) { return db.prepare('INSERT OR IGNORE INTO paypal_webhook_events(id) VALUES (?)').run(id).changes === 1; }
};
