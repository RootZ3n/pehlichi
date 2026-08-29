/**
 * Bind the Trio to the Truth Firewall release that actually executes.
 *
 * The previous pin was a paragraph. `trio/runtime-closure.json` named a release id and a
 * closure digest under a bespoke `activated-truth-release` kind that nothing computed and
 * that `declarationFor()` in src/core/external-runtime-integrity.ts explicitly refuses --
 * every other local dependency is a `local-runtime-tree` whose digest is recomputed and
 * compared, and Truth alone was trusted because it said so. A pin no code checks is
 * documentation, and documentation is not runtime proof.
 *
 * This module closes that gap from the host side. It reads the activation wrapper to learn
 * which release is really on the PATH, reads that release's own manifest, and then
 * *recomputes* the package closure with the release protocol's documented algorithm rather
 * than accepting the number the manifest reports about itself. Disagreement anywhere is
 * TRUTH_IDENTITY_MISMATCH.
 *
 * Nothing here reads a credential. The wrapper is a two-line shell script, the release
 * manifest is public build metadata, and the closure covers only .js/.cjs/.mjs/.json/.node
 * files under the release's own dist/ and node_modules/.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createReadAuthority,isSecurityBoundaryError,scanSecretObjects } from './governed-reader.mjs';

export const TRUTH_BINDING_CONTRACT=Object.freeze({
  version:'1.0.0',
  validationMethod:'recomputed-package-closure',
  closureProtocol:'truth-firewall/release-manifest/2',
  // Mirrors measurePackageClosure() in the Truth Firewall's authority module. The ordering
  // and framing are part of that protocol -- the host is expected to recompute the digest
  // independently and the two must agree byte for byte -- so they are reproduced exactly.
  closureAlgorithm:'sha256 over sorted POSIX-relative paths of package.json plus dist/src and node_modules .js|.cjs|.mjs|.json|.node files, each framed as path NUL sha256(content) LF'
});

const MEASURED=/\.(?:js|cjs|mjs|json|node)$/;

function hashFile(file,authority){
  const hash=crypto.createHash('sha256');
  hash.update(authority.read(file));
  return hash.digest('hex');
}

/** Recompute a staged release's package closure. Mirrors the release protocol exactly. */
export function measurePackageClosure(packageRoot){
  const root=fs.realpathSync(packageRoot);
  const authority=createReadAuthority({root,secretObjects:scanSecretObjects(root)});
  const selected=[path.join(root,'package.json')];
  const collect=(dir)=>{
    let names;
    try{names=fs.readdirSync(dir,{withFileTypes:true}).map((e)=>e.name).sort();}catch{return;}
    for(const name of names){
      const full=path.join(dir,name);
      let st;try{st=fs.lstatSync(full);}catch{continue;}
      if(st.isSymbolicLink()){
        // pnpm stores real files under .pnpm and links into them; follow only inside the
        // package so a link cannot smuggle in an unmeasured target.
        let target;try{target=fs.realpathSync(full);}catch{continue;}
        if(target!==root&&!target.startsWith(root+path.sep))continue;
        try{if(fs.statSync(target).isDirectory())collect(target);else if(MEASURED.test(target))selected.push(target);}catch{continue;}
        continue;
      }
      if(st.isDirectory()){if(name==='.git')continue;collect(full);}
      else if(st.isFile()&&MEASURED.test(name))selected.push(full);
    }
  };
  collect(path.join(root,'dist','src'));
  collect(path.join(root,'node_modules'));
  const unique=[...new Set(selected.map((p)=>{try{return fs.realpathSync(p);}catch{return null;}}).filter(Boolean))]
    .map((p)=>({path:p,key:path.relative(root,p).split(path.sep).join('/')}))
    .sort((a,b)=>(a.key<b.key?-1:a.key>b.key?1:0));
  const digest=crypto.createHash('sha256');
  for(const {path:file,key} of unique){digest.update(key);digest.update('\0');digest.update(hashFile(file,authority));digest.update('\n');}
  return {sha256:digest.digest('hex'),fileCount:unique.length};
}

/**
 * Read the activation wrapper and return the release root it actually executes.
 *
 * The wrapper is the only artefact that answers "which Truth runs when something types
 * `truth`". Parsing it is the difference between checking the authority and checking a
 * document about the authority.
 */
export function resolveActivatedRelease(wrapperPath){
  const real=fs.realpathSync(wrapperPath);
  const wrapperRoot=path.dirname(real);
  const authority=createReadAuthority({root:wrapperRoot,secretObjects:scanSecretObjects(wrapperRoot)});
  const text=authority.readText(real);
  const match=text.match(/exec\s+node\s+'([^']+)'|exec\s+node\s+"([^"]+)"|exec\s+node\s+(\S+)/);
  if(!match)return {ok:false,reason:'activation wrapper does not name a Node entrypoint'};
  const entry=match[1]??match[2]??match[3];
  if(!path.isAbsolute(entry))return {ok:false,reason:'activation wrapper entrypoint is not an absolute path'};
  // <releaseRoot>/dist/src/cli.js -> <releaseRoot>
  const root=path.resolve(path.dirname(entry),'..','..');
  return {ok:true,wrapperPath:real,entrypoint:entry,releaseRoot:root};
}

