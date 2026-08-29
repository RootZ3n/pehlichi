/**
 * Prove the verifier never reads credential content.
 *
 * Asserting "we do not read secrets" in a comment costs nothing. These tests make the claim
 * falsifiable two ways: every filesystem read primitive is intercepted and throws if it is
 * ever pointed at a credential path, and the fixture secrets are also made unreadable at the
 * OS level. If the verifier opens one, the run dies loudly instead of quietly leaking.
 *
 * The fixture credentials contain obvious dummy values, and a final check greps the entire
 * emitted evidence for those values -- a digest or an excerpt escaping into the report would
 * be just as much of a leak as printing the file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verify,SLOT_NAMES } from './verify-runtime-parity.mjs';
import { readStrictJson } from './strict-json.mjs';
import { classifySecretPath } from './secret-path-policy.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));const projectRoot=path.resolve(here,'../..');
const write=(p,s,mode)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s);if(mode!==undefined)fs.chmodSync(p,mode);};
const git=(root,args)=>cp.execFileSync('git',args,{cwd:root,stdio:'ignore'});
const capsule=(id)=>({$schema:'../schemas/capsule.schema.json',schemaVersion:'1.1.0',status:'characterization',identity:{id,displayName:id,role:'fixture'},personalityRef:`personality/${id}.yaml`,skills:[],capabilityPacks:{requested:[],inactive:[]},routingPreferences:[],modelDefaults:{providerRef:'fixture',model:'fixture'},memoryNamespace:id,branding:{themeRef:'tui/skin.yaml',icon:'x',welcomeRef:`personality/${id}.yaml`},completion:{criteriaRefs:[],reportFormatRefs:[]}});

/** An obviously fake value. If this string ever appears in the evidence, the test has failed. */
const SENTINEL='DUMMY-NOT-A-REAL-SECRET-8f3a2c9e';
const SECRET_FILES=['.env','tui/.env'];

function fixture({secretMode}={}){
  const top=fs.mkdtempSync(path.join(os.tmpdir(),'trio-credential-'));const governance=path.join(top,'governance');fs.mkdirSync(governance);
  fs.cpSync(path.join(projectRoot,'trio/governance/schemas'),path.join(governance,'schemas'),{recursive:true});
  const manifest=structuredClone(readStrictJson(path.join(projectRoot,'trio/governance/boundary-manifest.json')));
  const manifestPath=path.join(governance,'boundary-manifest.json');
  manifest.rules=manifest.rules.filter((r)=>r.class!=='owner-scoped-asset');
  const slots={};const secretPaths=[];
  for(const slot of SLOT_NAMES){const root=path.join(top,slot);slots[slot]=root;fs.mkdirSync(root);const spec=manifest.repositories[slot];
    write(path.join(root,'package.json'),JSON.stringify({name:spec.packageNames['package.json'],description:slot,version:'0.0.0',type:'module',private:true,scripts:{start:'node dist/index.js'},dependencies:{alpha:'1.0.0'},devDependencies:{test:'1.0.0'}}));
    write(path.join(root,'tui/package.json'),JSON.stringify({name:spec.packageNames['tui/package.json'],version:'0.0.0',type:'module',private:true,scripts:{start:'node src/server.ts'}}));
    write(path.join(root,'src/main.ts'),'export const value=1;\n');
    for(const [agent,id] of [['pehlichi','pehlichi'],['loony-luna','luna'],['mad-ptah','ptah']])write(path.join(root,`trio/governance/capsules/${agent}.json`),JSON.stringify(capsule(id)));
    fs.cpSync(path.join(projectRoot,'trio/runtime-closure.json'),path.join(root,'trio/runtime-closure.json'));
    for(const rel of SECRET_FILES){const full=path.join(root,rel);write(full,`API_TOKEN=${SENTINEL}\n`,0o644);secretPaths.push(full);}
    git(root,['init','-q']);git(root,['config','user.email','fixture@example.invalid']);git(root,['config','user.name','fixture']);git(root,['remote','add','origin',`https://github.com/RootZ3n/${slot}.git`]);
  }
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
  for(const root of Object.values(slots)){git(root,['add','.']);git(root,['commit','-qm','fixture']);}
  if(secretMode!==undefined)for(const full of secretPaths)fs.chmodSync(full,secretMode);
  return {top,slots,manifestPath,secretPaths};
}
const clean=(f)=>{try{for(const p of f.secretPaths)try{fs.chmodSync(p,0o644);}catch{}fs.rmSync(f.top,{recursive:true,force:true});}catch{}};

