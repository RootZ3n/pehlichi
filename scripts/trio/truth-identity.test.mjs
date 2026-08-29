/**
 * Bind, and prove the binding.
 *
 * The old pin was believed because it was written down. These tests check the opposite
 * habit: the release the wrapper actually executes is resolved, its closure is recomputed
 * from its own bytes, and every field the Trio pins is compared against the measurement
 * rather than against the release's self-description. A pin that cannot be reproduced is a
 * mismatch, and a mismatch fails closed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyTruthRelease,resolveActivatedRelease,measurePackageClosure,TRUTH_BINDING_CONTRACT } from './truth-release-binding.mjs';
import { readStrictJson } from './strict-json.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));const projectRoot=path.resolve(here,'../..');
const manifest=readStrictJson(path.join(projectRoot,'trio/governance/boundary-manifest.json'));
const pin=manifest.truthRelease;

test('the governance manifest pins a Truth release with a reproducible validation method',()=>{
  assert.equal(pin.validationMethod,TRUTH_BINDING_CONTRACT.validationMethod);
  assert.match(pin.releaseId,/^[0-9a-f]{32}$/);
  assert.match(pin.packageClosureSha256,/^[0-9a-f]{64}$/);
  assert.match(pin.sourceCommit,/^[0-9a-f]{40}$/);
});

test('the activation wrapper names the release that actually executes',()=>{
  const resolved=resolveActivatedRelease(pin.activationWrapper);
  assert.equal(resolved.ok,true);
  assert.ok(path.isAbsolute(resolved.entrypoint));
  assert.equal(path.basename(resolved.releaseRoot),pin.releaseId,'the wrapper executes a different release than the one pinned');
});

test('the pinned closure is reproduced by independent measurement, not read from the release',()=>{
  const resolved=resolveActivatedRelease(pin.activationWrapper);
  const measured=measurePackageClosure(resolved.releaseRoot);
  assert.equal(measured.sha256,pin.packageClosureSha256);
  assert.equal(measured.fileCount,pin.packageClosureFileCount);
  // And the release's own manifest agrees with the measurement, so the two independent
  // statements about this release are consistent rather than merely both present.
  const own=JSON.parse(fs.readFileSync(path.join(resolved.releaseRoot,'release-manifest.json'),'utf8'));
  assert.equal(own.packageClosureSha256,measured.sha256);
  assert.equal(own.packageClosureFileCount,measured.fileCount);
});

test('the activated release verifies against the pin',()=>{
  const outcome=verifyTruthRelease(pin);
  assert.equal(outcome.ok,true,JSON.stringify(outcome.problems));
  assert.equal(outcome.identity.releaseId,pin.releaseId);
  assert.equal(outcome.identity.validationMethod,'recomputed-package-closure');
  assert.equal(outcome.identity.credentialsRead,false);
});

for(const [label,override] of [
  ['release id',{releaseId:'0'.repeat(32)}],
  ['closure digest',{packageClosureSha256:'0'.repeat(64)}],
  ['closure file count',{packageClosureFileCount:1}],
  ['version',{version:'99.99.99'}],
  ['source commit',{sourceCommit:'0'.repeat(40)}]
])test(`a pinned ${label} that does not match the activated authority fails closed`,()=>{
  const outcome=verifyTruthRelease({...pin,...override});
  assert.equal(outcome.ok,false);
  assert.ok(outcome.problems.length>0);
});

test('an unresolvable activation wrapper fails closed rather than defaulting to trust',()=>{
  const missing=path.join(os.tmpdir(),'trio-truth-absent-wrapper-does-not-exist');
  const outcome=verifyTruthRelease({...pin,activationWrapper:missing});
  assert.equal(outcome.ok,false);
  assert.match(outcome.problems[0].message,/unreadable/);
});

test('a wrapper that names no Node entrypoint fails closed',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'trio-truth-wrapper-'));
  try{
    const wrapper=path.join(dir,'truth');
    fs.writeFileSync(wrapper,'#!/bin/sh\necho "not an activation"\n');
    const outcome=verifyTruthRelease({...pin,activationWrapper:wrapper});
    assert.equal(outcome.ok,false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('a declaration with no binding fields is refused, so documentation cannot stand in for proof',()=>{
  assert.equal(verifyTruthRelease(null).ok,false);
  assert.equal(verifyTruthRelease({specifier:'truth-firewall',attestation:'trust me'}).ok,false);
  assert.equal(verifyTruthRelease({...pin,kind:'documentation-only'}).ok,false);
});

test('every repository runtime closure pins the activated authority',()=>{
  const ecosystem=path.resolve(projectRoot,'..');
  for(const slot of ['pehlichi','loony-luna','mad-ptah']){
    const closurePath=path.join(ecosystem,slot,pin.runtimeClosureDeclarationPath);
    const closure=readStrictJson(closurePath);
    const declared=(closure.legitimateExternalDependencies??[]).find((d)=>d.specifier===pin.specifier);
    assert.ok(declared,`${slot} declares no Truth release`);
    assert.equal(declared.releaseId,pin.releaseId,slot);
    assert.equal(declared.packageClosureSha256,pin.packageClosureSha256,slot);
    assert.equal(declared.packageClosureFileCount,pin.packageClosureFileCount,slot);
  }
});
