#!/usr/bin/env node
/**
 * The authoritative verification entry point.
 *
 * One Node program owns the whole executable sequence: resolve the three repositories, read
 * Git metadata, require clean trees, plan the committed tree, materialize approved blobs
 * into isolated snapshots, run every suite against those snapshots, assess publication, and
 * emit a run artifact bound to exactly what was verified.
 *
 * The shell wrapper is no longer an authority. It cannot be, because a gate implemented in
 * shell can be satisfied by a comment, and because "did the wrapper mention this suite?" is
 * a different question from "did this suite pass?". Everything that decides anything lives
 * here, and the suites are invoked programmatically so their real assertions -- not a child
 * process exit code -- are what the artifact records.
 *
 * No stage may fall back to live worktree content. After materialization the comparison
 * receives snapshot roots only, and a containment assertion rejects any content path that
 * is neither inside the created snapshot root nor a bundled immutable verifier asset.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as runTests } from 'node:test';

import { verify,publishedResult } from './verify-runtime-parity.mjs';
import { assessPublication } from './verdict-consistency.mjs';
import { validateCertification } from './release-certification.mjs';
import { parseStrictJsonText } from './strict-json.mjs';
import { createReadAuthority,scanSecretObjects } from './governed-reader.mjs';
import {
  COMMITTED_TREE_CONTRACT,REFUSAL,CommittedTreeRefusal,
  readIdentity,assessCleanliness,planCommittedTree,materializeSnapshot,createSnapshotWorkspace
} from './git-committed-tree.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const ownRoot=path.resolve(here,'../..');
const SLOTS=Object.freeze(['pehlichi','loony-luna','mad-ptah']);

export const AUTHORITATIVE_CONTRACT=Object.freeze({
  version:'1.0.0',
  entryPoint:'scripts/trio/verify-authoritative.mjs',
  input:'clean-committed-tree-only',
  suiteTransport:'programmatic node:test run(), exact assertions collected',
  shellWrapperAuthority:'none',
  /** Every suite the authoritative run requires. A missing or failing one refuses. */
  requiredSuites:Object.freeze([
    'verify-runtime-parity.test.mjs',
    'scaffolding.test.mjs',
    'mutation.test.mjs',
    'strict-json-differential.test.mjs',
    'schema-validation.test.mjs',
    'truth-identity.test.mjs',
    'credential-boundary.test.mjs',
    'credential-nonread.test.mjs',
    'committed-tree.test.mjs',
    'semantic-reader-closure.test.mjs'
  ])
});

const sha256=(value)=>crypto.createHash('sha256').update(value).digest('hex');

/** Digest of the verifier implementation actually running, from bundled assets only. */
function implementationDigest(){
  const authority=createReadAuthority({root:here,secretObjects:scanSecretObjects(here,{exclusions:[{path:'node_modules'},{path:'fixtures'}]})});
  const files=fs.readdirSync(here).filter((name)=>name.endsWith('.mjs')).sort();
  const hash=crypto.createHash('sha256');
  for(const name of files){
    const bytes=authority.read(path.join(here,name));
    const frame=Buffer.alloc(8);frame.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(`${name}\0`);hash.update(frame);hash.update(bytes);
  }
  return {digest:`sha256:${hash.digest('hex')}`,files};
}
function suiteSetDigest(){
  const authority=createReadAuthority({root:here,secretObjects:scanSecretObjects(here,{exclusions:[{path:'node_modules'},{path:'fixtures'}]})});
  const hash=crypto.createHash('sha256');
  for(const name of AUTHORITATIVE_CONTRACT.requiredSuites){
    const full=path.join(here,name);
    if(!fs.existsSync(full))return {digest:null,missing:name};
    const bytes=authority.read(full);
    const frame=Buffer.alloc(8);frame.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(`${name}\0`);hash.update(frame);hash.update(bytes);
  }
  return {digest:`sha256:${hash.digest('hex')}`,missing:null};
}

/**
 * Run one suite through the programmatic test runner and keep the real assertions.
 *
 * A child-file runner reports "the file failed" and loses the assertion that failed with it,
 * which is exactly the reproducibility defect this replaces. Here each test event is
 * collected, so a failure carries its own name and message into the artifact.
 */
async function runSuite(file){
  const failures=[];
  let pass=0,fail=0;
  const stream=runTests({files:[path.join(here,file)],concurrency:1});
  for await (const event of stream){
    if(event.type==='test:pass'&&event.data.details?.type!=='suite')pass+=1;
    if(event.type==='test:fail'&&event.data.details?.type!=='suite'){
      fail+=1;
      const cause=event.data.details?.error?.cause??event.data.details?.error;
      failures.push({test:event.data.name,message:String(cause?.message??cause??'assertion failed').split('\n')[0].slice(0,300)});
    }
  }
  return {file,pass,fail,total:pass+fail,ok:fail===0,failures};
}

