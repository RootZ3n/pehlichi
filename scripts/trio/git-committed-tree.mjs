/**
 * Committed-tree verification authority.
 *
 * The previous security model tried to prove that arbitrary JavaScript could never reach a
 * credential. That is an unbounded obligation, and the independent audits kept finding the
 * next reader. This module removes the obligation instead of chasing it: the verifier no
 * longer consumes the live worktree at all.
 *
 * What it consumes is a clean committed Git tree, materialized into a fresh snapshot that
 * contains only approved regular files. Credentials are gitignored, so they are not in the
 * tree; if one ever were committed, it is refused from its pathname before its blob is
 * fetched. A hard link or symlink in someone's working copy is simply not an input any more
 * -- either it is dirty, and the run refuses, or it is absent from the snapshot.
 *
 * Git is invoked as fixed argument vectors with `shell:false` and a controlled environment.
 * System and global config are neutralized so repository configuration cannot change what a
 * plumbing command does, and only metadata commands plus `cat-file` are used -- never
 * archive, checkout, or anything that would run a filter or a working-tree transformation.
 */

import cp from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifySecretPath } from './secret-path-policy.mjs';
import { VerifierSecurityError } from './governed-reader.mjs';

export const COMMITTED_TREE_CONTRACT=Object.freeze({
  version:'1.0.0',
  input:'clean-committed-tree-only',
  liveWorktreeContent:'never-consumed',
  gitInvocation:'fixed-argv, shell:false, controlled environment, config neutralized',
  blobRetrieval:'git cat-file by object id',
  forbiddenGitSurfaces:Object.freeze(['archive','checkout','show','pipelines','command-substitution','filters','working-tree-transformations']),
  permittedBlobModes:Object.freeze(['100644','100755'])
});

/** Refusal categories. Each is terminal; none permits a fallback to live content. */
export const REFUSAL=Object.freeze({
  WORKTREE_NOT_CLEAN:'WORKTREE_NOT_CLEAN',
  COMMITTED_SECRET_PATH:'COMMITTED_SECRET_PATH',
  UNSUPPORTED_OBJECT:'UNSUPPORTED_OBJECT',
  IGNORED_CREDENTIAL_AMBIGUITY:'IGNORED_CREDENTIAL_AMBIGUITY',
  IDENTITY_CHANGED_DURING_RUN:'IDENTITY_CHANGED_DURING_RUN',
  GIT_METADATA_UNAVAILABLE:'GIT_METADATA_UNAVAILABLE',
  SNAPSHOT_CONTAINMENT:'SNAPSHOT_CONTAINMENT'
});

export class CommittedTreeRefusal extends VerifierSecurityError{
  constructor(category,affectedPath,detail=null){
    super(category,affectedPath??null,category);
    this.name='CommittedTreeRefusal';
    this.category=category;
    // The base class names it relativePath; keep an explicit alias so callers and evidence
    // readers do not have to know which layer raised the refusal.
    this.affectedPath=affectedPath??null;
    this.detail=detail;
  }
}

/**
 * A deliberately small environment.
 *
 * HOME points away from any real profile and both config scopes are silenced, so an alias,
 * a hook path, or an external-diff setting in a repository or on the machine cannot change
 * what these commands do.
 */
const GIT_ENV=Object.freeze({
  PATH:'/usr/local/bin:/usr/bin:/bin',
  HOME:'/nonexistent-trio-verifier-home',
  GIT_CONFIG_NOSYSTEM:'1',
  GIT_CONFIG_GLOBAL:'/dev/null',
  GIT_CONFIG_SYSTEM:'/dev/null',
  GIT_ATTR_NOSYSTEM:'1',
  GIT_TERMINAL_PROMPT:'0',
  GIT_OPTIONAL_LOCKS:'0',
  GIT_ALLOW_PROTOCOL:'',
  GIT_NOGLOB_PATHSPECS:'1',
  GIT_LITERAL_PATHSPECS:'1',
  LC_ALL:'C',
  TZ:'UTC'
});

/** Applied ahead of every subcommand so repository config cannot re-enable them. */
const GIT_SAFETY=Object.freeze([
  '--no-pager',
  '-c','core.hooksPath=/dev/null',
  '-c','core.fsmonitor=false',
  '-c','core.askPass=',
  '-c','diff.external=',
  '-c','protocol.ext.allow=never',
  '-c','core.attributesFile=/dev/null',
  '-c','core.excludesFile=/dev/null'
]);

/** Only these subcommands are reachable. None transforms or filters content. */
const PERMITTED=new Set(['rev-parse','status','ls-tree','cat-file','diff-index']);

function git(root,args,{buffer=false,maxBuffer=64*1024*1024}={}){
  const subcommand=args[0];
  if(!PERMITTED.has(subcommand))throw new CommittedTreeRefusal(REFUSAL.GIT_METADATA_UNAVAILABLE,null,`git subcommand ${subcommand} is not permitted`);
  const result=cp.spawnSync('git',[...GIT_SAFETY,...args],{
    cwd:root,env:GIT_ENV,shell:false,maxBuffer,
    ...(buffer?{}:{encoding:'utf8'})
  });
  if(result.error)throw new CommittedTreeRefusal(REFUSAL.GIT_METADATA_UNAVAILABLE,null,result.error.message);
  return result;
}

