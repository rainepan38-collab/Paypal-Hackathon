import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateDatabase } from '../src/migrations.js';

function legacy(t, malformed=false){
  const directory=mkdtempSync(join(tmpdir(),'splitmate-migration-'));
  const filename=join(directory,'legacy.sqlite');
  const db=new Database(filename);
  db.pragma('journal_mode=WAL');db.pragma('foreign_keys=ON');
  t.after(()=>{db.close();rmSync(directory,{recursive:true,force:true});});
  db.exec(`
    CREATE TABLE expenses(id TEXT PRIMARY KEY,organizer TEXT NOT NULL,description TEXT NOT NULL,total_cents INTEGER NOT NULL,owed_names_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE shares(id TEXT PRIMARY KEY,expense_id TEXT REFERENCES expenses(id),person TEXT,amount_cents INTEGER,token TEXT UNIQUE,status TEXT,paypal_order_id TEXT UNIQUE,paypal_capture_id TEXT UNIQUE,paid_at TEXT);
    CREATE TABLE chat_messages(id TEXT PRIMARY KEY,thread_id TEXT,sender TEXT,text TEXT,kind TEXT,expense_id TEXT,created_ms INTEGER);
    CREATE TABLE chat_expenses(expense_id TEXT PRIMARY KEY REFERENCES expenses(id),thread_id TEXT);
    CREATE TABLE paypal_webhook_events(id TEXT PRIMARY KEY,processed_at TEXT);
    INSERT INTO expenses VALUES('e-jimmy','You','dinner',9600,'["Alex","Sarah"]','confirmed','original-date');
    INSERT INTO expenses VALUES('e-alex','Alex','groceries',3200,'["You","Sarah"]','draft','original-date');
    INSERT INTO shares VALUES('s-1','e-jimmy','Sarah',3200,'original-token','paid','original-order','original-capture','original-paid-at');
    INSERT INTO shares VALUES('s-legacy','e-alex','You',1067,'legacy-token','unpaid',NULL,NULL,NULL);
    INSERT INTO chat_messages VALUES('m-1','weekend-crew','You','You said you would pay; I paid with You and Sarah.','text',NULL,1);
    INSERT INTO chat_messages VALUES('m-2','weekend-crew','Alex','Thank you!','text','e-alex',2);
    INSERT INTO chat_messages VALUES('m-3','weekend-crew','SplitMate','You''s $10.67 sandbox payment was confirmed.','payment_update','e-alex',3);
    INSERT INTO chat_expenses VALUES('e-jimmy','weekend-crew');
    INSERT INTO chat_expenses VALUES('e-alex','weekend-crew');
    INSERT INTO paypal_webhook_events VALUES('old-event','original-time');
  `);
  if(malformed)db.prepare('UPDATE expenses SET owed_names_json=? WHERE id=?').run('broken JSON','e-alex');
  return {db,filename,directory};
}
test('migration backs up committed WAL data and preserves identities, history and payment relationships',async t=>{
  const {db,filename}=legacy(t);
  const shares=db.prepare('SELECT * FROM shares').all();
  const backup=await migrateDatabase(db,filename);
  const old=new Database(backup,{readonly:true});
  assert.equal(old.prepare('SELECT organizer FROM expenses WHERE id=?').get('e-jimmy').organizer,'You');
  assert.deepEqual(old.prepare('SELECT * FROM shares').all(),shares);old.close();
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  const jimmy=db.prepare('SELECT * FROM users WHERE username=?').get('jimmy');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n,3);
  assert.equal(jimmy.password_hash,null);
  assert.equal(db.prepare('SELECT user_id FROM user_aliases WHERE alias=?').get('You').user_id,jimmy.id);
  assert.equal(db.prepare('SELECT organizer_user_id FROM expenses WHERE id=?').get('e-jimmy').organizer_user_id,jimmy.id);
  assert.equal(db.prepare('SELECT owed_names_json FROM expenses WHERE id=?').get('e-alex').owed_names_json,'["Jimmy","Sarah"]');
  const migrated=db.prepare('SELECT * FROM shares WHERE id=?').get('s-1');
  for(const [key,value] of Object.entries(shares[0]))assert.equal(migrated[key],value);
  assert.equal(db.prepare('SELECT person_user_id FROM shares WHERE id=?').get('s-legacy').person_user_id,jimmy.id);
  const message=db.prepare('SELECT * FROM chat_messages WHERE id=?').get('m-1');
  assert.equal(message.sender,'Jimmy');assert.equal(message.sender_user_id,jimmy.id);
  assert.equal(message.text,'You said you would pay; I paid with You and Sarah.');
  assert.match(db.prepare('SELECT text FROM chat_messages WHERE id=?').get('m-3').text,/^Jimmy's/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM chat_messages').get().n,3);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM chat_expenses').get().n,2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM paypal_webhook_events').get().n,1);
});
test('migration is idempotent and stable IDs survive reopening',async t=>{
  const {db,filename,directory}=legacy(t);
  await migrateDatabase(db,filename);
  const before=db.prepare('SELECT * FROM users').all();
  assert.equal(await migrateDatabase(db,filename),null);
  const reopened=new Database(filename);
  assert.equal(await migrateDatabase(reopened,filename),null);
  assert.deepEqual(reopened.prepare('SELECT * FROM users').all(),before);reopened.close();
  assert.equal(readdirSync(join(directory,'backups')).length,1);
});
test('malformed legacy data rolls back the full migration and retains a usable backup',async t=>{
  const {db,filename,directory}=legacy(t,true);
  await assert.rejects(migrateDatabase(db,filename));
  assert.equal(db.prepare('SELECT organizer FROM expenses WHERE id=?').get('e-jimmy').organizer,'You');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='users'").get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shares').get().n,2);
  assert.equal(readdirSync(join(directory,'backups')).length,1);
});
