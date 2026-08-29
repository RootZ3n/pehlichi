/**
 * Committed-tree boundary: adversarial acceptance.
 *
 * Every fixture here is a disposable Git repository built under a fresh mktemp root, with
 * dummy sentinels standing in for credentials. The claim under test is not "the verifier
 * coped with a hostile worktree" but "the verifier never consumed one": a dirty tree is
 * refused before anything is opened, and a clean tree is reduced to approved committed blobs
 * before comparison ever begins.
 *
 * The interesting cases are the ones that used to be dangerous. A hard link or a symlink in
 * a working copy is no longer a subtle aliasing question -- it is either dirty, and refused,
 * or it is not in the tree at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  COMMITTED_TREE_CONTRACT,REFUSAL,CommittedTreeRefusal,
  readIdentity,assessCleanliness,planCommittedTree,materializeSnapshot,createSnapshotWorkspace
} from './git-committed-tree.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const SENTINEL='COMMITTED-TREE-DUMMY-SENTINEL-3c81f';
const GOVERNANCE={declaredSecretPaths:['.env','tui/.env'],exclusions:[{path:'.git'},{path:'node_modules'}]};

const git=(root,args)=>cp.spawnSync('git',args,{cwd:root,shell:false,encoding:'utf8',
  env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'f',GIT_AUTHOR_EMAIL:'f@x.invalid',GIT_COMMITTER_NAME:'f',GIT_COMMITTER_EMAIL:'f@x.invalid'}});

/** A small committed repository with ordinary files and a gitignored dummy credential. */
function repo(base,{plantBeforeCommit=null,plantAfterCommit=null}={}){
  const root=fs.mkdtempSync(path.join(base,'repo-'));
  fs.writeFileSync(path.join(root,'.gitignore'),'.env\ntui/.env\nnode_modules/\n');
  fs.mkdirSync(path.join(root,'src'),{recursive:true});
  fs.writeFileSync(path.join(root,'src/main.ts'),'export const value=1;\n');
  fs.writeFileSync(path.join(root,'README.md'),'# fixture\n');
  fs.mkdirSync(path.join(root,'tui'),{recursive:true});
  fs.writeFileSync(path.join(root,'.env'),`API_TOKEN=${SENTINEL}\n`);
  fs.writeFileSync(path.join(root,'tui/.env'),`API_TOKEN=${SENTINEL}\n`);
  git(root,['init','-q']);
  if(plantBeforeCommit)plantBeforeCommit(root);
  git(root,['add','-A','.']);
  git(root,['commit','-qm','fixture']);
  if(plantAfterCommit)plantAfterCommit(root);
  return root;
}
const base=()=>fs.mkdtempSync(path.join(os.tmpdir(),'trio-committed-test-'));
const drop=(dir)=>{try{fs.rmSync(dir,{recursive:true,force:true});}catch{}};

const expectRefusal=(fn,category)=>{
  try{fn();assert.fail(`expected ${category}`);}
  catch(error){
    assert.ok(error instanceof CommittedTreeRefusal,`expected a CommittedTreeRefusal, got ${error?.name}: ${error?.message}`);
    assert.equal(error.category,category);
    return error;
  }
};
const cleanliness=(root)=>assessCleanliness(root,GOVERNANCE);

// (1) untracked dummy credential -> refused, nothing opened
test('an untracked dummy credential leaves the tree dirty and is never opened',()=>{
  const b=base();
  try{
    const root=repo(b,{plantAfterCommit:(r)=>fs.writeFileSync(path.join(r,'deploy.env'),`API_TOKEN=${SENTINEL}\n`)});
    const result=cleanliness(root);
    assert.equal(result.clean,false);
    assert.ok(result.violations.some((v)=>v.path==='deploy.env'),JSON.stringify(result.violations));
    assert.equal(JSON.stringify(result).includes(SENTINEL),false,'no credential content may appear in the decision');
  }finally{drop(b);}
});

// (2) a committed credential path -> refused before its blob is fetched
test('a committed credential path is refused before blob retrieval',()=>{
  const b=base();
  try{
    const root=repo(b,{plantBeforeCommit:(r)=>{fs.writeFileSync(path.join(r,'.gitignore'),'node_modules/\n');fs.writeFileSync(path.join(r,'.env'),`API_TOKEN=${SENTINEL}\n`);}});
    const id=readIdentity(root);
    const error=expectRefusal(()=>planCommittedTree(root,id.tree),REFUSAL.COMMITTED_SECRET_PATH);
    assert.equal(error.affectedPath,'.env');
    assert.equal(JSON.stringify(error.detail??'').includes(SENTINEL),false);
  }finally{drop(b);}
});

// (3)(4)(6) worktree aliases are simply not inputs any more
for(const [label,plant] of [
  ['hard link',(r)=>fs.linkSync(path.join(r,'.env'),path.join(r,'alias.txt'))],
  ['symlink',(r)=>fs.symlinkSync(path.join(r,'.env'),path.join(r,'link.txt'))],
  ['tracked file replaced by a hard link to a credential',(r)=>{fs.rmSync(path.join(r,'README.md'));fs.linkSync(path.join(r,'.env'),path.join(r,'README.md'));}]
])test(`a ${label} in the live worktree makes the tree dirty and is refused without a content read`,()=>{
  const b=base();
  try{
    const root=repo(b,{plantAfterCommit:plant});
    const result=cleanliness(root);
    assert.equal(result.clean,false,JSON.stringify(result.violations));
    assert.equal(JSON.stringify(result).includes(SENTINEL),false);
  }finally{drop(b);}
});

