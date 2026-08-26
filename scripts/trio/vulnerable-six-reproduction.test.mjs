import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verify as vulnerableVerify,SLOT_NAMES} from './fixtures/vulnerable-trio-001c-c29223d2649bff467/verify-runtime-parity.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const retained=path.join(here,'fixtures/vulnerable-trio-001c-c29223d2649bff467');
const write=(file,data,mode)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);if(mode!==undefined)fs.chmodSync(file,mode);};
const git=(root,args)=>cp.execFileSync('git',args,{cwd:root,stdio:'ignore'});
function setup(){
  const top=fs.mkdtempSync(path.join(os.tmpdir(),'trio-001d-vulnerable-')),governance=path.join(top,'governance');fs.mkdirSync(governance);
  fs.cpSync(path.join(retained,'schemas'),path.join(governance,'schemas'),{recursive:true});
  const manifest=JSON.parse(fs.readFileSync(path.join(retained,'boundary-manifest.json'),'utf8')),manifestPath=path.join(governance,'boundary-manifest.json');write(manifestPath,JSON.stringify(manifest));
  const slots={};for(const slot of SLOT_NAMES){const root=path.join(top,slot),spec=manifest.repositories[slot];slots[slot]=root;fs.mkdirSync(root);
    write(path.join(root,'package.json'),JSON.stringify({name:spec.packageNames['package.json'],description:slot,version:'0.0.0',private:true,type:'module',scripts:{},dependencies:{},devDependencies:{}}));
    write(path.join(root,'tui/package.json'),JSON.stringify({name:spec.packageNames['tui/package.json'],description:slot,version:'0.0.0',private:true,type:'module',scripts:{},dependencies:{},devDependencies:{}}));
    fs.mkdirSync(path.join(root,'trio/capsules'),{recursive:true});for(const name of fs.readdirSync(path.join(retained,'capsules')))fs.cpSync(path.join(retained,'capsules',name),path.join(root,'trio/capsules',name),{recursive:false});
    write(path.join(root,'trio/boundary-manifest.json'),JSON.stringify(manifest));
    git(root,['init','-q']);git(root,['config','user.email','fixture@example.invalid']);git(root,['config','user.name','fixture']);git(root,['remote','add','origin',`https://github.com/RootZ3n/${slot}.git`]);git(root,['add','.']);git(root,['commit','-qm','fixture']);
  }
  return {top,slots,manifestPath};
}
const run=(f)=>vulnerableVerify({slots:f.slots,manifestPath:f.manifestPath});
const green=(result)=>{assert.equal(result.status,'VERIFIER_OK_PARITY');assert.equal(result.summary.verdict,'PARITY');assert.equal(result.summary.blockingCount,0);};
const attack=(name,mutate)=>test(`retained vulnerable TRIO-001C false green: ${name}`,()=>{const f=setup();try{green(run(f));mutate(f);green(run(f));}finally{fs.rmSync(f.top,{recursive:true,force:true});}});

attack('prototype mutation through schema input',(f)=>{
  const normal=JSON.parse(fs.readFileSync(path.join(retained,'capsules/loony-luna.json'),'utf8'));
  write(path.join(f.slots['loony-luna'],'trio/capsules/loony-luna.json'),`{"__proto__":${JSON.stringify(normal)}}`);
});
attack('variable capsule mode mismatch despite modeMustMatch',(f)=>fs.chmodSync(path.join(f.slots['loony-luna'],'trio/capsules/loony-luna.json'),0o600));
attack('newly inherited variable Markdown containing active content',(f)=>write(path.join(f.slots['loony-luna'],'docs/new-active.md'),'<script>globalThis.compromised=true</script>\n'));
attack('generated server JavaScript hidden under excluded .next',(f)=>{write(path.join(f.slots.pehlichi,'.next/server/route.js'),'safe()');write(path.join(f.slots['loony-luna'],'.next/server/route.js'),'unsafe()');});
attack('browser JavaScript hidden under excluded coverage',(f)=>{write(path.join(f.slots.pehlichi,'coverage/browser.js'),'safe()');write(path.join(f.slots['mad-ptah'],'coverage/browser.js'),'unsafe()');});
attack('PNG-signature polyglot accepted as inert variable asset',(f)=>{const sig=Buffer.from([137,80,78,71,13,10,26,10]);for(const [i,root] of Object.values(f.slots).entries())write(path.join(root,'peh-hedge-knight.png'),Buffer.concat([sig,Buffer.from(`<script>attack${i}()</script>`)]));});
