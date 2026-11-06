import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for (const directory of ['src','public','scripts','tests']) {
  for (const file of readdirSync(directory).filter(name=>/\.m?js$/.test(name))) {
    const result=spawnSync(process.execPath,['--check',`${directory}/${file}`],{stdio:'inherit'});
    if(result.status!==0)process.exit(result.status||1);
  }
}
console.log('JavaScript syntax checks passed.');
