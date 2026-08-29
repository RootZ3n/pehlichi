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
 *   1. Nothing reads except through `read`/`readText`, which authorize first. A refusal is
 *      raised before any descriptor exists, so a refused object is never opened at all.
 *   2. `SecretReadRefused` must reach the caller. It is deliberately not an ordinary I/O
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
  version:'1.0.0',
  decision:'explicit-allow-before-open',
  identity:'device-and-inode',
  aliasesCovered:Object.freeze(['hard-link','symlink','path-traversal-spelling','overlapping-inventory-entry','agent-owned-introduction']),
  orderIndependent:true
});

/** A refused read. Not an I/O error: it must not be mistaken for an absent optional file. */
export class SecretReadRefused extends Error{
  constructor(relativePath,reason){
    super(`credential-bearing object refused before open: ${relativePath} (${reason})`);
    this.name='SecretReadRefused';
    this.code='SECRET_READ_REFUSED';
    this.relativePath=relativePath;
    this.reason=reason;
  }
}
export const isSecretReadRefused=(error)=>error instanceof SecretReadRefused||error?.code==='SECRET_READ_REFUSED';

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
export function createReadAuthority({root,secretObjects}){
  const refusals=[];
  const relativeOf=(file)=>{
    const rel=path.relative(root,file);
    return rel===''||rel.startsWith('..')||path.isAbsolute(rel)?file:rel.split(path.sep).join('/');
  };
  function authorize(file){
    const rel=relativeOf(file);
    // Path policy first: it needs no filesystem call and catches a declared secret even if
    // the object vanished between the scan and now.
    const byPath=classifySecretPath(rel);
    if(byPath.secret){
      const refusal={path:rel,reason:byPath.reason};refusals.push(refusal);
      throw new SecretReadRefused(rel,byPath.reason);
    }
    let stat;
    try{stat=fs.lstatSync(file);}catch{return {allow:true,path:rel};}
    if(secretObjects.identities.has(identityOf(stat))){
      const refusal={path:rel,reason:'alias of a credential-bearing object'};refusals.push(refusal);
      throw new SecretReadRefused(rel,refusal.reason);
    }
    if(stat.isSymbolicLink()){
      let target;
      try{target=fs.statSync(file);}catch{return {allow:true,path:rel};}
      if(secretObjects.identities.has(identityOf(target))){
        const refusal={path:rel,reason:'symlink to a credential-bearing object'};refusals.push(refusal);
        throw new SecretReadRefused(rel,refusal.reason);
      }
    }
    return {allow:true,path:rel};
  }
  return {
    contract:READ_AUTHORITY_CONTRACT,
    secretPaths:secretObjects.paths,
    refusals,
    authorize,
    /** The only sanctioned way for verifier code to obtain file bytes. */
    read(file){authorize(file);return fs.readFileSync(file);},
    readText(file){authorize(file);return fs.readFileSync(file,'utf8');},
    /** True when the object may be read; never swallows a refusal into a silent false. */
    permits(file){try{authorize(file);return true;}catch(error){if(isSecretReadRefused(error))return false;throw error;}}
  };
}
