/**
 * Mutation suite: prove the verifier detects what it claims to detect.
 *
 * Every case below is a deliberate defect injected into an otherwise-passing world. A test
 * here fails if the verifier returns PARITY, which is the only failure mode that matters --
 * a verifier that blocks too much is annoying, and a verifier that greens a mutation is
 * worthless. The last group is the mirror image: legitimate per-agent variation that must
 * NOT be flagged, because a verifier nobody can satisfy gets switched off.
 *
 * The categories map to the false-green classes found in the independent audit, plus the
 * shared-runtime, credential, and Truth-authority cases the repaired verifier now owns.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verify,SLOT_NAMES } from './verify-runtime-parity.mjs';
import { parseStrictJsonText } from './strict-json.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));const projectRoot=path.resolve(here,'../..');
const readStrictJson=(file)=>parseStrictJsonText(fs.readFileSync(file,'utf8'));
const write=(p,s,mode)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s);if(mode!==undefined)fs.chmodSync(p,mode);};
const git=(root,args)=>cp.execFileSync('git',args,{cwd:root,stdio:'ignore'});
const capsule=(id)=>({$schema:'../schemas/capsule.schema.json',schemaVersion:'1.1.0',status:'characterization',identity:{id,displayName:id,role:'fixture'},personalityRef:`personality/${id}.yaml`,skills:[],capabilityPacks:{requested:[],inactive:[]},routingPreferences:[],modelDefaults:{providerRef:'fixture',model:'fixture'},memoryNamespace:id,branding:{themeRef:'tui/skin.yaml',icon:'x',welcomeRef:`personality/${id}.yaml`},completion:{criteriaRefs:[],reportFormatRefs:[]}});

/** Build a three-repository world that reaches PARITY, so any later verdict is the mutation. */
function fixture(){
  const top=fs.mkdtempSync(path.join(os.tmpdir(),'trio-mutation-'));const governance=path.join(top,'governance');fs.mkdirSync(governance);
  fs.cpSync(path.join(projectRoot,'trio/governance/schemas'),path.join(governance,'schemas'),{recursive:true});
  const manifest=structuredClone(readStrictJson(path.join(projectRoot,'trio/governance/boundary-manifest.json')));
  const manifestPath=path.join(governance,'boundary-manifest.json');
  manifest.rules=manifest.rules.filter((r)=>r.class!=='owner-scoped-asset');
  const slots={};
  for(const slot of SLOT_NAMES){const root=path.join(top,slot);slots[slot]=root;fs.mkdirSync(root);const spec=manifest.repositories[slot];
    write(path.join(root,'package.json'),JSON.stringify({name:spec.packageNames['package.json'],description:slot,version:'0.0.0',type:'module',private:true,scripts:{start:'node dist/index.js'},dependencies:{alpha:'1.0.0'},devDependencies:{test:'1.0.0'}}));
    write(path.join(root,'tui/package.json'),JSON.stringify({name:spec.packageNames['tui/package.json'],version:'0.0.0',type:'module',private:true,scripts:{start:'node src/server.ts'}}));
    write(path.join(root,'src/main.ts'),'export const value=1;\n');
    for(const [agent,id] of [['pehlichi','pehlichi'],['loony-luna','luna'],['mad-ptah','ptah']])write(path.join(root,`trio/governance/capsules/${agent}.json`),JSON.stringify(capsule(id)));
    // The verifier binds to the Truth release the activation wrapper executes and checks
    // each repository's own pin against it, so a fixture world needs that pin to exist.
    fs.cpSync(path.join(projectRoot,'trio/runtime-closure.json'),path.join(root,'trio/runtime-closure.json'));
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
  return {top,governance,manifest,manifestPath,inventory,inventoryPath,slots,setManifest,setInventory};
}
const clean=(f)=>{try{fs.rmSync(f.top,{recursive:true,force:true});}catch{}};
const run=(f)=>verify({slots:f.slots,manifestPath:f.manifestPath});
const divergentFile=(f,rel,common,changed,mode)=>{for(const root of Object.values(f.slots))write(path.join(root,rel),common,mode);write(path.join(f.slots['loony-luna'],rel),changed,mode);};

/** The world must be green first, or a "detection" proves only that the fixture is broken. */
function mutation(name,mutate,expect={}){
  test(`mutation detected: ${name}`,()=>{
    const f=fixture();
    try{
      const before=run(f);
      assert.equal(before.summary.verdict,'PARITY',`baseline world is not at parity: ${JSON.stringify(before.failures.slice(0,3))}`);
      mutate(f);
      const after=run(f);
      assert.notEqual(after.summary.verdict,'PARITY',`mutation "${name}" was not detected`);
      if(expect.failureClass)assert.ok(after.failures.some((x)=>x.failureClass===expect.failureClass),`expected ${expect.failureClass}; got ${[...new Set(after.failures.map((x)=>x.failureClass))]}`);
      if(expect.affectedPath)assert.ok(after.failures.some((x)=>x.affectedPath===expect.affectedPath),`expected a finding on ${expect.affectedPath}`);
      if(expect.evidence)assert.match(JSON.stringify(after.failures),expect.evidence,`expected evidence matching ${expect.evidence}`);
    }finally{clean(f);}
  });
}

// -- shared runtime -----------------------------------------------------------------------
mutation('one-byte shared runtime divergence',(f)=>{write(path.join(f.slots['mad-ptah'],'src/main.ts'),'export const value=2;\n');},{failureClass:'BEHAVIOR_DIVERGENCE',affectedPath:'src/main.ts'});
mutation('missing shared behavior file',(f)=>{fs.rmSync(path.join(f.slots['loony-luna'],'src/main.ts'));},{failureClass:'MISSING_BEHAVIOR_FILE',affectedPath:'src/main.ts'});
mutation('generated shared-output tampering',(f)=>{for(const root of Object.values(f.slots))write(path.join(root,'dist/index.js'),'ok()');write(path.join(f.slots['mad-ptah'],'dist/index.js'),'tampered()');});

// -- structured parsing -------------------------------------------------------------------
mutation('duplicate JSON keys in a governed manifest',(f)=>{const body=JSON.stringify(f.manifest);f.setManifest(f.manifest,`{"schemaVersion":"9.9.9",${body.slice(1)}`);},{failureClass:'SCHEMA_VALIDATION',evidence:/JSON_DUPLICATE_KEY/});
// Caught at capsule preflight rather than content validation -- earlier is fine, silent is
// not. The evidence assertion is what makes this a duplicate-key test rather than a test
// that something, somewhere, was unhappy.
mutation('duplicate JSON keys in governed capsule data',(f)=>{const p=path.join(f.slots['loony-luna'],'trio/governance/capsules/loony-luna.json');const body=fs.readFileSync(p,'utf8');write(p,`{"memoryNamespace":"hijacked",${body.slice(1)}`);},{failureClass:'CAPSULE_IDENTITY_MISMATCH',evidence:/JSON_DUPLICATE_KEY/});

// -- package and lockfile behaviour --------------------------------------------------------
mutation('package script divergence',(f)=>{const p=path.join(f.slots['mad-ptah'],'package.json');const v=JSON.parse(fs.readFileSync(p,'utf8'));v.scripts={...v.scripts,start:'node evil.js'};write(p,JSON.stringify(v));},{failureClass:'BEHAVIOR_DIVERGENCE',affectedPath:'package.json'});
mutation('package entry point added to one agent only',(f)=>{const p=path.join(f.slots['pehlichi'],'package.json');const v=JSON.parse(fs.readFileSync(p,'utf8'));v.bin={peh:'./cli.js'};write(p,JSON.stringify(v));},{failureClass:'BEHAVIOR_DIVERGENCE',affectedPath:'package.json'});
mutation('lockfile resolution divergence',(f)=>{divergentFile(f,'pnpm-lock.yaml','lockfileVersion: 9\n','lockfileVersion: 9\npackages: {evil: true}\n');},{failureClass:'BEHAVIOR_DIVERGENCE',affectedPath:'pnpm-lock.yaml'});
mutation('package manager configuration divergence',(f)=>{divergentFile(f,'pnpm-workspace.yaml','packages: []\n','packages: [evil]\n');},{failureClass:'BEHAVIOR_DIVERGENCE',affectedPath:'pnpm-workspace.yaml'});

// -- obsolete but live ---------------------------------------------------------------------
mutation('obsolete-but-executable content diverges',(f)=>{divergentFile(f,'server.py','print(1)\n','print(2)\n');},{failureClass:'BEHAVIOR_DIVERGENCE',affectedPath:'server.py'});
mutation('obsolete executable diverges only in file mode',(f)=>{for(const root of Object.values(f.slots))write(path.join(root,'stress_test.py'),'print(0)\n',0o644);write(path.join(f.slots['mad-ptah'],'stress_test.py'),'print(0)\nprint(1)\n',0o644);},{failureClass:'BEHAVIOR_DIVERGENCE',affectedPath:'stress_test.py'});

// -- malformed and polyglot assets ---------------------------------------------------------
const PNG_SIG=Buffer.from([137,80,78,71,13,10,26,10]);
mutation('PNG-signature polyglot in a governed asset',(f)=>{for(const root of Object.values(f.slots))write(path.join(root,'peh-hedge-knight.png'),Buffer.concat([PNG_SIG,Buffer.from('<script>attack()</script>')]));},{failureClass:'QUARANTINED_DIVERGENCE',affectedPath:'peh-hedge-knight.png'});
mutation('SVG renamed as PNG',(f)=>{for(const root of Object.values(f.slots))write(path.join(root,'peh-hedge-knight.png'),Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>'));},{failureClass:'CONTENT_VALIDATION',affectedPath:'peh-hedge-knight.png'});

// -- hidden shared behaviour ----------------------------------------------------------------
mutation('shared runtime behavior hidden in an agent-owned skill',(f)=>{for(const [i,root] of Object.values(f.slots).entries())write(path.join(root,'skills/handler.ts'),`export const run=()=>${i};\n`);},{failureClass:'UNCLASSIFIED_FILE'});
mutation('one-agent-only governance rule',(f)=>{f.manifest.rules=f.manifest.rules.filter((r)=>r.id!=='source-runtime');f.setManifest(f.manifest);},{});

// -- credentials -----------------------------------------------------------------------------
mutation('credential path appears that no rule declares',(f)=>{write(path.join(f.slots['loony-luna'],'deploy/id_rsa'),'NOT-A-REAL-KEY\n',0o600);},{failureClass:'SECRET_PATH_UNGOVERNED'});

// -- Truth authority ---------------------------------------------------------------------------
mutation('mismatched Truth authority',(f)=>{f.manifest.truthRelease={...f.manifest.truthRelease,releaseId:'0'.repeat(32)};f.setManifest(f.manifest);},{failureClass:'TRUTH_IDENTITY_MISMATCH'});
mutation('Truth closure digest is repointed to an unmeasured value',(f)=>{f.manifest.truthRelease={...f.manifest.truthRelease,packageClosureSha256:'0'.repeat(64)};f.setManifest(f.manifest);},{failureClass:'TRUTH_IDENTITY_MISMATCH'});

// -- legitimate variation must stay green -------------------------------------------------------
function permitted(name,mutate){
  test(`legitimate variation stays green: ${name}`,()=>{
    const f=fixture();
    try{
      assert.equal(run(f).summary.verdict,'PARITY','baseline world is not at parity');
      mutate(f);
      const after=run(f);
      assert.equal(after.summary.verdict,'PARITY',`legitimate variation was wrongly flagged: ${JSON.stringify(after.failures.slice(0,4))}`);
    }finally{clean(f);}
  });
}
permitted('package identity metadata differs per agent',(f)=>{for(const slot of SLOT_NAMES){const p=path.join(f.slots[slot],'package.json');const v=JSON.parse(fs.readFileSync(p,'utf8'));v.description=`the ${slot} agent`;write(p,JSON.stringify(v));}});
permitted('each agent ships a different UI',(f)=>{for(const [i,slot] of SLOT_NAMES.entries())write(path.join(f.slots[slot],'ui/index.html'),`<!doctype html><title>agent ${i}</title>`);f.inventory.rules['ui-quarantine']=['ui/index.html'];f.setInventory(f.inventory);});
permitted('each agent ships a different capsule identity',(f)=>{/* the baseline already differs per agent */});
