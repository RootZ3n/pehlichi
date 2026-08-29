/**
 * Publication mutations: every way a bundle can lie about its own outcome.
 *
 * The evidence writer used to decide success by comparing the verdict to a hardcoded
 * expectation. These tests exist so the replacement cannot quietly become the same mistake
 * pointed the other way. Both genuine outcomes must publish, and every incoherent
 * combination of status, verdict, counters, failure list and certification must fail closed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessPublication,PUBLICATION_CONTRACT,securityEvidenceRefusal } from './verdict-consistency.mjs';
import { validateCertification,CERTIFICATION_CONTRACT } from './release-certification.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const certification=validateCertification();
const digest=()=>certification.ok?certification.certification.certificationDigest:'sha256:'+'0'.repeat(64);

const parityResult=()=>({
  status:'VERIFIER_OK_PARITY',
  failures:[],
  summary:{verdict:'PARITY',blockingCount:0,blockingByClass:{},unclassifiedFiles:0,quarantined:0,missingBehaviorFiles:0,contentValidationFailures:0},
  verifierCertification:{certificationDigest:digest()}
});
const divergenceResult=()=>({
  status:'VERIFIER_OK_DIVERGENCE',
  failures:[{failureClass:'BEHAVIOR_DIVERGENCE',affectedPath:'package.json'},{failureClass:'BEHAVIOR_DIVERGENCE',affectedPath:'stress_test.py'}],
  summary:{verdict:'BLOCKING_DIVERGENCE',blockingCount:2,blockingByClass:{BEHAVIOR_DIVERGENCE:2},unclassifiedFiles:0,quarantined:0,missingBehaviorFiles:0,contentValidationFailures:0},
  verifierCertification:{certificationDigest:digest()}
});

const ok=(r,suites=[])=>assessPublication(r,certification,suites);
const expectRejected=(r,match,suites=[])=>{
  const a=ok(r,suites);
  assert.equal(a.ok,false,'an incoherent bundle was accepted');
  assert.ok(a.problems.some((p)=>match.test(p.message)),`expected a problem matching ${match}; got ${JSON.stringify(a.problems.map((p)=>p.message))}`);
};

test('the running verifier is certified, so these fixtures test consistency rather than staleness',()=>{
  assert.equal(certification.ok,true,JSON.stringify(certification.problems));
});

// (1) and (2): both genuine outcomes publish.
test('a valid PARITY bundle is publishable',()=>{
  const a=ok(parityResult());
  assert.equal(a.ok,true,JSON.stringify(a.problems));
  assert.equal(a.verdict,'PARITY');
});
test('a valid BLOCKING_DIVERGENCE bundle is publishable',()=>{
  const a=ok(divergenceResult());
  assert.equal(a.ok,true,JSON.stringify(a.problems));
  assert.equal(a.verdict,'BLOCKING_DIVERGENCE');
});

// (3)-(6): status, verdict and counters must describe the same run.
test('PARITY with blocking findings fails',()=>{
  const r=parityResult();r.summary.blockingCount=1;r.failures=[{failureClass:'BEHAVIOR_DIVERGENCE'}];
  expectRejected(r,/parity is claimed with blocking findings/);
});
test('PARITY with unclassified files fails',()=>{
  const r=parityResult();r.summary.unclassifiedFiles=2;
  expectRejected(r,/parity is claimed with unclassified files/);
});
test('divergence status paired with a PARITY verdict fails',()=>{
  const r=divergenceResult();r.summary.verdict='PARITY';
  expectRejected(r,/divergence status is paired with a non-divergence verdict/);
});
test('parity status paired with a BLOCKING_DIVERGENCE verdict fails',()=>{
  const r=parityResult();r.summary.verdict='BLOCKING_DIVERGENCE';
  expectRejected(r,/parity status is paired with a non-parity verdict/);
});

// (7) and (8): absent or malformed shape is never assumed benign.
test('a missing verdict fails',()=>{
  const r=parityResult();delete r.summary.verdict;
  expectRejected(r,/no verdict/);
});
test('a missing summary fails',()=>{
  const r=parityResult();delete r.summary;
  expectRejected(r,/no summary object/);
});
test('a missing status fails',()=>{
  const r=parityResult();delete r.status;
  expectRejected(r,/no status/);
});
test('malformed counts fail',()=>{
  for(const bad of ['0',-1,1.5,null,Number.NaN]){
    const r=parityResult();r.summary.blockingCount=bad;
    expectRejected(r,/blockingCount is not a non-negative integer/);
  }
});
test('a failure list that contradicts the blocking count fails',()=>{
  const r=divergenceResult();r.summary.blockingCount=5;
  expectRejected(r,/does not match the number of reported failures/);
});
test('a class breakdown that does not sum to the blocking count fails',()=>{
  const r=divergenceResult();r.summary.blockingByClass={BEHAVIOR_DIVERGENCE:1};
  expectRejected(r,/does not sum to/);
});
test('divergence claimed with no blocking condition at all fails',()=>{
  const r=divergenceResult();r.failures=[];r.summary.blockingCount=0;r.summary.blockingByClass={};
  expectRejected(r,/divergence is claimed without any blocking condition/);
});
test('a divergence justified by a non-blockingCount condition is still publishable',()=>{
  // "blocking>0 or another explicitly defined blocking condition" -- quarantined content
  // justifies a divergence without being rejected for failing to match one hardcoded shape.
  const r=divergenceResult();
  r.summary.quarantined=3;
  const a=ok(r);
  assert.equal(a.ok,true,JSON.stringify(a.problems));
  assert.ok(PUBLICATION_CONTRACT.blockingConditions.includes('quarantined'));
});
test('an unrecognised status is not publishable',()=>{
  for(const status of ['VERIFIER_ERROR','SCHEMA_INVALID','TRUTH_IDENTITY_MISMATCH','VERIFIER_UNCERTIFIED','',null]){
    const r=parityResult();r.status=status;
    const a=ok(r);
    assert.equal(a.ok,false,`status ${String(status)} must not publish`);
  }
});
test('a security-blocked verifier result cannot be published',()=>{
  const r={
    status:'VERIFIER_SECURITY_BLOCKED',
    failures:[{failureClass:'SECRET_READ_REFUSED',affectedPath:'trio/runtime-closure.json',details:{category:'credential-object-alias',contentsRead:false}}],
    summary:{verdict:'VERIFIER_SECURITY_BLOCKED',blockingCount:1,blockingByClass:{SECRET_READ_REFUSED:1},unclassifiedFiles:0,quarantined:0,missingBehaviorFiles:0,contentValidationFailures:0},
    verifierCertification:{certificationDigest:digest()}
  };
  const a=ok(r);
  assert.equal(a.ok,false);
  assert.ok(a.problems.some((p)=>p.message==='verifier status is not a publishable outcome'));
  const refusal=securityEvidenceRefusal(r);
  assert.deepEqual(Object.keys(refusal).sort(),['category','contentsRead','errorCode','relativePath','status','verifierStatus']);
  assert.equal(refusal.status,'EVIDENCE_REFUSED');
  assert.equal(refusal.contentsRead,false);
});
test('a result that is not an object fails closed',()=>{
  for(const value of [null,undefined,'PARITY',[],42])assert.equal(assessPublication(value,certification).ok,false);
});

// (9): certification must cover the verifier that produced the result.
test('an uncertified verifier cannot publish',()=>{
  const stale={ok:false,problems:[{message:'the running verifier implementation is not the certified one'}]};
  const a=assessPublication(parityResult(),stale);
  assert.equal(a.ok,false);
  assert.ok(a.problems.some((p)=>/not certified/.test(p.message)));
});
test('a result carrying an explicitly uncertified record fails',()=>{
  const r=parityResult();r.verifierCertification={certified:false,problems:[{message:'artifact missing'}]};
  expectRejected(r,/explicitly uncertified record/);
});
test('a result carrying no certification record fails',()=>{
  const r=parityResult();delete r.verifierCertification;
  expectRejected(r,/carries no certification record/);
});
test('an embedded certification digest from a different release fails',()=>{
  const r=parityResult();r.verifierCertification={certificationDigest:'sha256:'+'1'.repeat(64)};
  expectRejected(r,/not the digest of the running verifier/);
});
test('a failing supporting suite fails the publication',()=>{
  expectRejected(parityResult(),/supporting suite did not pass/,[{file:'hostile',exitCode:1,failed:13}]);
  expectRejected(parityResult(),/supporting suite reported failures/,[{file:'hostile',exitCode:0,failed:2}]);
});

// (10): certification is bound to the bytes that produced the result.
function copyDirectory(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'trio-publication-'));
  const root=path.join(dir,'trio');
  fs.cpSync(here,root,{recursive:true,dereference:false,filter:(src)=>!src.includes(`${path.sep}node_modules`)});
  return {dir,root};
}
test('a one-byte implementation change invalidates certification and blocks publication',()=>{
  const {dir,root}=copyDirectory();
  try{
    fs.appendFileSync(path.join(root,'verdict-consistency.mjs'),'\n// one byte of drift\n');
    const drifted=validateCertification(root);
    assert.equal(drifted.ok,false);
    assert.ok(drifted.problems.some((p)=>/implementation is not the certified one/.test(p.message)));
    assert.equal(assessPublication(parityResult(),drifted).ok,false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a one-byte fixture change invalidates certification and blocks publication',()=>{
  const {dir,root}=copyDirectory();
  try{
    fs.appendFileSync(path.join(root,'publication-consistency.test.mjs'),'\n// one byte of drift\n');
    const drifted=validateCertification(root);
    assert.equal(drifted.ok,false);
    assert.ok(drifted.problems.some((p)=>/fixture set is not the certified one/.test(p.message)));
    assert.equal(assessPublication(parityResult(),drifted).ok,false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a certification artifact claiming a failed suite blocks publication',()=>{
  const {dir,root}=copyDirectory();
  try{
    const p=path.join(root,CERTIFICATION_CONTRACT.artifact);
    const artifact=JSON.parse(fs.readFileSync(p,'utf8'));
    artifact.suites.find((s)=>s.id==='hostile').pass=false;
    fs.writeFileSync(p,JSON.stringify(artifact,null,1));
    const bad=validateCertification(root);
    assert.equal(bad.ok,false);
    assert.equal(assessPublication(parityResult(),bad).ok,false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
