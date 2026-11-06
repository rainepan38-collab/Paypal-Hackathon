import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
test('private account setup validates every password before writing and never echoes credentials',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'splitmate-accounts-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const filename=join(directory,'accounts.sqlite');
  const env={...process.env,NODE_ENV:'test',DB_PATH:filename,DOTENV_CONFIG_QUIET:'true',SESSION_TTL_HOURS:'8',SESSION_SECRET:randomBytes(48).toString('hex')};
  const first=randomBytes(5).toString('hex');const second=randomBytes(24).toString('hex');
  const invalid=spawnSync(process.execPath,['scripts/accounts.js','--stdin'],{env,input:JSON.stringify({Jimmy:first,Alex:'short'}),encoding:'utf8'});
  assert.equal(invalid.status,1);
  const db=new Database(filename);t.after(()=>db.close());
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE password_hash IS NOT NULL').get().n,0);
  const result=spawnSync(process.execPath,['scripts/accounts.js','--stdin'],{env,input:JSON.stringify({Jimmy:first,Alex:second,Sarah:randomBytes(24).toString('hex')}),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.ok(!result.stdout.includes(first));assert.ok(!result.stderr.includes(second));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE password_hash IS NOT NULL').get().n,3);
  assert.ok(await bcrypt.compare(first,db.prepare('SELECT password_hash FROM users WHERE username=?').get('jimmy').password_hash));
});
test('production startup refuses a missing session secret',()=>{
  const result=spawnSync(process.execPath,['src/server.js'],{env:{...process.env,NODE_ENV:'production',DB_PATH:':memory:',SESSION_SECRET:'',DOTENV_CONFIG_QUIET:'true'},encoding:'utf8'});
  assert.equal(result.status,1);assert.match(result.stderr,/SESSION_SECRET/);
});
