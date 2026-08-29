/**
 * Credential read boundary: zero attempted reads, by filesystem identity.
 *
 * The earlier credential suite watched *pathnames*, so it proved only that the verifier
 * never opened a file called `.env`. An independent audit showed that was the wrong
 * question: a hard link gives the same inode a second, innocent-looking name, and the
 * verifier read it -- and its secondary agent-owned pass reached an unguarded reader that
 * swallowed the resulting error and let PARITY be published anyway.
 *
 * These tests watch the *object*. Every fixture secret is a disposable dummy sentinel, and
 * the trap resolves each read target to its device/inode before allowing the call through,
 * so an alias is caught no matter which name reached it or in what order it was walked.
 *
 * Any attempted read of a guarded object is a failure of this suite even if the verifier
 * would have recovered, because "we tried to open the credential and coped" is not the
 * property being claimed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verify,publishedResult,SLOT_NAMES } from './verify-runtime-parity.mjs';
import { readStrictJson as refusedPathParser,parseStrictJsonText } from './strict-json.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));const projectRoot=path.resolve(here,'../..');
const readStrictJson=(file)=>parseStrictJsonText(fs.readFileSync(file,'utf8'));
const write=(p,s,mode)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s);if(mode!==undefined)fs.chmodSync(p,mode);};
const git=(root,args)=>cp.execFileSync('git',args,{cwd:root,stdio:'ignore'});
const capsule=(id)=>({$schema:'../schemas/capsule.schema.json',schemaVersion:'1.1.0',status:'characterization',identity:{id,displayName:id,role:'fixture'},personalityRef:`personality/${id}.yaml`,skills:[],capabilityPacks:{requested:[],inactive:[]},routingPreferences:[],modelDefaults:{providerRef:'fixture',model:'fixture'},memoryNamespace:id,branding:{themeRef:'tui/skin.yaml',icon:'x',welcomeRef:`personality/${id}.yaml`},completion:{criteriaRefs:[],reportFormatRefs:[]}});

/** Never a real credential. If this string is ever observed leaving a fixture, the test fails. */
const SENTINEL='DUMMY-SENTINEL-NEVER-A-REAL-SECRET-4b91c7';
const SECRET_FILES=['.env','tui/.env'];

/**
 * Build a passing three-repository world with dummy credentials.
 *
 * `plant` runs after the files exist and before git/inventory are built, so a test can add
 * aliases that the inventory will then enumerate exactly like any other governed path.
 */
