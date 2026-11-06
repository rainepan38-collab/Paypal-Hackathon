import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const demoUsers = [
  { id: 'user-jimmy', username: 'jimmy', name: 'Jimmy' },
  { id: 'user-alex', username: 'alex', name: 'Alex' },
  { id: 'user-sarah', username: 'sarah', name: 'Sarah' }
];
export const demoGroups = [
  { id: 'weekend-crew', name: 'Weekend crew', initials: 'WC', color: '#d6efdf', emoji: '🍽️' },
  { id: 'roommates', name: 'Roommates', initials: 'RM', color: '#fce9ca', emoji: '🏠' }
];
export async function backupDatabase(db, filename) {
  if (filename === ':memory:') return null;
  const directory = join(dirname(filename), 'backups');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `splitmate-${Date.now()}-${randomUUID()}.sqlite`);
  await db.backup(target);
  chmodSync(target, 0o600);
  return target;
}
export async function migrateDatabase(db, filename) {
  const hasTable = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  if (hasTable('schema_migrations') && db.prepare('SELECT 1 FROM schema_migrations WHERE version=1').get()) return null;
  const backup = hasTable('expenses') ? await backupDatabase(db, filename) : null;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS expenses (
        id TEXT PRIMARY KEY, organizer TEXT NOT NULL, description TEXT NOT NULL,
        total_cents INTEGER NOT NULL, owed_names_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS shares (
        id TEXT PRIMARY KEY, expense_id TEXT NOT NULL REFERENCES expenses(id), person TEXT NOT NULL,
        amount_cents INTEGER NOT NULL, token TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'unpaid',
        paypal_order_id TEXT UNIQUE, paypal_capture_id TEXT UNIQUE, paid_at TEXT
      );
      CREATE TABLE IF NOT EXISTS received_messages (id TEXT PRIMARY KEY, received_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS paypal_webhook_events (id TEXT PRIMARY KEY, processed_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'text', expense_id TEXT, created_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_time ON chat_messages(thread_id, created_ms);
      CREATE TABLE IF NOT EXISTS chat_expenses (expense_id TEXT PRIMARY KEY REFERENCES expenses(id), thread_id TEXT NOT NULL);
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL, password_hash TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE user_aliases (alias TEXT PRIMARY KEY COLLATE NOCASE, user_id TEXT NOT NULL REFERENCES users(id));
      CREATE TABLE chat_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, initials TEXT NOT NULL, color TEXT NOT NULL, emoji TEXT NOT NULL);
      CREATE TABLE group_members (
        thread_id TEXT NOT NULL REFERENCES chat_groups(id), user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(thread_id,user_id)
      );
      CREATE TABLE expense_participants (
        expense_id TEXT NOT NULL REFERENCES expenses(id), user_id TEXT NOT NULL REFERENCES users(id), position INTEGER NOT NULL,
        PRIMARY KEY(expense_id,user_id), UNIQUE(expense_id,position)
      );
      CREATE TABLE sessions (
        id_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), csrf_token TEXT NOT NULL, expires_ms INTEGER NOT NULL
      );
      CREATE INDEX idx_sessions_expiry ON sessions(expires_ms);
      CREATE TABLE login_limits (bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_ms INTEGER NOT NULL);
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      ALTER TABLE expenses ADD COLUMN organizer_user_id TEXT REFERENCES users(id);
      ALTER TABLE shares ADD COLUMN person_user_id TEXT REFERENCES users(id);
      ALTER TABLE chat_messages ADD COLUMN sender_user_id TEXT REFERENCES users(id);
    `);
    for (const user of demoUsers) {
      db.prepare('INSERT INTO users(id,username,display_name) VALUES(?,?,?)').run(user.id, user.username, user.name);
      db.prepare('INSERT INTO user_aliases(alias,user_id) VALUES(?,?)').run(user.username, user.id);
    }
    db.prepare('INSERT INTO user_aliases(alias,user_id) VALUES(?,?)').run('you', 'user-jimmy');
    for (const group of demoGroups) {
      db.prepare('INSERT INTO chat_groups VALUES(?,?,?,?,?)').run(group.id, group.name, group.initials, group.color, group.emoji);
      for (const user of demoUsers) db.prepare('INSERT INTO group_members VALUES(?,?)').run(group.id, user.id);
    }
    const identity = name => db.prepare(`SELECT u.id,u.display_name FROM user_aliases a JOIN users u ON u.id=a.user_id WHERE a.alias=?`).get(String(name).trim());
    // Change structured identity fields only; retain IDs, amounts, tokens and user-written text.
    for (const expense of db.prepare('SELECT * FROM expenses').all()) {
      const organizer = identity(expense.organizer);
      const owed = JSON.parse(expense.owed_names_json);
      if (!Array.isArray(owed)) throw new Error('Invalid legacy participants; inspect the backup before migrating.');
      db.prepare('UPDATE expenses SET organizer=?,organizer_user_id=?,owed_names_json=? WHERE id=?').run(
        organizer?.display_name || expense.organizer, organizer?.id || null,
        JSON.stringify(owed.map(name => identity(name)?.display_name || name)), expense.id
      );
      [expense.organizer, ...owed].forEach((name, position) => {
        const user = identity(name);
        if (user) db.prepare('INSERT OR IGNORE INTO expense_participants VALUES(?,?,?)').run(expense.id, user.id, position);
      });
    }
    for (const [table, column, idColumn] of [['shares','person','person_user_id'], ['chat_messages','sender','sender_user_id']]) {
      for (const row of db.prepare(`SELECT id,${column} name FROM ${table}`).all()) {
        const user = identity(row.name);
        if (user) db.prepare(`UPDATE ${table} SET ${column}=?,${idColumn}=? WHERE id=?`).run(user.display_name, user.id, row.id);
      }
    }
    db.prepare("UPDATE chat_messages SET text='Jimmy' || substr(text,4) WHERE sender='SplitMate' AND kind='payment_update' AND text LIKE 'You''s %'").run();
    db.prepare('INSERT INTO schema_migrations(version) VALUES(1)').run();
  })();
  return backup;
}