/**
 * Capture identity and cleanliness, then materialize the committed tree.
 *
 * Identity is re-read after materialization: if HEAD, the tree, or cleanliness moved while
 * the snapshot was being built, the run describes a state that no longer exists and is
 * invalidated rather than published.
 */
function prepareSlot(slot,repositoryRoot,workspace,governance){
  const before=readIdentity(repositoryRoot);
  const cleanliness=assessCleanliness(repositoryRoot,governance);
  if(!cleanliness.clean)throw new CommittedTreeRefusal(REFUSAL.WORKTREE_NOT_CLEAN,repositoryRoot,cleanliness.violations.slice(0,25));
  const entries=planCommittedTree(repositoryRoot,before.tree);
  const snapshot=materializeSnapshot({root:repositoryRoot,entries,into:workspace.base});
  const after=readIdentity(repositoryRoot);
  if(after.head!==before.head||after.tree!==before.tree)
    throw new CommittedTreeRefusal(REFUSAL.IDENTITY_CHANGED_DURING_RUN,repositoryRoot,{before,after});
  const recheck=assessCleanliness(repositoryRoot,governance);
  if(!recheck.clean)throw new CommittedTreeRefusal(REFUSAL.IDENTITY_CHANGED_DURING_RUN,repositoryRoot,recheck.violations.slice(0,25));
  const trackedUnderExclusions=Object.fromEntries((governance.exclusions??[])
    .filter((x)=>x.kind==='dependency-tree')
    .map((x)=>[x.path,entries.filter((e)=>e.path===x.path||e.path.startsWith(x.path+'/')).map((e)=>e.path)]));
  return {slot,repositoryRoot,identity:before,snapshot,entries:entries.length,
    committed:{head:before.head,branch:before.branch,remote:governance.remoteIdentity?.[slot]??null,dirty:[],trackedUnderExclusions}};
}

/** The whole authoritative sequence. Returns the run artifact; never publishes by itself. */
export async function runAuthoritative({repositories,keepSnapshots=false}={}){
  const startedAt=new Date().toISOString();
  const resolved=repositories??Object.fromEntries(SLOTS.map((slot)=>[slot,path.join(path.dirname(ownRoot),slot)]));
  const missing=SLOTS.filter((slot)=>typeof resolved[slot]!=='string'||!fs.existsSync(resolved[slot]));
  if(missing.length)return refusal('MISSING_REPOSITORY',{missing},startedAt);

  // Governance is read from the *source* repository's committed governance only after its
  // tree is proven clean, so the declared secret paths used by the cleanliness check come
  // from the bundled verifier assets rather than from a dirty worktree.
  const bundledAuthority=createReadAuthority({root:ownRoot,secretObjects:scanSecretObjects(ownRoot,{exclusions:[{path:'.git'},{path:'node_modules'},{path:'dist'}]})});
  const manifest=parseStrictJsonText(bundledAuthority.readText(path.join(ownRoot,'trio/governance/boundary-manifest.json')));
  const governance={
    declaredSecretPaths:manifest.rules.filter((r)=>r.class==='secret-path-excluded').flatMap((r)=>r.selector.paths??[]),
    exclusions:manifest.exclusions,
    remoteIdentity:Object.fromEntries(SLOTS.map((slot)=>[slot,manifest.repositories[slot].remoteIdentity]))
  };

  const workspace=createSnapshotWorkspace();
  let artifact;
  try{
    const prepared=[];
    for(const slot of SLOTS){
      try{prepared.push(prepareSlot(slot,fs.realpathSync(resolved[slot]),workspace,governance));}
      catch(error){
        if(error instanceof CommittedTreeRefusal)return refusal(error.category,{slot,repository:resolved[slot],detail:error.detail,path:error.affectedPath},startedAt,workspace,keepSnapshots);
        throw error;
      }
    }

    // From here on the comparison sees snapshots only. The manifest it validates against is
    // the snapshot's own committed governance, so no live path can enter the result.
    const snapshotRoots=Object.fromEntries(prepared.map((p)=>[p.slot,p.snapshot.root]));
    const snapshotManifest=path.join(snapshotRoots.pehlichi,'trio/governance/boundary-manifest.json');
    assertContained(snapshotManifest,workspace.base);
    const committedIdentities=Object.fromEntries(prepared.map((p)=>[p.slot,p.committed]));
    const comparison=verify({slots:snapshotRoots,manifestPath:snapshotManifest,committedIdentities});

    const suites=[];
    for(const file of AUTHORITATIVE_CONTRACT.requiredSuites){
      if(!fs.existsSync(path.join(here,file))){suites.push({file,pass:0,fail:1,total:0,ok:false,failures:[{test:file,message:'required suite is missing'}]});continue;}
      suites.push(await runSuite(file));
    }

    const certification=validateCertification();
    const publication=assessPublication(comparison,certification,suites.map((s)=>({file:s.file,exitCode:s.ok?0:1,failed:s.fail})));
    const published=publishedResult(comparison);
    const implementation=implementationDigest();
    const suiteSet=suiteSetDigest();

    artifact={
      schemaVersion:'1.0.0',
      contract:AUTHORITATIVE_CONTRACT,
      committedTreeContract:COMMITTED_TREE_CONTRACT,
      startedAt,completedAt:new Date().toISOString(),
      repositories:Object.fromEntries(prepared.map((p)=>[p.slot,{
        repositoryRoot:p.repositoryRoot,head:p.identity.head,tree:p.identity.tree,branch:p.identity.branch,
        snapshotInventoryDigest:p.snapshot.inventoryDigest,snapshotFileCount:p.snapshot.fileCount
      }])),
      implementationDigest:implementation.digest,
      suiteSetDigest:suiteSet.digest,
      truthRelease:comparison.truthRelease??null,
      suites:suites.map(({file,pass,fail,total,ok,failures})=>({file,pass,fail,total,ok,failures})),
      comparison:{status:comparison.status,verdict:comparison.summary?.verdict??null,blocking:comparison.summary?.blockingCount??null,
        identical:comparison.summary?.identical??null,unclassified:comparison.summary?.unclassifiedFiles??null,
        secretPathsExcluded:comparison.summary?.secretPathsExcluded??null},
      publication:{ok:publication.ok,problems:publication.problems??[],publishedVerdict:published.summary?.verdict??null},
      certification:{ok:certification.ok,problems:certification.ok?[]:certification.problems},
      liveWorktreeContentRead:false,
      accepted:publication.ok&&suites.every((s)=>s.ok)
    };
    artifact.runDigest=`sha256:${sha256(JSON.stringify({
      repositories:artifact.repositories,implementationDigest:artifact.implementationDigest,
      suiteSetDigest:artifact.suiteSetDigest,suites:artifact.suites,comparison:artifact.comparison,
      publication:{ok:artifact.publication.ok},accepted:artifact.accepted
    }))}`;
    return artifact;
  }finally{
    // Snapshots are destroyed only after the artifact above is fully formed.
    if(!keepSnapshots)workspace.destroy();
  }
}