function fixture({plant=null}={}){
  const top=fs.mkdtempSync(path.join(os.tmpdir(),'trio-credential-boundary-'));
  const governance=path.join(top,'governance');fs.mkdirSync(governance);
  fs.cpSync(path.join(projectRoot,'trio/governance/schemas'),path.join(governance,'schemas'),{recursive:true});
  const manifest=structuredClone(readStrictJson(path.join(projectRoot,'trio/governance/boundary-manifest.json')));
  const manifestPath=path.join(governance,'boundary-manifest.json');
  manifest.rules=manifest.rules.filter((r)=>r.class!=='owner-scoped-asset');
  const slots={};const guarded=[];
  for(const slot of SLOT_NAMES){
    const root=path.join(top,slot);slots[slot]=root;fs.mkdirSync(root);const spec=manifest.repositories[slot];
    write(path.join(root,'package.json'),JSON.stringify({name:spec.packageNames['package.json'],description:slot,version:'0.0.0',type:'module',private:true,scripts:{start:'node dist/index.js'},dependencies:{alpha:'1.0.0'},devDependencies:{test:'1.0.0'}}));
    write(path.join(root,'tui/package.json'),JSON.stringify({name:spec.packageNames['tui/package.json'],version:'0.0.0',type:'module',private:true,scripts:{start:'node src/server.ts'}}));
    write(path.join(root,'src/main.ts'),'export const value=1;\n');
    for(const [agent,id] of [['pehlichi','pehlichi'],['loony-luna','luna'],['mad-ptah','ptah']])write(path.join(root,`trio/governance/capsules/${agent}.json`),JSON.stringify(capsule(id)));
    fs.cpSync(path.join(projectRoot,'trio/runtime-closure.json'),path.join(root,'trio/runtime-closure.json'));
    for(const rel of SECRET_FILES){const full=path.join(root,rel);write(full,`API_TOKEN=${SENTINEL}\n`,0o644);guarded.push(full);}
    git(root,['init','-q']);git(root,['config','user.email','fixture@example.invalid']);git(root,['config','user.name','fixture']);git(root,['remote','add','origin',`https://github.com/RootZ3n/${slot}.git`]);
  }
  const world={top,slots,manifest,manifestPath,guarded};
  if(plant)plant(world);
  function setManifest(value,text=null){const data=text??JSON.stringify(value);write(manifestPath,data);for(const root of Object.values(slots))write(path.join(root,'trio/governance/boundary-manifest.json'),data);}
  setManifest(manifest);
  const inventory={schemaVersion:'1.0.0',status:'characterization',rules:{}};
  const excluded=(rel)=>manifest.exclusions.some((x)=>rel===x.path||rel.startsWith(x.path+'/'));
  const union=new Set();
  for(const root of Object.values(slots)){const visit=(dir,base='')=>{for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const rel=base?`${base}/${ent.name}`:ent.name;if(excluded(rel))continue;if(ent.isDirectory())visit(path.join(dir,ent.name),rel);else union.add(rel);}};visit(root);}
  for(const rule of manifest.rules.filter((x)=>x.selector.directory)){const s=rule.selector;inventory.rules[rule.id]=[...union].filter((rel)=>rel.startsWith(s.directory+'/')&&!(s.excludedPaths??[]).includes(rel)&&!(s.excludedDirectories??[]).some((d)=>rel===d||rel.startsWith(d+'/'))&&(!s.allowedSuffixes||s.allowedSuffixes.some((x)=>rel.endsWith(x)))).sort();}
  if(inventory.rules['trio-scaffolding']&&!inventory.rules['trio-scaffolding'].includes('trio/governance/path-inventory.json'))inventory.rules['trio-scaffolding'].push('trio/governance/path-inventory.json');
  const inventoryPath=path.join(governance,'path-inventory.json');
  const setInventory=(value)=>{write(inventoryPath,JSON.stringify(value));for(const root of Object.values(slots))write(path.join(root,'trio/governance/path-inventory.json'),JSON.stringify(value));};
  setInventory(inventory);
  for(const root of Object.values(slots)){git(root,['add','-A','.']);git(root,['commit','-qm','fixture']);}
  return {...world,inventory,inventoryPath,setManifest,setInventory};
}
const clean=(f)=>{try{fs.rmSync(f.top,{recursive:true,force:true});}catch{}};

/**
 * Run `fn` with every filesystem read primitive trapped by filesystem identity.
 *
 * Identity, not pathname: a hard link is a second name for the same inode, so watching names
 * is exactly the mistake this suite exists to prevent regressing. Symlinks and traversal
 * spellings collapse onto the same object under stat, so they are covered by construction.
 */
function withIdentityTrap(guardedPaths,fn){
  const identities=new Set();
  for(const p of guardedPaths){try{const st=fs.statSync(p);identities.add(`${st.dev}:${st.ino}`);}catch{}}
  assert.ok(identities.size>0,'the trap must be watching at least one guarded object');
  const attempts=[];
  const originals={fs:{},promises:{}};
  const NAMES=['readFileSync','readFile','openSync','open','createReadStream','readSync','copyFileSync','appendFileSync','writeFileSync'];
  const identify=(target)=>{
    try{
      if(typeof target==='number')return `${fs.fstatSync(target).dev}:${fs.fstatSync(target).ino}`;
      if(typeof target==='string'||target instanceof URL){const st=fs.statSync(target);return `${st.dev}:${st.ino}`;}
    }catch{}
    return null;
  };
  const guard=(primitive,target)=>{
    const key=identify(target);
    if(key!==null&&identities.has(key)){
      attempts.push({primitive,identity:key});
      const error=new Error(`FORBIDDEN_CREDENTIAL_READ via ${primitive}`);
      error.code='FORBIDDEN_CREDENTIAL_READ';
      throw error;
    }
  };
  for(const name of NAMES){
    if(typeof fs[name]==='function'){originals.fs[name]=fs[name];fs[name]=function(...args){guard(name,args[0]);return originals.fs[name].apply(this,args);};}
  }
  if(fs.promises&&typeof fs.promises.readFile==='function'){
    originals.promises.readFile=fs.promises.readFile;
    fs.promises.readFile=function(...args){guard('promises.readFile',args[0]);return originals.promises.readFile.apply(this,args);};
  }
  try{return {result:fn(),attempts};}
  finally{
    for(const [name,original] of Object.entries(originals.fs))fs[name]=original;
    for(const [name,original] of Object.entries(originals.promises))fs.promises[name]=original;
  }
}

