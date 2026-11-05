import { randomUUID } from 'node:crypto';
import { db, queries } from './db.js';

export const allowedActors = ['You', 'Alex', 'Sarah'];
const threads = [
  { id: 'weekend-crew', name: 'Weekend crew', initials: 'WC', color: '#d6efdf', subtitle: 'You, Alex, Sarah', emoji: '🍽️' },
  { id: 'roommates', name: 'Roommates', initials: 'RM', color: '#fce9ca', subtitle: 'You, Alex, Sarah', emoji: '🏠' }
];
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'text',
    expense_id TEXT,
    created_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_time ON chat_messages(thread_id, created_ms);
  CREATE TABLE IF NOT EXISTS chat_expenses (
    expense_id TEXT PRIMARY KEY REFERENCES expenses(id),
    thread_id TEXT NOT NULL
  );
`);
const findThread = threadId => threads.find(t => t.id === threadId) || null;
const rowCount = db.prepare('SELECT COUNT(*) as n FROM chat_messages').get().n;
if (!rowCount) {
  const now = Date.now() - 22 * 60 * 1000;
  const demoMessages = [
    ['weekend-crew', 'Sarah', 'Dinner was so good last night 🍜', 0],
    ['weekend-crew', 'Alex', 'Thanks for covering it! How much do we owe?', 60_000],
    ['weekend-crew', 'You', 'I can split the bill here with SplitMate 💚', 120_000],
    ['roommates', 'Alex', 'Can we settle the utilities this weekend?', 240_000],
    ['roommates', 'Sarah', 'Works for me!', 300_000]
  ];
  const stmt = db.prepare('INSERT INTO chat_messages(id,thread_id,sender,text,kind,expense_id,created_ms) VALUES(?,?,?,?,?,?,?)');
  db.transaction(() => demoMessages.forEach(([thread,sender,msg,offset]) => stmt.run(randomUUID(),thread,sender,msg,'text',null,now+offset)))();
}
export function addMessage(threadId, sender, text, kind = 'text', expenseId = null) {
  if (!findThread(threadId)) throw new Error('Unknown chat');
  const id = randomUUID();
  db.prepare('INSERT INTO chat_messages(id,thread_id,sender,text,kind,expense_id,created_ms) VALUES(?,?,?,?,?,?,?)')
    .run(id,threadId,sender,String(text || '').slice(0,1500),kind,expenseId,Date.now());
  return id;
}
export function getThread(id) { return findThread(id); }
export function listThreads() { return threads; }
export function getMessages(threadId, limit = 120) {
  if (!findThread(threadId)) return null;
  
  const rows = db.prepare(`SELECT *FROM (SELECT *
    FROM chat_messages
    WHERE thread_id = ?
    ORDER BY created_ms DESC, id DESC
    LIMIT ?)ORDER BY created_ms ASC, id ASC`).all(threadId, limit);

  return rows.map(m => {
    const result = { id:m.id, threadId:m.thread_id, sender:m.sender, text:m.text, kind:m.kind, createdAt:m.created_ms };
    if (m.expense_id) {
      const expense = queries.getExpense(m.expense_id);
      if (expense) {
        const names = [expense.organizer, ...JSON.parse(expense.owed_names_json)];
        const shareRows = queries.shares(expense.id);
        result.expense = {
          id: expense.id, organizer:expense.organizer, description:expense.description,
          totalCents:expense.total_cents, status:expense.status,
          names, shares: shareRows.map(s=>({person:s.person,amountCents:s.amount_cents,status:s.status,token:s.token}))
        };
      }
    }
    return result;
  });
}
export function linkExpense(expenseId,threadId) {
  db.prepare('INSERT INTO chat_expenses (expense_id,thread_id) VALUES (?,?)').run(expenseId,threadId);
}
export function threadForExpense(expenseId) {
  return db.prepare('SELECT thread_id FROM chat_expenses WHERE expense_id=?').get(expenseId)?.thread_id || null;
}
