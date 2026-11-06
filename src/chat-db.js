import { randomUUID } from 'node:crypto';
import { db, queries, publicUser } from './db.js';
export function members(threadId) {
  return db.prepare('SELECT u.* FROM group_members m JOIN users u ON u.id=m.user_id WHERE m.thread_id=? ORDER BY u.rowid').all(threadId);
}
export function isMember(threadId, userId) {
  return Boolean(db.prepare('SELECT 1 FROM group_members WHERE thread_id=? AND user_id=?').get(threadId, userId));
}
export function getThread(id) { return db.prepare('SELECT * FROM chat_groups WHERE id=?').get(id); }
export function listThreads(userId) {
  return db.prepare('SELECT g.* FROM chat_groups g JOIN group_members m ON m.thread_id=g.id WHERE m.user_id=? ORDER BY g.rowid').all(userId)
    .map(group => ({ ...group, members: members(group.id).map(publicUser), subtitle: members(group.id).map(user => user.display_name).join(', ') }));
}
if (!db.prepare('SELECT 1 FROM chat_messages LIMIT 1').get()) {
  const now = Date.now() - 22 * 60 * 1000;
  db.transaction(() => {
    [['weekend-crew','Sarah','Dinner was so good last night 🍜'], ['weekend-crew','Alex','Thanks for covering it! How much do we owe?'],
      ['weekend-crew','Jimmy','I can split the bill here with SplitMate 💚'], ['roommates','Alex','Can we settle the utilities this weekend?'],
      ['roommates','Sarah','Works for me!']].forEach(([thread,sender,text], index) => {
      const user = queries.userByName(sender);
      db.prepare('INSERT INTO chat_messages(id,thread_id,sender,sender_user_id,text,created_ms) VALUES(?,?,?,?,?,?)')
        .run(randomUUID(),thread,sender,user.id,text,now + index * 60_000);
    });
  })();
}
export function addMessage(threadId, sender, text, kind = 'text', expenseId = null, senderId = null) {
  if (!getThread(threadId)) throw new Error('Unknown chat');
  const id = randomUUID();
  db.prepare('INSERT INTO chat_messages(id,thread_id,sender,sender_user_id,text,kind,expense_id,created_ms) VALUES(?,?,?,?,?,?,?,?)')
    .run(id,threadId,sender,senderId,String(text || '').slice(0,1500),kind,expenseId,Date.now());
  return id;
}
export function getMessages(threadId, viewerId, limit = 120) {
  if (!isMember(threadId, viewerId)) return null;
  const rows = db.prepare(`SELECT * FROM (SELECT rowid sequence,* FROM chat_messages WHERE thread_id=?
    ORDER BY created_ms DESC,rowid DESC LIMIT ?) ORDER BY created_ms ASC,sequence ASC`).all(threadId, limit);
  return rows.map(message => {
    const result = { id:message.id, threadId:message.thread_id, sender:message.sender, senderId:message.sender_user_id,
      text:message.text, kind:message.kind, createdAt:message.created_ms };
    if (message.expense_id) {
      const expense = queries.getExpense(message.expense_id);
      if (expense) result.expense = {
        id:expense.id, organizer:expense.organizer, organizerId:expense.organizer_user_id, description:expense.description,
        totalCents:expense.total_cents, status:expense.status, names:[expense.organizer, ...JSON.parse(expense.owed_names_json)],
        shares:queries.shares(expense.id).map(share => ({ person:share.person, personId:share.person_user_id, amountCents:share.amount_cents,
          status:share.status, token: viewerId === share.person_user_id || viewerId === expense.organizer_user_id ? share.token : null }))
      };
    }
    return result;
  });
}
export function threadForExpense(id) { return db.prepare('SELECT thread_id FROM chat_expenses WHERE expense_id=?').get(id)?.thread_id || null; }