const runTrapped=(f,extraGuarded=[])=>withIdentityTrap([...f.guarded,...extraGuarded],()=>verify({slots:f.slots,manifestPath:f.manifestPath}));

/** No attempted read, and the sentinel never reaches the evidence. */
function assertNoAttempts(f,{result,attempts},{expectParity=true}={}){
  assert.deepEqual(attempts,[],`the verifier attempted to read a guarded credential object: ${JSON.stringify(attempts)}`);
  const evidence=JSON.stringify(result);
  assert.equal(evidence.includes(SENTINEL),false,'a dummy credential value reached the evidence');
  assert.equal(evidence.includes('API_TOKEN'),false,'a credential key name reached the evidence');
  if(expectParity)assert.equal(result.summary.verdict,'PARITY',JSON.stringify(result.failures?.slice(0,4)));
}
function assertSecurityBlocked(f,run){assert.deepEqual(run.attempts,[]);assert.equal(run.result.status,'VERIFIER_SECURITY_BLOCKED');assert.equal(run.result.summary.verdict,'VERIFIER_SECURITY_BLOCKED');assert.equal(JSON.stringify(run.result).includes(SENTINEL),false);for(const finding of run.result.failures)assert.deepEqual(Object.keys(finding.details??{}).sort(),['category','contentsRead']);}

for(const rel of ['trio/runtime-closure.json','package.json','trio/governance/capsules/pehlichi.json'])test(`${rel} hard-linked to a credential is security blocked before content`,()=>{
  const f=fixture();try{const target=path.join(f.slots.pehlichi,rel);fs.unlinkSync(target);fs.linkSync(path.join(f.slots.pehlichi,'.env'),target);f.guarded.push(target);assertSecurityBlocked(f,runTrapped(f));}finally{clean(f);}
});

for(const rel of ['trio/governance/path-inventory.json','trio/governance/boundary-manifest.json'])test(`${rel} hard-linked to a credential is security blocked before parser access`,()=>{
  const f=fixture();try{const target=path.join(f.slots['loony-luna'],rel);fs.unlinkSync(target);fs.linkSync(path.join(f.slots['loony-luna'],'.env'),target);f.guarded.push(target);assertSecurityBlocked(f,runTrapped(f));}finally{clean(f);}
});

test('the governing boundary manifest hard-linked to a dummy credential is security blocked',()=>{
  const f=fixture();try{const secret=path.join(path.dirname(f.manifestPath),'.env');write(secret,`API_TOKEN=${SENTINEL}\n`);fs.unlinkSync(f.manifestPath);fs.linkSync(secret,f.manifestPath);f.guarded.push(secret,f.manifestPath);assertSecurityBlocked(f,runTrapped(f,[secret,f.manifestPath]));}finally{clean(f);}
});

// (1)(2) The declared paths themselves, nested and top level.
test('declared .env and nested tui/.env are never opened',()=>{
  const f=fixture();
  try{assertNoAttempts(f,runTrapped(f));}finally{clean(f);}
});

// (15) Absence must not be papered over with a speculative read.
test('an absent declared secret is handled without inventing a read',()=>{
  const f=fixture();
  try{
    fs.rmSync(path.join(f.slots['mad-ptah'],'tui/.env'));
    const {result,attempts}=runTrapped(f);
    assert.deepEqual(attempts,[]);
    assert.equal(result.summary.verdict,'PARITY',JSON.stringify(result.failures?.slice(0,4)));
  }finally{clean(f);}
});

