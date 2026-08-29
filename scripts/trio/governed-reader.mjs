/**
 * The pre-read authorization boundary.
 *
 * An independent audit found the previous protection was watching the wrong thing. It asked
 * "is this path called `.env`?", which a hard link answers with a straight face: the same
 * inode under an innocent name in a governed tree was read, hashed, and — on the secondary
 * agent-owned pass — the resulting error was swallowed to `null` so verification continued
 * and published PARITY.
 *
 * So authorization here is about the *object*, not the name. Before anything is read, a
 * metadata-only pass resolves every credential-bearing path in the repository to its
 * device/inode. After that, no name matters: an alias, a symlink, a traversal spelling, or a
 * second inventory entry all collapse onto the same identity and are refused. Because the
 * scan completes before the first read, an alias encountered *before* its canonical path is
 * refused too — traversal order stops being load-bearing.
 *
 * Two rules make this a boundary rather than a suggestion:
 *
 *   1. Nothing reads except through `read`/`readText`. Path and known-object refusals happen
 *      before open; race checks open one no-follow descriptor, verify it, and read zero bytes
 *      on refusal. Authorization and content therefore always concern the same object.
 *   2. The security-error family must reach the caller. It is deliberately not ordinary I/O,
 *      error, because the bug being fixed was an ordinary I/O error being caught and turned
 *      into `null`. Callers that tolerate missing files must re-throw this one.
 *
 * Refusals carry a path and a reason. They never carry content, length, digest, mode,
 * ownership, or timestamps — the point is to not learn those things.
 */

import fs from 'node:fs';
import path from 'node:path';
import { classifySecretPath } from './secret-path-policy.mjs';

export const READ_AUTHORITY_CONTRACT=Object.freeze({
  version:'2.0.0',
  decision:'path-policy-then-single-descriptor',
  identity:'device-and-inode',
  aliasesCovered:Object.freeze(['hard-link','symlink','path-traversal-spelling','overlapping-inventory-entry','agent-owned-introduction']),
  orderIndependent:true
});

export class VerifierSecurityError extends Error{
  constructor(code,relativePath,category){
    super(`verifier security boundary refused ${relativePath}: ${category}`);
    this.name='VerifierSecurityError';
    this.code=code;
    this.relativePath=relativePath;
    this.category=category;
    this.contentsRead=false;
  }
}
export class SecretReadRefused extends VerifierSecurityError{constructor(p,c='secret-object'){super('SECRET_READ_REFUSED',p,c);this.name='SecretReadRefused';}}
export class FilesystemIdentityChanged extends VerifierSecurityError{constructor(p){super('FILESYSTEM_IDENTITY_CHANGED',p,'filesystem-identity-changed');this.name='FilesystemIdentityChanged';}}
export class SymlinkContainmentRefused extends VerifierSecurityError{constructor(p,c='symlink-or-containment-refused'){super('SYMLINK_CONTAINMENT_REFUSED',p,c);this.name='SymlinkContainmentRefused';}}
export class UnauthorizedParserAccess extends VerifierSecurityError{constructor(p){super('UNAUTHORIZED_PARSER_ACCESS',p,'parser-path-open-refused');this.name='UnauthorizedParserAccess';}}
export class TrappedForbiddenRead extends VerifierSecurityError{constructor(p){super('TRAPPED_FORBIDDEN_READ',p,'trapped-forbidden-read');this.name='TrappedForbiddenRead';}}
export const isSecurityBoundaryError=(error)=>error instanceof VerifierSecurityError||['SECRET_READ_REFUSED','FILESYSTEM_IDENTITY_CHANGED','SYMLINK_CONTAINMENT_REFUSED','UNAUTHORIZED_PARSER_ACCESS','TRAPPED_FORBIDDEN_READ','FORBIDDEN_CREDENTIAL_READ'].includes(error?.code);
export const isSecretReadRefused=isSecurityBoundaryError;

const identityOf=(stat)=>`${stat.dev}:${stat.ino}`;

/**
 * Metadata-only sweep for credential objects.
 *
 * Uses readdir and lstat exclusively — it opens nothing. Declared rule paths are folded in
 * as well, so an object stays guarded even if the path policy and the manifest ever disagree
 * about it.
 */