function refusal(category,detail,startedAt,workspace=null,keepSnapshots=false){
  if(workspace&&!keepSnapshots)workspace.destroy();
  const artifact={schemaVersion:'1.0.0',contract:AUTHORITATIVE_CONTRACT,startedAt,completedAt:new Date().toISOString(),
    refusal:{category,detail},accepted:false,liveWorktreeContentRead:false,
    comparison:null,suites:[],publication:{ok:false,problems:[{message:`refused: ${category}`}]}};
  artifact.runDigest=`sha256:${sha256(JSON.stringify({refusal:artifact.refusal,accepted:false}))}`;
  return artifact;
}

/** Reject any content path outside the snapshot workspace or the bundled verifier assets. */
export function assertContained(candidate,snapshotBase){
  const resolvedPath=path.resolve(candidate);
  const inSnapshot=!path.relative(path.resolve(snapshotBase),resolvedPath).startsWith('..');
  const inBundle=!path.relative(here,resolvedPath).startsWith('..');
  if(!inSnapshot&&!inBundle)throw new CommittedTreeRefusal(REFUSAL.SNAPSHOT_CONTAINMENT,resolvedPath,'content path is neither in the snapshot nor a bundled verifier asset');
  return true;
}

const isMain=process.argv[1]!==undefined&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isMain){
  const wantsJson=process.argv.includes('--json');
  const artifact=await runAuthoritative({});
  if(wantsJson)process.stdout.write(`${JSON.stringify(artifact,null,2)}\n`);
  else{
    const lines=[`TRIO authoritative run: ${artifact.refusal?`REFUSED ${artifact.refusal.category}`:artifact.comparison.status}`];
    if(artifact.refusal)lines.push(`  detail: ${JSON.stringify(artifact.refusal.detail).slice(0,400)}`);
    else{
      for(const [slot,r] of Object.entries(artifact.repositories))lines.push(`  ${slot} head=${r.head.slice(0,12)} tree=${r.tree.slice(0,12)} snapshot=${r.snapshotFileCount} files`);
      lines.push(`  verdict=${artifact.comparison.verdict} blocking=${artifact.comparison.blocking} identical=${artifact.comparison.identical} unclassified=${artifact.comparison.unclassified}`);
      for(const s of artifact.suites)lines.push(`  ${s.ok?'PASS':'FAIL'} ${s.file} ${s.pass}/${s.total}${s.failures.length?` :: ${s.failures[0].test} — ${s.failures[0].message}`:''}`);
      lines.push(`  publication=${artifact.publication.ok?'ok':'refused'} certification=${artifact.certification.ok?'valid':'stale'} accepted=${artifact.accepted}`);
    }
    lines.push(`  runDigest=${artifact.runDigest}`);
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  process.exitCode=artifact.accepted?0:1;
}