// (5) a committed symlink is rejected by Git mode before retrieval
test('a committed symlink is rejected by object mode before blob retrieval',()=>{
  const b=base();
  try{
    const root=repo(b,{plantBeforeCommit:(r)=>fs.symlinkSync('src/main.ts',path.join(r,'alias.ts'))});
    const id=readIdentity(root);
    const error=expectRefusal(()=>planCommittedTree(root,id.tree),REFUSAL.UNSUPPORTED_OBJECT);
    assert.match(String(error.detail),/mode 120000/);
  }finally{drop(b);}
});

// (7)(8)(9)(10) a clean tree materializes into a containment-safe snapshot
test('a clean committed tree materializes into a snapshot with no links and no escape',()=>{
  const b=base();const workspace=createSnapshotWorkspace();
  try{
    const root=repo(b);
    assert.equal(cleanliness(root).clean,true);
    const id=readIdentity(root);
    const entries=planCommittedTree(root,id.tree);
    const snapshot=materializeSnapshot({root,entries,into:workspace.base});
    assert.equal(snapshot.fileCount,entries.length);
    assert.match(snapshot.inventoryDigest,/^sha256:[0-9a-f]{64}$/);
    const seen=[];
    const walk=(dir)=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,e.name);
      const st=fs.lstatSync(full);
      assert.equal(st.isSymbolicLink(),false,`snapshot contains a symlink: ${full}`);
      if(st.isDirectory()){walk(full);continue;}
      assert.equal(st.isFile(),true);
      assert.equal(st.nlink,1,`snapshot entry is hard-linked: ${full}`);
      const rel=path.relative(snapshot.root,fs.realpathSync(full));
      assert.equal(rel.startsWith('..'),false,'snapshot path escapes its root');
      seen.push(rel);}};
    walk(snapshot.root);
    assert.equal(seen.length,entries.length);
    // The credential is gitignored, so it is simply absent rather than excluded-by-check.
    assert.equal(seen.some((p)=>p==='.env'||p==='tui/.env'),false);
    for(const rel of seen)assert.equal(fs.readFileSync(path.join(snapshot.root,rel),'utf8').includes(SENTINEL),false);
  }finally{workspace.destroy();drop(b);}
});

// (11)(12)(13) identity moving under the run invalidates it
test('a live change after metadata capture is detected as a dirty tree on revalidation',()=>{
  const b=base();
  try{
    const root=repo(b);
    assert.equal(cleanliness(root).clean,true);
    fs.writeFileSync(path.join(root,'src/main.ts'),'export const value=2;\n');
    assert.equal(cleanliness(root).clean,false);
  }finally{drop(b);}
});
test('a HEAD change during a run changes the captured identity',()=>{
  const b=base();
  try{
    const root=repo(b);
    const before=readIdentity(root);
    fs.writeFileSync(path.join(root,'extra.md'),'# more\n');
    git(root,['add','-A','.']);git(root,['commit','-qm','second']);
    const after=readIdentity(root);
    assert.notEqual(after.head,before.head);
    assert.notEqual(after.tree,before.tree);
  }finally{drop(b);}
});
test('an index change during a run is refused as unclean',()=>{
  const b=base();
  try{
    const root=repo(b);
    fs.writeFileSync(path.join(root,'staged.md'),'# staged\n');
    git(root,['add','staged.md']);
    const result=cleanliness(root);
    assert.equal(result.clean,false);
    assert.ok(result.violations.some((v)=>v.path==='staged.md'));
  }finally{drop(b);}
});

// (14) repository configuration cannot change what the plumbing does
test('repository config and aliases cannot alter the governed plumbing',()=>{
  const b=base();
  try{
    const root=repo(b);
    git(root,['config','alias.ls-tree','!echo pwned']);
    git(root,['config','core.hooksPath','/tmp/attacker-hooks']);
    git(root,['config','diff.external','/bin/false']);
    const id=readIdentity(root);
    const entries=planCommittedTree(root,id.tree);
    assert.ok(entries.length>0,'plumbing still enumerated the tree');
    assert.ok(entries.every((e)=>COMMITTED_TREE_CONTRACT.permittedBlobModes.includes(e.mode)));
    assert.equal(entries.some((e)=>String(e.path).includes('pwned')),false);
  }finally{drop(b);}
});

// (23) snapshot lifetime
test('a snapshot workspace is destroyed only when explicitly torn down',()=>{
  const b=base();const workspace=createSnapshotWorkspace();
  try{
    const root=repo(b);
    const id=readIdentity(root);
    const snapshot=materializeSnapshot({root,entries:planCommittedTree(root,id.tree),into:workspace.base});
    assert.equal(fs.existsSync(snapshot.root),true,'snapshot must survive until the artifact is formed');
    workspace.destroy();
    assert.equal(fs.existsSync(snapshot.root),false,'snapshot must be gone after teardown');
  }finally{drop(b);}
});

// The contract itself must keep naming the surfaces it refuses to use.
test('the committed-tree contract forbids filtering and working-tree transformation surfaces',()=>{
  for(const surface of ['archive','checkout','filters','working-tree-transformations','pipelines','command-substitution'])
    assert.ok(COMMITTED_TREE_CONTRACT.forbiddenGitSurfaces.includes(surface),surface);
  assert.equal(COMMITTED_TREE_CONTRACT.input,'clean-committed-tree-only');
  assert.equal(COMMITTED_TREE_CONTRACT.liveWorktreeContent,'never-consumed');
  const source=fs.readFileSync(path.join(here,'git-committed-tree.mjs'),'utf8');
  for(const forbidden of ["'archive'","'checkout'","shell:true"])
    assert.equal(source.includes(`git(root,[${forbidden}`),false,`git ${forbidden} must not be reachable`);
  assert.ok(source.includes('shell:false'),'git must be invoked with shell:false');
});
