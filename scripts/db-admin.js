import 'dotenv/config';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { backupDatabase } from '../src/migrations.js';
const command = process.argv[2];
if (command === 'migrate') {
  const { db, migrationBackup } = await import('../src/db.js');
  console.log(migrationBackup ? 'Migration applied with a backup.' : 'Database already current (or newly initialized).');
  db.close();
} else if (command === 'backup') {
  const filename = resolve(process.env.DB_PATH || './data/splitmate.sqlite');
  const db = new Database(filename, { readonly:true, fileMustExist:true });
  try { console.log(`Private SQLite backup: ${await backupDatabase(db,filename)}`); } finally { db.close(); }
} else { console.error('Use db:backup or db:migrate.'); process.exitCode = 1; }
