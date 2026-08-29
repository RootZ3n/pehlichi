import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStrictJson } from './strict-json.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');const read=(p)=>readStrictJson(path.join(root,p));
test('TRIO-001D closed boundary carries labeled slots, a closed inventory, and no implied executableAllowed field',()=>{const m=read('trio/governance/boundary-manifest.json');assert.equal(m.schemaVersion,'2.0.0');assert.deepEqual(Object.keys(m.repositories).sort(),['loony-luna','mad-ptah','pehlichi']);assert.equal(JSON.stringify(m).includes('executableAllowed'),false);assert.equal(m.pathPolicy.unknownFiles,'fail-closed');assert.equal(m.pathInventory.path,'path-inventory.json');assert.equal(m.pathInventory.schemaVersion,'1.0.0');assert.ok(m.rules.filter((x)=>x.selector.directory).every((x)=>x.selector.closedInventory===true));});
test('variable classes use exact paths and are never production-reachable',()=>{const m=read('trio/governance/boundary-manifest.json');for(const rule of m.rules.filter((x)=>['validated-variable-data','inert-variable-asset'].includes(x.class))){assert.ok(rule.selector.paths,rule.id);assert.equal(rule.productionReachable,false,rule.id);assert.equal(rule.bytesMustMatch,false,rule.id);assert.equal(rule.modeMustMatch,true,rule.id);}});
test('all characterization capsules remain data-only and contain no authority/credential/root/safety-disable keys',()=>{const forbidden=/(credential|secret|token|apiKey|handler|authorityGrant|filesystemRoot|workspaceRoot|disable.*(guard|safety|auth))/i;for(const name of fs.readdirSync(path.join(root,'trio/governance/capsules'))){const capsule=read('trio/governance/capsules/'+name);const keys=[];const visit=(v)=>{if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==='object')for(const [k,x] of Object.entries(v)){keys.push(k);visit(x);}};visit(capsule);assert.deepEqual(keys.filter((k)=>forbidden.test(k)),[],name);}});
test('all optional capability packs remain default-off with no implementation digest',()=>{for(const name of fs.readdirSync(path.join(root,'trio/governance/capability-packs'))){const pack=read('trio/governance/capability-packs/'+name);assert.equal(pack.base,false,name);assert.equal(pack.defaultActivation,false,name);assert.equal(pack.implementationDigest,null,name);}});
test('runtime manifest remains characterization-only, untrusted, undeployable, and divergent',()=>{const m=read('trio/governance/runtime-manifest.characterization.json');assert.equal(m.status,'characterization');assert.equal(m.trusted,false);assert.equal(m.deployable,false);assert.equal(m.verificationState,'divergent');});
// tui/src/server.ts no longer carries a blocker because the condition the blocker existed
// for was met, not waived: the file is governed by a behaviour-identical rule that requires
// byte identity, and it is excluded from the agent-owned tui/src tree so it cannot drift
// back. Enforced parity is a stronger statement than a tracked, expiring divergence, so the
// test asserts the enforcement rather than reinstating a blocker with nothing left to block.
test('the shared TUI server is enforced parity, and profile/UI/skills/compiled artifacts still have explicit blockers',()=>{const m=read('trio/governance/boundary-manifest.json');
  const rule=m.rules.find((x)=>(x.selector.paths??[]).includes('tui/src/server.ts'));
  assert.ok(rule,'tui/src/server.ts must be governed by an explicit rule');
  assert.equal(rule.class,'behavior-identical');
  assert.equal(rule.bytesMustMatch,true);
  assert.equal(rule.divergenceBlocking,true);
  assert.equal(m.blockingDivergences.some((x)=>x.path==='tui/src/server.ts'),false,'an enforced path must not also be excused as an intentional divergence');
  const tree=m.rules.find((x)=>x.selector.directory==='tui/src');
  assert.ok((tree.selector.excludedPaths??[]).includes('tui/src/server.ts'),'the shared server must stay outside the agent-owned tui/src tree');
  for(const p of ['src/profiles/agent.ts','ui','skills','dist'])assert.ok(m.blockingDivergences.some((x)=>x.path===p),p);});
test('.next and coverage are not exclusions and future files do not inherit a directory classification',()=>{const m=read('trio/governance/boundary-manifest.json'),inventory=read('trio/governance/path-inventory.json');assert.deepEqual(m.exclusions.map((x)=>x.path).sort(),['.git','node_modules','scripts/trio/node_modules','tui/node_modules']);assert.ok(!Object.values(inventory.rules).flat().includes('.next/server/future.js'));assert.ok(!Object.values(inventory.rules).flat().includes('coverage/future.js'));});
test('retained vulnerable fixture is exact, test-only, and absent from production package behavior',()=>{const fixture=read('scripts/trio/fixtures/vulnerable-trio-001c-c29223d2649bff467/fixture-manifest.json');assert.equal(fixture.files['verify-runtime-parity.mjs'],'sha256:c29223d2649bff4671e213562cd40aee7a9a3a4bd261f45a6801d025b3883342');assert.equal(fixture.productionImportAllowed,false);for(const file of ['package.json','tui/package.json'])assert.equal(JSON.stringify(read(file)).includes('scripts/trio/fixtures'),false,file);});
