/**
 * The certification gate, and what invalidates it.
 *
 * These tests exist so "the verifier certifies itself" is checkable rather than decorative.
 * They prove the artifact describes the running bytes, that a one-byte change to either the
 * implementation or the fixture set invalidates it, and that an uncertified verifier cannot
 * reach PARITY. Nothing here runs a parity suite: the gate is a digest comparison, which is
 * exactly why it cannot recurse.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCertification,computeImplementationDigest,computeFixtureDigest,CERTIFICATION_CONTRACT } from './release-certification.mjs';
import { publishedResult } from './verify-runtime-parity.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));

/** A throwaway copy of the verifier directory, so mutations never touch the real one. */
function copyDirectory(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'trio-certification-'));
  const root=path.join(dir,'trio');
  fs.cpSync(here,root,{recursive:true,dereference:false,filter:(src)=>!src.includes(`${path.sep}node_modules`)});
  return {dir,root};
}

test('the shipped verifier is certified for exactly the bytes that are running',()=>{
  const outcome=validateCertification();
  assert.equal(outcome.ok,true,JSON.stringify(outcome.problems));
  assert.equal(outcome.certification.implementationDigest,computeImplementationDigest());
  assert.equal(outcome.certification.fixtureDigest,computeFixtureDigest());
  assert.match(outcome.certification.certificationDigest,/^sha256:[0-9a-f]{64}$/);
});

test('the certification covers every required suite with no failures',()=>{
  const {certification}=validateCertification();
  for(const required of CERTIFICATION_CONTRACT.requiredSuites){
    const suite=certification.suites.find((s)=>s.id===required.id);
    assert.ok(suite,`missing suite ${required.id}`);
    assert.equal(suite.pass,true,required.id);
    assert.equal(suite.failures,0,required.id);
    assert.ok(suite.tests>=required.minimumTests,`${required.id}: ${suite.tests} < ${required.minimumTests}`);
  }
});

test('a one-byte implementation change invalidates the certification',()=>{
  const {dir,root}=copyDirectory();
  try{
    const target=path.join(root,'secret-path-policy.mjs');
    fs.appendFileSync(target,'\n// one byte of drift\n');
    const outcome=validateCertification(root);
    assert.equal(outcome.ok,false);
    assert.ok(outcome.problems.some((p)=>/implementation is not the certified one/.test(p.message)));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('a one-byte fixture change invalidates the certification',()=>{
  const {dir,root}=copyDirectory();
  try{
    fs.appendFileSync(path.join(root,'mutation.test.mjs'),'\n// one byte of drift\n');
    const outcome=validateCertification(root);
    assert.equal(outcome.ok,false);
    assert.ok(outcome.problems.some((p)=>/fixture set is not the certified one/.test(p.message)));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('a missing certification artifact fails closed',()=>{
  const {dir,root}=copyDirectory();
  try{
    fs.rmSync(path.join(root,CERTIFICATION_CONTRACT.artifact));
    const outcome=validateCertification(root);
    assert.equal(outcome.ok,false);
    assert.match(outcome.problems[0].message,/missing or unreadable/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('a certification claiming a failed or short suite is refused',()=>{
  const {dir,root}=copyDirectory();
  try{
    const p=path.join(root,CERTIFICATION_CONTRACT.artifact);
    const artifact=JSON.parse(fs.readFileSync(p,'utf8'));
    const hostile=artifact.suites.find((s)=>s.id==='hostile');
    hostile.pass=false;hostile.failures=13;hostile.tests=71;
    fs.writeFileSync(p,JSON.stringify(artifact,null,1));
    const outcome=validateCertification(root);
    assert.equal(outcome.ok,false);
    assert.ok(outcome.problems.some((x)=>/hostile suite did not pass/.test(x.message)));
    assert.ok(outcome.problems.some((x)=>/fewer tests than the contract requires/.test(x.message)));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('an uncertified verifier cannot publish parity',()=>{
  // The gate sits at the publication boundary, so this is exercised directly on it: a result
  // that would otherwise read PARITY is downgraded and carries the reason.
  const parity={status:'VERIFIER_OK_PARITY',failures:[],summary:{verdict:'PARITY',blockingCount:0,blockingByClass:{}},
    verifierCertification:{certified:false,problems:[{message:'the running verifier implementation is not the certified one'}]}};
  const published=publishedResult(parity);
  assert.notEqual(published.summary.verdict,'PARITY');
  assert.equal(published.summary.verdict,'VERIFIER_UNCERTIFIED');
  assert.equal(published.status,'VERIFIER_UNCERTIFIED');
  assert.ok(published.failures.some((f)=>f.failureClass==='VERIFIER_UNCERTIFIED'));
  assert.ok(published.summary.blockingCount>0);
});

test('a certified result passes through publication unchanged',()=>{
  const parity={status:'VERIFIER_OK_PARITY',failures:[],summary:{verdict:'PARITY',blockingCount:0,blockingByClass:{}},
    verifierCertification:validateCertification().certification};
  assert.equal(publishedResult(parity).summary.verdict,'PARITY');
});
