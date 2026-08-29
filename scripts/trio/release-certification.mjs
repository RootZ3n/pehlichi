/**
 * Release certification for the parity verifier.
 *
 * A verifier that reports PARITY is making a claim about three repositories; this artifact
 * is the claim it has to make about itself first. Certification records that one exact
 * verifier release -- these implementation bytes, against these fixture bytes -- passed the
 * suites that give its verdict meaning.
 *
 * Certification is a *release step*, not something `verify()` performs. `verify()` only
 * recomputes two digests and compares them to the artifact, so a parity run never executes
 * a test suite and can never recurse into itself. Change one byte of the implementation or
 * one byte of a fixture and the digests move, the artifact no longer describes the code that
 * is running, and the verifier refuses to certify parity until the suites are re-run.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));

export const CERTIFICATION_CONTRACT=Object.freeze({
  version:'1.0.0',
  artifact:'certification.json',
  // Named explicitly rather than globbed: a glob would silently absorb a new file into the
  // certified set, which is the opposite of what a closed set is for.
  implementationFiles:Object.freeze([
    'verify-runtime-parity.mjs',
    'strict-json.mjs',
    'schema-validation.mjs',
    'agent-owned-ui.mjs',
    'secret-path-policy.mjs',
    'truth-release-binding.mjs',
    'release-certification.mjs'
  ]),
  fixtureFiles:Object.freeze([
    'verify-runtime-parity.test.mjs',
    'scaffolding.test.mjs',
    'schema-validation.test.mjs',
    'strict-json-differential.test.mjs',
    'mutation.test.mjs',
    'credential-nonread.test.mjs',
    'truth-identity.test.mjs',
    'vulnerable-six-reproduction.test.mjs',
    'preflight-hostile-audit.test.mjs',
    'certification.test.mjs'
  ]),
  fixtureTrees:Object.freeze(['fixtures']),
  /** Suites that must pass, and the exact counts the audit fixed as the bar. */
  requiredSuites:Object.freeze([
    {id:'hostile',file:'verify-runtime-parity.test.mjs',minimumTests:84},
    {id:'scaffolding',file:'scaffolding.test.mjs',minimumTests:8},
    {id:'schema',file:'schema-validation.test.mjs',minimumTests:1},
    {id:'strict-differential',file:'strict-json-differential.test.mjs',minimumTests:1},
    {id:'mutation',file:'mutation.test.mjs',minimumTests:1},
    {id:'credential-non-read',file:'credential-nonread.test.mjs',minimumTests:1},
    {id:'truth-identity',file:'truth-identity.test.mjs',minimumTests:1}
  ]),
  /**
   * Run and recorded, but not required by validateCertification.
   *
   * The certification suite's job is to check the artifact, so requiring its result *inside*
   * the artifact would mean the artifact had to exist and be complete before it could be
   * produced. It runs in a second phase against the finished artifact instead.
   */
  auditSuites:Object.freeze([
    {id:'certification',file:'certification.test.mjs',minimumTests:1}
  ])
});

const sha256=(data)=>crypto.createHash('sha256').update(data).digest('hex');

