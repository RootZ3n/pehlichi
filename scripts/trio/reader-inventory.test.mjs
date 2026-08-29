import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));const inventory=JSON.parse(fs.readFileSync(path.join(here,'reader-inventory.json'),'utf8'));
test('every production repository-capable reader and subprocess is classified',()=>{
  const sources=new Map(inventory.scope.map((file)=>[file,fs.readFileSync(path.join(here,file),'utf8')]));
  for(const [file,source] of sources){const lines=source.split('\n');
    for(const line of lines){if(/fs\.(?:readFileSync|readFile|openSync|open|createReadStream)|fs\.promises\.readFile/.test(line))assert.ok(inventory.readers.some((r)=>r.file===file&&line.includes(r.contains)),`${file}: undocumented reader: ${line.trim()}`);if(/cp\.(?:spawnSync|execFileSync|execSync)/.test(line))assert.ok(inventory.subprocesses.some((r)=>r.file===file&&line.includes(r.contains)),`${file}: undocumented subprocess: ${line.trim()}`);}
    for(const match of source.matchAll(/from\s+['"]\.\/([^'"]+\.mjs)['"]/g))assert.ok(sources.has(match[1]),`${file}: imported production module is outside inventory scope: ${match[1]}`);
  }
  for(const record of [...inventory.readers,...inventory.subprocesses])assert.ok(sources.get(record.file)?.includes(record.contains),`${record.file}: stale inventory entry: ${record.contains}`);
  const verifier=sources.get('verify-runtime-parity.mjs');assert.doesNotMatch(verifier,/\breadStrictJson\s*\(|\.validateFile\s*\(/);
  assert.deepEqual(inventory.readers.map((r)=>r.class),['governed-descriptor-open','governed-descriptor-read']);
});