/**
 * Run the verifier with every read primitive booby-trapped for the fixture's secret paths.
 *
 * The verifier imports the `node:fs` module object and calls through it, so replacing the
 * functions on that object is enough to observe -- and refuse -- any read it attempts.
 */
function runWithReadTrap(f){
  const guarded=new Set(f.secretPaths.map((p)=>fs.realpathSync(p)));
  const attempts=[];
  const names=['readFileSync','openSync','createReadStream','readSync','readv','read'];
  const original=Object.fromEntries(names.map((n)=>[n,fs[n]]));
  const guard=(name,target)=>{
    const resolved=typeof target==='string'?path.resolve(target):null;
    if(resolved&&guarded.has(resolved)){attempts.push({name,path:resolved});throw new Error(`CREDENTIAL_READ_ATTEMPTED via ${name}: ${resolved}`);}
  };
  for(const name of names)if(typeof original[name]==='function')fs[name]=function(...args){guard(name,args[0]);return original[name].apply(this,args);};
  try{return {result:verify({slots:f.slots,manifestPath:f.manifestPath}),attempts};}
  finally{for(const name of names)fs[name]=original[name];}
}

test('the credential policy classifies the fixture secrets from their paths alone',()=>{
  for(const rel of SECRET_FILES)assert.equal(classifySecretPath(rel).secret,true,rel);
  assert.equal(classifySecretPath('src/main.ts').secret,false);
});

test('a full verification never opens a credential-bearing path',()=>{
  const f=fixture();
  try{
    const {result,attempts}=runWithReadTrap(f);
    assert.deepEqual(attempts,[],`the verifier attempted to read credential content: ${JSON.stringify(attempts)}`);
    assert.notEqual(result.status,'VERIFIER_EXCEPTION');
    assert.equal(result.summary.verdict,'PARITY',JSON.stringify(result.failures.slice(0,4)));
  }finally{clean(f);}
});

test('credentials that cannot be read at all do not disturb the verdict',()=>{
  // If the verifier were reading them, mode 000 would surface as EACCES rather than parity.
  const f=fixture({secretMode:0o000});
  try{
    const {result,attempts}=runWithReadTrap(f);
    assert.deepEqual(attempts,[]);
    assert.equal(result.summary.verdict,'PARITY',JSON.stringify(result.failures.slice(0,4)));
  }finally{clean(f);}
});

test('every credential path is reported as explicitly excluded, with metadata only',()=>{
  const f=fixture();
  try{
    const {result}=runWithReadTrap(f);
    const excluded=result.secretPathsExcluded;
    assert.equal(excluded.length,SECRET_FILES.length*SLOT_NAMES.length);
    for(const entry of excluded){
      assert.equal(entry.result,'SECRET_PATH_EXCLUDED');
      assert.equal(entry.contentsRead,false);
      assert.match(entry.mode,/^\d{3}$/);
    }
    assert.equal(result.secretPathPolicy.contentsRead,false);
  }finally{clean(f);}
});

test('no credential value, length, or digest reaches the evidence',()=>{
  const f=fixture();
  try{
    const {result}=runWithReadTrap(f);
    const evidence=JSON.stringify(result);
    assert.equal(evidence.includes(SENTINEL),false,'a credential value reached the evidence');
    assert.equal(evidence.includes('API_TOKEN'),false,'a credential key name reached the evidence');
    for(const record of result.secretPathsExcluded){
      const governed=(result.unclassified??[]).find((x)=>x.path===record.path);
      assert.equal(governed,undefined,'a credential path was treated as unclassified content');
    }
    // The digest of a secret is still derived from the secret. Neither may appear.
    const secretDigestShaped=/"byteDigest":"sha256:[0-9a-f]{64}"[^}]*"path":"(?:tui\/)?\.env"/;
    assert.equal(secretDigestShaped.test(evidence),false);
  }finally{clean(f);}
});

test('an undeclared credential-like path is reported without being opened',()=>{
  const f=fixture();
  try{
    const planted=path.join(f.slots['mad-ptah'],'deploy/id_rsa');
    write(planted,`-----BEGIN PRIVATE KEY-----\n${SENTINEL}\n`,0o600);
    f.secretPaths.push(planted);
    const {result,attempts}=runWithReadTrap(f);
    assert.deepEqual(attempts,[],'a newly encountered secret path must be classified, never sampled');
    assert.ok(result.failures.some((x)=>x.failureClass==='SECRET_PATH_UNGOVERNED'&&x.affectedPath==='deploy/id_rsa'),'an unknown credential path must fail closed');
    assert.equal(JSON.stringify(result).includes(SENTINEL),false);
  }finally{clean(f);}
});