// (5) Hard-linked alias: same inode, innocent name, and nlink>1 on the canonical path too.
test('a hard-linked alias of a credential is never read through either name',()=>{
  const f=fixture({plant:(w)=>{
    const target=path.join(w.slots['loony-luna'],'.env');
    const alias=path.join(w.slots['loony-luna'],'docs/alias.md');
    fs.mkdirSync(path.dirname(alias),{recursive:true});
    fs.linkSync(target,alias);
    w.guarded.push(alias);
  }});
  try{
    const {result,attempts}=runTrapped(f);
    assert.deepEqual(attempts,[],`hard-linked credential object was read: ${JSON.stringify(attempts)}`);
    assert.notEqual(result.summary.verdict,'PARITY','an unresolved credential alias must not publish parity');
    assert.equal(JSON.stringify(result).includes(SENTINEL),false);
  }finally{clean(f);}
});

// (8) Order independence: the alias sorts before the canonical name in the same directory.
test('an alias walked before its canonical secret path is still refused',()=>{
  const f=fixture({plant:(w)=>{
    const target=path.join(w.slots['pehlichi'],'.env');
    // "AAA-alias.md" sorts ahead of ".env"? Byte order puts '.' first, so place the alias in a
    // directory that is itself walked earlier, which is the realistic ordering hazard.
    const alias=path.join(w.slots['pehlichi'],'deploy/aaa-first.txt');
    fs.mkdirSync(path.dirname(alias),{recursive:true});
    fs.linkSync(target,alias);
    w.guarded.push(alias);
  }});
  try{
    const {result,attempts}=runTrapped(f);
    assert.deepEqual(attempts,[],`alias-before-canonical was read: ${JSON.stringify(attempts)}`);
    assert.notEqual(result.summary.verdict,'PARITY');
  }finally{clean(f);}
});

// (6) Symlink alias.
test('a symlink pointing at a credential is never dereferenced for content',()=>{
  const f=fixture({plant:(w)=>{
    const alias=path.join(w.slots['mad-ptah'],'deploy/link.txt');
    fs.mkdirSync(path.dirname(alias),{recursive:true});
    fs.symlinkSync(path.join(w.slots['mad-ptah'],'.env'),alias);
  }});
  try{
    const {result,attempts}=runTrapped(f);
    assert.deepEqual(attempts,[],`symlinked credential was dereferenced: ${JSON.stringify(attempts)}`);
    assert.notEqual(result.summary.verdict,'PARITY');
  }finally{clean(f);}
});

// (7) Traversal / normalization spelling of the same object.
test('a traversal-spelled alias resolves to the same object and is refused',()=>{
  const f=fixture({plant:(w)=>{
    const target=path.join(w.slots['loony-luna'],'tui/.env');
    const alias=path.join(w.slots['loony-luna'],'deploy/nested/../traversal.txt');
    fs.mkdirSync(path.dirname(path.normalize(alias)),{recursive:true});
    fs.linkSync(target,path.normalize(alias));
    w.guarded.push(path.normalize(alias));
  }});
  try{
    const {result,attempts}=runTrapped(f);
    assert.deepEqual(attempts,[]);
    assert.notEqual(result.summary.verdict,'PARITY');
  }finally{clean(f);}
});

// (3)(4)(9) A credential-class file introduced through an agent-owned rule. The primary pass
// classifies it; the secondary agent-owned pass is where the audit found the unguarded reader.
test('a credential introduced through an agent-owned rule is refused by every pass',()=>{
  const f=fixture({plant:(w)=>{
    const planted=path.join(w.slots['pehlichi'],'deploy/.env');
    write(planted,`API_TOKEN=${SENTINEL}\n`,0o600);
    w.guarded.push(planted);
  }});
  try{
    const {result,attempts}=runTrapped(f);
    assert.deepEqual(attempts,[],`agent-owned secondary pass read a credential: ${JSON.stringify(attempts)}`);
    assert.notEqual(result.summary.verdict,'PARITY','an ungoverned credential path must fail closed');
    assert.ok(result.failures.some((x)=>x.failureClass==='SECRET_PATH_UNGOVERNED'||x.failureClass==='SECRET_READ_REFUSED'||x.failureClass==='SECRET_PATH_MISCLASSIFIED'),
      `expected a credential-path failure; got ${[...new Set(result.failures.map((x)=>x.failureClass))]}`);
    assert.equal(JSON.stringify(result).includes(SENTINEL),false);
  }finally{clean(f);}
});