/** Frame each member as path/length/bytes so no rename or concatenation can collide. */
function framedTree(entries){
  const hash=crypto.createHash('sha256');
  for(const {key,bytes} of [...entries].sort((a,b)=>Buffer.from(a.key).compare(Buffer.from(b.key)))){
    const frame=Buffer.alloc(8);frame.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(`${key}\0`);hash.update(frame);hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function collect(root,relatives,trees=[]){
  const entries=[];
  for(const rel of relatives)entries.push({key:rel,bytes:fs.readFileSync(path.join(root,rel))});
  const visit=(dir,base)=>{
    for(const name of fs.readdirSync(dir).sort()){
      const full=path.join(dir,name);const rel=`${base}/${name}`;
      const stat=fs.lstatSync(full);
      if(stat.isDirectory())visit(full,rel);
      else if(stat.isFile())entries.push({key:rel,bytes:fs.readFileSync(full)});
    }
  };
  for(const tree of trees){const full=path.join(root,tree);if(fs.existsSync(full))visit(full,tree);}
  return entries;
}

export function computeImplementationDigest(root=here){
  return framedTree(collect(root,CERTIFICATION_CONTRACT.implementationFiles));
}
export function computeFixtureDigest(root=here){
  return framedTree(collect(root,CERTIFICATION_CONTRACT.fixtureFiles,CERTIFICATION_CONTRACT.fixtureTrees));
}

/**
 * Validate a certification artifact against the code that is running right now.
 *
 * Pure and cheap: two digests and a shape check. No test process is started.
 */
export function validateCertification(root=here){
  const artifactPath=path.join(root,CERTIFICATION_CONTRACT.artifact);
  let artifact;
  try{artifact=JSON.parse(fs.readFileSync(artifactPath,'utf8'));}
  catch(error){return {ok:false,problems:[{message:`verifier certification artifact is missing or unreadable: ${error.message}`}]};}
  const problems=[];
  const implementationDigest=computeImplementationDigest(root);
  const fixtureDigest=computeFixtureDigest(root);
  if(artifact.contractVersion!==CERTIFICATION_CONTRACT.version)problems.push({message:'certification artifact uses a different certification contract',expected:CERTIFICATION_CONTRACT.version,actual:artifact.contractVersion??null});
  if(artifact.implementationDigest!==implementationDigest)problems.push({message:'the running verifier implementation is not the certified one',certified:artifact.implementationDigest??null,running:implementationDigest});
  if(artifact.fixtureDigest!==fixtureDigest)problems.push({message:'the fixture set is not the certified one',certified:artifact.fixtureDigest??null,running:fixtureDigest});
  for(const required of CERTIFICATION_CONTRACT.requiredSuites){
    const suite=(artifact.suites??[]).find((s)=>s.id===required.id);
    if(!suite){problems.push({message:`certification is missing the ${required.id} suite`});continue;}
    if(suite.pass!==true)problems.push({message:`the certified ${required.id} suite did not pass`,suite});
    if(typeof suite.tests!=='number'||suite.tests<required.minimumTests)problems.push({message:`the certified ${required.id} suite ran fewer tests than the contract requires`,required:required.minimumTests,actual:suite.tests??null});
    if(suite.failures!==0)problems.push({message:`the certified ${required.id} suite recorded failures`,failures:suite.failures??null});
  }
  if(problems.length)return {ok:false,problems,implementationDigest,fixtureDigest};
  return {ok:true,certification:Object.freeze({
    contractVersion:artifact.contractVersion,
    implementationDigest,
    fixtureDigest,
    certificationDigest:artifact.certificationDigest,
    certifiedAt:artifact.certifiedAt,
    suites:artifact.suites
  })};
}

function runSuite(file){
  const result=cp.spawnSync(process.execPath,['--test',path.join(here,file)],{encoding:'utf8',maxBuffer:64*1024*1024,cwd:here});
  const output=`${result.stdout??''}${result.stderr??''}`;
  const num=(label)=>{const m=output.match(new RegExp(`^# ${label} (\\d+)$`,'m'));return m?Number(m[1]):null;};
  return {tests:num('tests'),passed:num('pass'),failures:num('fail'),pass:result.status===0&&num('fail')===0};
}

/** The release step. Runs each required suite once and writes the artifact. */
export function certify(){
  const artifactPath=path.join(here,CERTIFICATION_CONTRACT.artifact);
  const implementationDigest=computeImplementationDigest();
  const fixtureDigest=computeFixtureDigest();
  const write=(suites)=>{
    // The digest covers the claim and not its timestamp, so re-stamping the artifact cannot
    // quietly turn it into a different claim.
    const certificationDigest=`sha256:${sha256(JSON.stringify({contractVersion:CERTIFICATION_CONTRACT.version,implementationDigest,fixtureDigest,suites}))}`;
    const artifact={contractVersion:CERTIFICATION_CONTRACT.version,implementationDigest,fixtureDigest,suites,certifiedAt:new Date().toISOString(),certificationDigest};
    fs.writeFileSync(artifactPath,`${JSON.stringify(artifact,null,1)}\n`);
    return artifact;
  };
  // Phase 1: the suites that give the verdict its meaning, recorded as the artifact.
  const suites=CERTIFICATION_CONTRACT.requiredSuites.map((required)=>({id:required.id,file:required.file,...runSuite(required.file)}));
  write(suites);
  // Phase 2: audit the finished artifact. It now describes the running bytes, so the
  // certification suite has something real to check.
  const audited=[...suites,...CERTIFICATION_CONTRACT.auditSuites.map((extra)=>({id:extra.id,file:extra.file,required:false,...runSuite(extra.file)}))];
  return write(audited);
}

if(process.argv[1]!==undefined&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const artifact=certify();
  const failed=artifact.suites.filter((s)=>!s.pass);
  for(const suite of artifact.suites)process.stdout.write(`${suite.pass?'PASS':'FAIL'} ${suite.id} tests=${suite.tests} fail=${suite.failures}\n`);
  process.stdout.write(`certificationDigest=${artifact.certificationDigest}\nimplementationDigest=${artifact.implementationDigest}\nfixtureDigest=${artifact.fixtureDigest}\n`);
  process.exit(failed.length?1:0);
}