/**
 * Verify the activated Truth release against the identity the Trio pins.
 *
 * Returns `{ok:true,identity}` or `{ok:false,problems:[...]}`; the caller turns problems
 * into TRUTH_IDENTITY_MISMATCH failures. Every field the declaration pins is checked, and
 * the closure is recomputed rather than read.
 */
export function verifyTruthRelease(declaration){
  const problems=[];
  const need=(cond,message,details={})=>{if(!cond)problems.push({message,...details});};
  // The governance pin is the declaration; a `kind` tag belongs to the runtime-closure form
  // of the same claim, so it is accepted when present and not demanded when absent.
  if(!declaration||typeof declaration!=='object')
    return {ok:false,problems:[{message:'no Truth release declaration is bound to this verifier'}]};
  if(declaration.kind!==undefined&&declaration.kind!=='activated-truth-release')
    return {ok:false,problems:[{message:'Truth release declaration has an unexpected kind',kind:String(declaration.kind)}]};
  for(const field of ['activationWrapper','releaseId','packageClosureSha256','packageClosureFileCount','version','sourceCommit'])
    need(declaration[field]!==undefined&&declaration[field]!==null,`declaration is missing ${field}`);
  if(problems.length)return {ok:false,problems};

  let resolved;
  try{resolved=resolveActivatedRelease(declaration.activationWrapper);}
  catch(error){if(isSecurityBoundaryError(error))throw error;return {ok:false,problems:[{message:`activation wrapper is unreadable: ${error.message}`,wrapper:declaration.activationWrapper}]};}
  if(!resolved.ok)return {ok:false,problems:[{message:resolved.reason,wrapper:declaration.activationWrapper}]};

  let manifest;
  const manifestPath=path.join(resolved.releaseRoot,'release-manifest.json');
  try{const authority=createReadAuthority({root:resolved.releaseRoot,secretObjects:scanSecretObjects(resolved.releaseRoot)});manifest=JSON.parse(authority.readText(manifestPath));}
  catch(error){if(isSecurityBoundaryError(error))throw error;return {ok:false,problems:[{message:`activated release manifest is unreadable: ${error.message}`,releaseRoot:resolved.releaseRoot}]};}

  need(manifest.protocol===TRUTH_BINDING_CONTRACT.closureProtocol,'activated release uses an unexpected manifest protocol',{expected:TRUTH_BINDING_CONTRACT.closureProtocol,actual:manifest.protocol});
  need(manifest.releaseId===declaration.releaseId,'the activated release is not the pinned release',{pinned:declaration.releaseId,activated:manifest.releaseId});
  need(manifest.packageClosureSha256===declaration.packageClosureSha256,'the activated release closure digest is not the pinned digest',{pinned:declaration.packageClosureSha256,activated:manifest.packageClosureSha256});
  need(manifest.packageClosureFileCount===declaration.packageClosureFileCount,'the activated release closure file count is not the pinned count',{pinned:declaration.packageClosureFileCount,activated:manifest.packageClosureFileCount});
  need(manifest.version===declaration.version,'the activated release version is not the pinned version',{pinned:declaration.version,activated:manifest.version});
  need(manifest.sourceCommit===declaration.sourceCommit,'the activated release source commit is not the pinned commit',{pinned:declaration.sourceCommit,activated:manifest.sourceCommit});

  // The manifest's own numbers are a claim by the thing being checked. Recompute them.
  let measured;
  try{measured=measurePackageClosure(resolved.releaseRoot);}
  catch(error){if(isSecurityBoundaryError(error))throw error;return {ok:false,problems:[{message:`activated release closure could not be measured: ${error.message}`,releaseRoot:resolved.releaseRoot}]};}
  need(measured.sha256===declaration.packageClosureSha256,'the measured closure of the activated release does not match the pinned digest',{pinned:declaration.packageClosureSha256,measured:measured.sha256});
  need(measured.fileCount===declaration.packageClosureFileCount,'the measured closure of the activated release does not have the pinned file count',{pinned:declaration.packageClosureFileCount,measured:measured.fileCount});

  if(problems.length)return {ok:false,problems,measured};
  return {ok:true,identity:Object.freeze({
    specifier:declaration.specifier,
    releaseId:manifest.releaseId,
    version:manifest.version,
    sourceCommit:manifest.sourceCommit,
    sourceTree:manifest.sourceTree??null,
    packageClosureSha256:measured.sha256,
    packageClosureFileCount:measured.fileCount,
    entrypoint:resolved.entrypoint,
    activationWrapper:resolved.wrapperPath,
    releaseRoot:resolved.releaseRoot,
    enforcementProtocol:manifest.enforcementProtocol??null,
    validationMethod:TRUTH_BINDING_CONTRACT.validationMethod,
    credentialsRead:false
  })};
}