// (10) Every primitive the verifier is audited to use is covered by the trap itself.
test('the trap covers every filesystem read primitive the verifier can reach',()=>{
  const covered=['readFileSync','readFile','openSync','open','createReadStream','readSync','promises.readFile'];
  const source=fs.readFileSync(path.join(here,'credential-boundary.test.mjs'),'utf8');
  for(const primitive of covered)assert.ok(source.includes(`'${primitive.split('.').pop()}'`)||source.includes(primitive),`trap must cover ${primitive}`);
  // And the trap must actually fire on a guarded object, or every "no attempts" result above
  // would be vacuous.
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'trio-trap-selftest-'));
  try{
    const secret=path.join(dir,'.env');fs.writeFileSync(secret,`API_TOKEN=${SENTINEL}\n`);
    const alias=path.join(dir,'innocent.txt');fs.linkSync(secret,alias);
    let threw=false;
    const {attempts}=withIdentityTrap([secret],()=>{try{fs.readFileSync(alias);}catch(error){threw=error.code==='FORBIDDEN_CREDENTIAL_READ';}return null;});
    assert.equal(threw,true,'the trap must fire when a guarded object is read through an alias');
    assert.equal(attempts.length,1);
    assert.equal(attempts[0].primitive,'readFileSync');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

// (11)(12) A detected attempt may not be swallowed, and it must stop publication.
test('a trapped credential read cannot be swallowed and blocks publication',()=>{
  const f=fixture({plant:(w)=>{
    const alias=path.join(w.slots['loony-luna'],'deploy/aliased.txt');
    fs.mkdirSync(path.dirname(alias),{recursive:true});
    fs.linkSync(path.join(w.slots['loony-luna'],'.env'),alias);
    w.guarded.push(alias);
  }});
  try{
    const {result}=runTrapped(f);
    assert.notEqual(result.summary.verdict,'PARITY','a credential alias must never reach a parity verdict');
    const published=publishedResult(result);
    assert.notEqual(published.summary.verdict,'PARITY','publication must refuse');
    assert.equal(JSON.stringify(published).includes(SENTINEL),false);
    // No credential metadata may appear in the failure evidence either.
    for(const failure of published.failures){
      assert.equal(/mode|byteLength|byteDigest|size|mtime|uid|gid/.test(JSON.stringify(failure.details??{})&&Object.keys(failure.details??{}).join(',')),false,
        `credential failure evidence must not carry file metadata: ${JSON.stringify(failure.details)}`);
    }
  }finally{clean(f);}
});

// (13)(14) The boundary must not break legitimate work.
test('legitimate non-secret agent-owned content is still read and governed',()=>{
  const f=fixture({plant:(w)=>{
    for(const slot of SLOT_NAMES)write(path.join(w.slots[slot],'deploy/launch.md'),`# ${slot} deployment\n`);
  }});
  try{assertNoAttempts(f,runTrapped(f));}finally{clean(f);}
});
test('legitimate UI content and package projections still work',()=>{
  const f=fixture({plant:(w)=>{
    for(const [i,slot] of SLOT_NAMES.entries())write(path.join(w.slots[slot],'ui/index.html'),`<!doctype html><title>agent ${i}</title>`);
  }});
  try{
    const {result,attempts}=runTrapped(f);
    assert.deepEqual(attempts,[]);
    assert.equal(result.summary.verdict,'PARITY',JSON.stringify(result.failures?.slice(0,4)));
    assert.ok(Object.keys(result.packageBehaviorProjection).length===SLOT_NAMES.length);
  }finally{clean(f);}
});