const text=(result)=>String(result.stdout??'').trim();

/** HEAD, tree and branch. Metadata only; no blob is touched. */
export function readIdentity(root){
  const head=git(root,['rev-parse','HEAD']);
  if(head.status!==0)throw new CommittedTreeRefusal(REFUSAL.GIT_METADATA_UNAVAILABLE,null,'HEAD is unreadable');
  const tree=git(root,['rev-parse','HEAD^{tree}']);
  if(tree.status!==0)throw new CommittedTreeRefusal(REFUSAL.GIT_METADATA_UNAVAILABLE,null,'HEAD tree is unreadable');
  const branch=git(root,['rev-parse','--abbrev-ref','HEAD']);
  return {head:text(head),tree:text(tree),branch:text(branch)};
}

const STATUS_CATEGORY=Object.freeze({
  M:'modified-tracked-file',A:'added-staged-file',D:'deleted-tracked-file',
  R:'renamed-file',C:'copied-file',T:'type-change',U:'conflict','?':'untracked-file'
});

/**
 * What "clean" means, decided entirely from Git and path metadata.
 *
 * Nothing dirty or untracked is opened to reach this decision -- that is the point. Because
 * the Trio is pre-production there is no need to verify a dirty tree, so any disagreement at
 * all is a refusal rather than something to reconcile.
 */
export function assessCleanliness(root,{declaredSecretPaths=[],exclusions=[]}={}){
  const violations=[];
  if(fs.lstatSync(root).isSymbolicLink())violations.push({category:'repository-root-symlink',path:'.'});

  const status=git(root,['status','--porcelain=v1','-z','--untracked-files=all','--ignored=no']);
  if(status.status!==0)throw new CommittedTreeRefusal(REFUSAL.GIT_METADATA_UNAVAILABLE,null,'git status failed');
  const fields=String(status.stdout??'').split('\0').filter((x)=>x!=='');
  for(let i=0;i<fields.length;i+=1){
    const entry=fields[i];
    if(entry.length<3)continue;
    const x=entry[0],y=entry[1],rel=entry.slice(3);
    if(x==='R'||x==='C')i+=1; // a rename carries its source as the next NUL-separated field
    const category=x==='?'?STATUS_CATEGORY['?']:(STATUS_CATEGORY[x]??STATUS_CATEGORY[y]??'unexpected-status');
    violations.push({category,path:rel});
  }

  // Index and committed tree must agree even when status is quiet about staged content.
  const staged=git(root,['diff-index','--cached','--quiet','HEAD','--']);
  if(staged.status!==0&&violations.length===0)violations.push({category:'git-index-tree-disagreement',path:null});

  // Ignored credential-class paths are permitted only where governance declares them. An
  // undeclared one is ambiguity, and ambiguity about credentials is a refusal. Established
  // from pathnames and lstat alone -- nothing is opened.
  const declared=new Set(declaredSecretPaths);
  const excluded=(rel)=>exclusions.some((x)=>rel===x.path||rel.startsWith(x.path+'/'));
  const visit=(dir,base='')=>{
    let entries;
    try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}
    for(const entry of entries){
      const rel=base?`${base}/${entry.name}`:entry.name;
      if(excluded(rel))continue;
      if(entry.isDirectory()){visit(path.join(dir,entry.name),rel);continue;}
      if(classifySecretPath(rel).secret&&!declared.has(rel))violations.push({category:'undeclared-ignored-credential-path',path:rel});
    }
  };
  visit(root);
  return {clean:violations.length===0,violations};
}

const CONTROL_OR_BACKSLASH=/[\u0000-\u001f\u007f]|\\/;
function validateTreePath(rel){
  if(typeof rel!=='string'||rel==='')return 'empty path';
  if(path.isAbsolute(rel))return 'absolute path';
  if(CONTROL_OR_BACKSLASH.test(rel))return 'control character or backslash';
  if(rel.normalize('NFC')!==rel)return 'not NFC-normalized';
  const segments=rel.split('/');
  if(segments.some((s)=>s===''||s==='.'||s==='..'))return 'empty, dot, or parent segment';
  return null;
}

/**
 * Enumerate the committed tree, then decide every path *before* any blob is fetched.
 *
 * Classification order is the whole security property here: a credential pathname or an
 * unsupported object mode is refused while it is still just a line of `ls-tree` output.
 */
