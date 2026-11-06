import 'dotenv/config';
import { db, queries } from '../src/db.js';
import { setPassword, validatePassword } from '../src/auth.js';

function hiddenPrompt(label) {
  if (!process.stdin.isTTY) throw new Error('Use an interactive terminal, or --stdin with private JSON from a secret manager.');
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve,reject) => {
    let value = '';
    const finish = (error) => {
      process.stdin.removeListener('data',onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      error ? reject(error) : resolve(value);
    };
    const onData = chunk => {
      for (const character of chunk.toString()) {
        if (character === '\u0003') return finish(new Error('Cancelled.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') value = Array.from(value).slice(0,-1).join('');
        else if (character >= ' ') value += character;
      }
    };
    process.stdin.on('data',onData);
  });
}
try {
  const args = process.argv.slice(2);
  let entries = [];
  if (args[0] === '--stdin' && args.length === 1) {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 4096) throw new Error('Input too large.');
    }
    let data;
    try { data = JSON.parse(input); } catch { throw new Error('Expected a JSON object mapping usernames to passwords.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a JSON object.');
    entries = Object.entries(data);
  } else {
    if (args.length > 1 || (args[0] && !['jimmy','alex','sarah'].includes(args[0].toLowerCase()))) throw new Error('Usage: npm run accounts -- [Jimmy|Alex|Sarah|--stdin]');
    for (const username of args.length ? args : ['jimmy','alex','sarah']) {
      const user = queries.userByName(username);
      const password = await hiddenPrompt(`New password for ${user.display_name} (10–72 UTF-8 bytes): `);
      const confirmation = await hiddenPrompt('Confirm password: ');
      if (password !== confirmation) throw new Error('Passwords do not match. No accounts were changed.');
      entries.push([username,password]);
    }
  }
  if (!entries.length || entries.length > 3) throw new Error('Specify 1–3 accounts.');
  const accounts = entries.map(([username,password]) => {
    const user = queries.userByName(username);
    if (!user) throw new Error('Only Jimmy, Alex and Sarah accounts can be configured.');
    validatePassword(password);
    return {user,password};
  });
  for (const {user,password} of accounts) {
    await setPassword(user.id,password);
    console.log(`Password set for ${user.display_name}; existing sessions revoked.`);
  }
} catch (error) {
  // Never include supplied input, hashes or password values in output.
  console.error(error instanceof SyntaxError ? 'Invalid input.' : error.message);
  process.exitCode = 1;
} finally { db.close(); }