export function scanSecretObjects(root,{exclusions=[],declaredPaths=[]}={}){
  const identities=new Set();
  const paths=new Set();
  const excluded=(rel)=>exclusions.some((x)=>rel===x.path||rel.startsWith(x.path+'/'));
  const visit=(dir,base='')=>{
    let entries;
    try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}
    for(const entry of entries){
      const rel=base?`${base}/${entry.name}`:entry.name;
      if(excluded(rel))continue;
      const full=path.join(dir,entry.name);
      let stat;
      try{stat=fs.lstatSync(full);}catch{continue;}
      if(stat.isDirectory()){visit(full,rel);continue;}
      if(!classifySecretPath(rel).secret)continue;
      paths.add(rel);
      // The link itself and, for a symlink, whatever it resolves to.
      identities.add(identityOf(stat));
      if(stat.isSymbolicLink()){try{identities.add(identityOf(fs.statSync(full)));}catch{}}
    }
  };
  visit(root);
  for(const rel of declaredPaths){
    const full=path.join(root,...rel.split('/'));
    try{
      const stat=fs.lstatSync(full);
      paths.add(rel);
      identities.add(identityOf(stat));
      if(stat.isSymbolicLink()){try{identities.add(identityOf(fs.statSync(full)));}catch{}}
    }catch{/* an absent declared secret is simply absent; never probed further */}
  }
  return {identities,paths};
}

/**
 * A reader that will not open a credential object under any name.
 *
 * `authorize` is callable on its own for paths that are inspected but not read, so the same
 * decision covers both. Every refusal is recorded so a caller can report that the boundary
 * engaged without having to reconstruct it.
 */
export function createReadAuthority({root,secretObjects,hooks={}}){
  const rootReal=fs.realpathSync(root);
  const refusals=[];
  const relativeOf=(file)=>{
    const rel=path.relative(rootReal,path.resolve(file));
    return rel===''||rel.startsWith('..')||path.isAbsolute(rel)?file:rel.split(path.sep).join('/');
  };
  function refuse(ErrorType,rel,category){const error=new ErrorType(rel,category);refusals.push({path:rel,category:error.category,contentsRead:false});throw error;}
  function authorize(file){
    const rel=relativeOf(file);
    if(path.isAbsolute(rel)||rel===''||rel.startsWith('../'))refuse(SymlinkContainmentRefused,rel,'repository-containment-refused');
    // Path policy first: it needs no filesystem call and catches a declared secret even if
    // the object vanished between the scan and now.
    const byPath=classifySecretPath(rel);
    if(byPath.secret){
      refuse(SecretReadRefused,rel,'secret-path');
    }
    let stat;
    try{stat=fs.lstatSync(file);}catch{return {allow:true,path:rel};}
    if(secretObjects.identities.has(identityOf(stat))){
      refuse(SecretReadRefused,rel,'secret-object-alias');
    }
    if(stat.isSymbolicLink()){
      let target;
      try{target=fs.statSync(file);}catch{return {allow:true,path:rel};}
      if(secretObjects.identities.has(identityOf(target))){
        refuse(SecretReadRefused,rel,'secret-object-symlink');
      }
      refuse(SymlinkContainmentRefused,rel,'symlink-refused');
    }
    if(!stat.isFile())refuse(SymlinkContainmentRefused,rel,'regular-file-required');
    return {allow:true,path:rel,stat};
  }
  function read(file,encoding){
    const decision=authorize(file);hooks.afterMetadata?.(file,decision);
    let fd;
    try{
      try{fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));}
      catch(error){if(error?.code==='ELOOP')refuse(SymlinkContainmentRefused,decision.path,'symlink-substitution');throw error;}
      hooks.afterOpen?.(file,fd,decision);
      const opened=fs.fstatSync(fd);
      if(!opened.isFile())refuse(SymlinkContainmentRefused,decision.path,'regular-file-required');
      if(!decision.stat||opened.dev!==decision.stat.dev||opened.ino!==decision.stat.ino)refuse(FilesystemIdentityChanged,decision.path);
      if(secretObjects.identities.has(identityOf(opened)))refuse(SecretReadRefused,decision.path,'secret-object-alias');
      hooks.beforeRead?.(file,fd,decision);
      return fs.readFileSync(fd,encoding);
    }catch(error){if(error?.code==='FORBIDDEN_CREDENTIAL_READ')throw new TrappedForbiddenRead(decision.path);throw error;}
    finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{}}
  }
  return {
    contract:READ_AUTHORITY_CONTRACT,
    secretPaths:secretObjects.paths,
    refusals,
    authorize,
    /** The only sanctioned way for verifier code to obtain file bytes. */
    read(file){return read(file,undefined);},
    readText(file){return read(file,'utf8');},
    /** True when the object may be read; never swallows a refusal into a silent false. */
    permits(file){try{authorize(file);return true;}catch(error){if(isSecurityBoundaryError(error))return false;throw error;}}
  };
}