export function planCommittedTree(root,tree){
  const listed=git(root,['ls-tree','-r','-z','--full-tree',tree]);
  if(listed.status!==0)throw new CommittedTreeRefusal(REFUSAL.GIT_METADATA_UNAVAILABLE,null,'git ls-tree failed');
  const approved=[];
  for(const record of String(listed.stdout??'').split('\0').filter(Boolean)){
    const tab=record.indexOf('\t');
    if(tab<0)throw new CommittedTreeRefusal(REFUSAL.UNSUPPORTED_OBJECT,null,'unparseable tree record');
    const [mode,type,oid]=record.slice(0,tab).split(/\s+/);
    const rel=record.slice(tab+1);
    const pathProblem=validateTreePath(rel);
    if(pathProblem)throw new CommittedTreeRefusal(REFUSAL.UNSUPPORTED_OBJECT,rel,pathProblem);
    if(classifySecretPath(rel).secret)throw new CommittedTreeRefusal(REFUSAL.COMMITTED_SECRET_PATH,rel,'a credential-class path is committed');
    if(type!=='blob')throw new CommittedTreeRefusal(REFUSAL.UNSUPPORTED_OBJECT,rel,`object type ${type}`);
    if(!COMMITTED_TREE_CONTRACT.permittedBlobModes.includes(mode))throw new CommittedTreeRefusal(REFUSAL.UNSUPPORTED_OBJECT,rel,`object mode ${mode}`);
    if(!/^[0-9a-f]{40,64}$/.test(oid))throw new CommittedTreeRefusal(REFUSAL.UNSUPPORTED_OBJECT,rel,'malformed object id');
    approved.push({mode,type,oid,path:rel});
  }
  approved.sort((a,b)=>Buffer.from(a.path).compare(Buffer.from(b.path)));
  return approved;
}

/**
 * Read one governed file out of the committed tree, by object identity.
 *
 * Bootstrapping needs the governance manifest before any snapshot exists, and reading it
 * from the worktree would be exactly the live-content dependency this architecture removes.
 * So it comes from the tree: `ls-tree` for the object id, `cat-file` for the bytes, and the
 * same pathname and mode policy every other entry is held to.
 */
export function readCommittedFile(root,tree,relativePath){
  const listed=git(root,['ls-tree','-z','--full-tree',tree,'--',relativePath]);
  if(listed.status!==0)throw new CommittedTreeRefusal(REFUSAL.GIT_METADATA_UNAVAILABLE,relativePath,'git ls-tree failed');
  const record=String(listed.stdout??'').split('\0').filter(Boolean)[0];
  if(!record)throw new CommittedTreeRefusal(REFUSAL.GIT_METADATA_UNAVAILABLE,relativePath,'path is not present in the committed tree');
  const tab=record.indexOf('\t');
  const [mode,type,oid]=record.slice(0,tab).split(/\s+/);
  if(classifySecretPath(relativePath).secret)throw new CommittedTreeRefusal(REFUSAL.COMMITTED_SECRET_PATH,relativePath,'a credential-class path is committed');
  if(type!=='blob'||!COMMITTED_TREE_CONTRACT.permittedBlobModes.includes(mode))throw new CommittedTreeRefusal(REFUSAL.UNSUPPORTED_OBJECT,relativePath,`object ${type}/${mode}`);
  return readBlob(root,oid);
}

/** Fetch one approved blob by object identity. Never by working-tree path. */
function readBlob(root,oid){
  const result=git(root,['cat-file','blob',oid],{buffer:true});
  if(result.status!==0)throw new CommittedTreeRefusal(REFUSAL.GIT_METADATA_UNAVAILABLE,null,`git cat-file failed for ${oid}`);
  return Buffer.from(result.stdout);
}

/**
 * Write approved blobs into a fresh snapshot: regular files only, created exclusively.
 *
 * O_EXCL|O_NOFOLLOW means each file is newly created here and cannot be redirected through
 * something that already exists. No link is ever made, so a snapshot cannot inherit an
 * alias, and nothing is executed while it is built.
 */
export function materializeSnapshot({root,entries,into}){
  const snapshotReal=fs.realpathSync(fs.mkdtempSync(path.join(into,'snap-')));
  const hash=crypto.createHash('sha256');
  for(const entry of entries){
    const target=path.join(snapshotReal,...entry.path.split('/'));
    const containment=path.relative(snapshotReal,path.resolve(target));
    if(containment.startsWith('..')||path.isAbsolute(containment))throw new CommittedTreeRefusal(REFUSAL.SNAPSHOT_CONTAINMENT,entry.path,'materialized path escapes the snapshot root');
    fs.mkdirSync(path.dirname(target),{recursive:true});
    const bytes=readBlob(root,entry.oid);
    const mode=entry.mode==='100755'?0o755:0o644;
    let fd;
    try{
      fd=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW??0),mode);
      fs.writeFileSync(fd,bytes);
    }finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{}}
    const written=fs.lstatSync(target);
    if(!written.isFile()||written.nlink!==1)throw new CommittedTreeRefusal(REFUSAL.SNAPSHOT_CONTAINMENT,entry.path,'snapshot entry is not a single-linked regular file');
    const frame=Buffer.alloc(8);frame.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(`${entry.path}\0${entry.mode}\0${entry.oid}\0`);hash.update(frame);
  }
  return {root:snapshotReal,inventoryDigest:`sha256:${hash.digest('hex')}`,fileCount:entries.length};
}

/** A workspace holding every slot's snapshot, destroyed as one unit. */
export function createSnapshotWorkspace(){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'trio-committed-'));
  return {base,destroy(){try{fs.rmSync(base,{recursive:true,force:true});}catch{}}};
}

export { git as governedGit, readBlob as readApprovedBlob };
