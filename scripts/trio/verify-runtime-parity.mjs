#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSchemaValidator,SCHEMA_VALIDATOR } from './schema-validation.mjs';
import { parseStrictJsonText,StrictJsonError } from './strict-json.mjs';
import { AGENT_OWNED_UI_CLASS,AGENT_OWNED_CONTENT_CLASS,AGENT_OWNED_CLASSES,verifyAgentOwnedUi,verifyAgentOwnedUiRule,verifyAgentOwnedNotImportedByShared,verifyAgentOwnedHasNoPortableRoleLogic } from './agent-owned-ui.mjs';
import { classifySecretPath,secretModeProblems,SECRET_PATH_POLICY_VERSION } from './secret-path-policy.mjs';
import { scanSecretObjects,createReadAuthority,isSecurityBoundaryError,READ_AUTHORITY_CONTRACT } from './governed-reader.mjs';
import { verifyTruthRelease,TRUTH_BINDING_CONTRACT } from './truth-release-binding.mjs';
import { validateCertification,CERTIFICATION_CONTRACT } from './release-certification.mjs';

export const SLOT_NAMES=Object.freeze(['pehlichi','loony-luna','mad-ptah']);
const MATCH_CLASSES=new Set(['behavior-identical','generated-behavior-identical','model-behavior-data','test-behavior-identical','quarantined-blocking-divergence']);
const VARIABLE_CLASSES=new Set(['validated-variable-data','inert-variable-asset','documentation']);
// An owner-scoped tree belongs to exactly one agent and is not part of the shared
// distribution. It is neither compared across repositories nor permitted to be reachable
// from anything that is: the exemption buys absence, never silence about behaviour.
const OWNER_SCOPED_CLASS='owner-scoped-asset';
// A credential-bearing path is governed by its path and its metadata, never by its bytes.
// The verifier refuses to open it: two deployments are supposed to hold different secrets,
// so the content could not be compared even if reading it were acceptable.
const SECRET_EXCLUDED_CLASS='secret-path-excluded';
const EXECUTABLE_SUFFIXES=new Set(['.ts','.tsx','.js','.jsx','.mjs','.cjs','.py','.sh','.bash','.zsh','.fish','.rb','.pl','.php','.go','.rs','.java','.kt','.swift','.wasm','.node','.exe','.dll','.so','.dylib','.html','.htm','.service']);
const SAFE_EXCLUSIONS=new Set(['.git','node_modules','tui/node_modules','scripts/trio/node_modules']);
const VERIFIER_CONTRACT=Object.freeze({name:'trio-read-only-parity-verifier',version:'3.0.0',pathPolicyVersion:'3.0.0',symlinkPolicy:'reject-all-governed-and-exclusion-boundary-symlinks',hardLinkPolicy:'reject-multiple-links',casePolicy:'ASCII repository-relative paths with case-fold collision rejection'});
const sha256=(data)=>crypto.createHash('sha256').update(data).digest('hex');
const stable=(value)=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map((k)=>[k,stable(value[k])])):value;
const stableJson=(value)=>JSON.stringify(stable(value));
function canonicalManifest(value){const out=structuredClone(value);out.rules.sort((a,b)=>a.id.localeCompare(b.id));out.exclusions.sort((a,b)=>a.path.localeCompare(b.path));out.blockingDivergences.sort((a,b)=>a.path.localeCompare(b.path));out.packageBehaviorFields.sort();for(const rule of out.rules){if(rule.selector.paths)rule.selector.paths.sort();if(rule.selector.excludedPaths)rule.selector.excludedPaths.sort();if(rule.selector.excludedDirectories)rule.selector.excludedDirectories.sort();if(rule.selector.allowedSuffixes)rule.selector.allowedSuffixes.sort();rule.allowedTypes.sort();rule.permittedFormats.sort();}return out;}
const safeText=(value)=>String(value).replace(/[\p{Cc}\p{Cf}\p{Cs}|=]/gu,(c)=>`\\u{${c.codePointAt(0).toString(16)}}`);
const safeValue=(value)=>Array.isArray(value)?value.map(safeValue):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).map((key)=>[safeText(key),safeValue(value[key])])):typeof value==='string'?safeText(value):value;

function failure(failureClass,message,agent=null,affectedPath=null,details={}){return {failureClass,message:safeText(message),agent,affectedPath:affectedPath===null?null:safeText(affectedPath),details:safeValue(details)};}
function invalidResult(status,failures,metadata={}){return {schemaVersion:'3.0.0',status,generatedAt:new Date().toISOString(),validator:SCHEMA_VALIDATOR,summary:{verdict:status==='VERIFIER_SECURITY_BLOCKED'?'VERIFIER_SECURITY_BLOCKED':'VERIFIER_ERROR',blockingCount:failures.length},failures,...safeValue(metadata)};}

export function validateRelativePath(value,{allowDirectory=true}={}){
  const errors=[];if(typeof value!=='string'||value.length===0)return ['path must be a nonempty string'];
  if(Buffer.byteLength(value,'utf8')>1024)errors.push('path exceeds byte limit');
  if(value.normalize('NFC')!==value)errors.push('path is not NFC-normalized');
  if(/[\u0000-\u001f\u007f-\u009f]/u.test(value))errors.push('path contains a control character');
  if(value.includes('\\'))errors.push('backslash separators are forbidden');
  if(value.startsWith('/')||/^[A-Za-z]:/.test(value))errors.push('absolute paths are forbidden');
  if(value.includes('//'))errors.push('repeated separators are forbidden');
  const segments=value.split('/');if(segments.some((s)=>s===''||s==='.'||s==='..'))errors.push('empty, dot, and parent segments are forbidden');
  if(segments.some((s)=>/[ .]$/.test(s)))errors.push('segments may not end with a space or dot');
  if(/[^\x20-\x7e]/.test(value))errors.push('non-ASCII path characters are rejected as confusable');
  const ext=path.posix.extname(value);if(ext&&EXECUTABLE_SUFFIXES.has(ext.toLowerCase())&&ext!==ext.toLowerCase())errors.push('case-confusable executable suffix');
  if(!allowDirectory&&value.endsWith('/'))errors.push('file path may not end with a separator');return errors;
}

function selectorMatches(rel,selector,inventory=null,ruleId=null){
  if(selector.paths)return selector.paths.includes(rel);
  const prefix=selector.directory+'/';if(!rel.startsWith(prefix))return false;
  if((selector.excludedPaths??[]).includes(rel))return false;
  if((selector.excludedDirectories??[]).some((d)=>rel===d||rel.startsWith(d+'/')))return false;
  if(selector.allowedSuffixes&&!selector.allowedSuffixes.some((s)=>rel.endsWith(s)))return false;
  if(selector.closedInventory&&inventory&&(!ruleId||!(inventory.rules[ruleId]??[]).includes(rel)))return false;
  return true;
}
function selectorContainsExact(selector,rel){return selectorMatches(rel,selector);}
function directoriesOverlap(a,b){
  const ad=a.directory,bd=b.directory;if(!ad||!bd)return false;
  const nested=ad===bd||ad.startsWith(bd+'/')||bd.startsWith(ad+'/');if(!nested)return false;
  const narrower=ad.length>=bd.length?ad:bd;const broader=ad.length>=bd.length?b:a;
  if((broader.excludedDirectories??[]).some((d)=>narrower===d||narrower.startsWith(d+'/')))return false;
  if(a.allowedSuffixes&&b.allowedSuffixes&&!a.allowedSuffixes.some((x)=>b.allowedSuffixes.includes(x)))return false;
  return true;
}
function selectorsOverlap(a,b){
  if(a.paths&&b.paths)return a.paths.some((x)=>b.paths.includes(x));
  if(a.paths)return a.paths.some((x)=>selectorContainsExact(b,x));
  if(b.paths)return b.paths.some((x)=>selectorContainsExact(a,x));
  return directoriesOverlap(a,b);
}
function validateManifestContract(manifest){
  const failures=[];const ids=new Set();const exclusionPaths=new Set();const pathKeys=[];
  for(const exclusion of manifest.exclusions){for(const e of validateRelativePath(exclusion.path))failures.push(failure('PATH_AMBIGUITY',e,null,exclusion.path));if(exclusionPaths.has(exclusion.path))failures.push(failure('DUPLICATE_EXCLUSION','Duplicate exclusion path',null,exclusion.path));exclusionPaths.add(exclusion.path);if(!SAFE_EXCLUSIONS.has(exclusion.path))failures.push(failure('UNATTESTED_EXCLUSION','Only the four exact reviewed Git/dependency trees may be excluded',null,exclusion.path));if(exclusion.path==='.git'&&exclusion.kind!=='git-metadata')failures.push(failure('EXCLUSION_KIND','The .git exclusion must be git-metadata',null,exclusion.path));if(exclusion.path!=='.git'&&exclusion.kind!=='dependency-tree')failures.push(failure('EXCLUSION_KIND','Installed dependency exclusions must be dependency-tree',null,exclusion.path));pathKeys.push({value:exclusion.path,kind:'exclusion'});}
  for(const rule of manifest.rules){
    if(ids.has(rule.id))failures.push(failure('DUPLICATE_RULE','Duplicate classification rule ID',null,rule.id));ids.add(rule.id);
    const values=rule.selector.paths??[rule.selector.directory,...(rule.selector.excludedPaths??[]),...(rule.selector.excludedDirectories??[])];
    for(const p of values){for(const e of validateRelativePath(p))failures.push(failure('PATH_AMBIGUITY',e,null,p));pathKeys.push({value:p,kind:`rule:${rule.id}`});}
    const variable=VARIABLE_CLASSES.has(rule.class);if(variable&&rule.bytesMustMatch)failures.push(failure('RULE_CONTRACT','Variable class cannot claim byte identity',null,rule.id));
    if(rule.selector.directory&&rule.selector.closedInventory!==true)failures.push(failure('OPEN_DIRECTORY_RULE','Every directory rule requires a closed enumerated inventory',null,rule.id));
    if(MATCH_CLASSES.has(rule.class)&&!rule.bytesMustMatch&&rule.validation.kind!=='package-behavior')failures.push(failure('RULE_CONTRACT','Behavioral class must require byte identity unless governed by a semantic package projection',null,rule.id));
    if(rule.class==='quarantined-blocking-divergence'&&(!rule.divergenceBlocking||!rule.transitional||!rule.expiresBefore))failures.push(failure('RULE_CONTRACT','Quarantine must be blocking, transitional, and expiring',null,rule.id));
    if(variable&&rule.productionReachable)failures.push(failure('VARIABLE_BEHAVIOR','Variable content cannot be production-reachable',null,rule.id));
    if(rule.class===SECRET_EXCLUDED_CLASS){
      // The exemption buys silence about content, so it has to be paid for in precision:
      // exact paths only, no byte claim, no divergence claim, and a written reason.
      if(!rule.selector.paths)failures.push(failure('SECRET_PATH_CONTRACT','A secret-path rule names exact paths; a directory rule would exempt files it never reviewed',null,rule.id));
      if(rule.validation.kind!=='secret-path-excluded')failures.push(failure('SECRET_PATH_CONTRACT','A secret-path rule must declare the secret-path-excluded validation kind',null,rule.id));
      if(rule.bytesMustMatch!==false)failures.push(failure('SECRET_PATH_CONTRACT','Credential content is never read, so it cannot be claimed to match',null,rule.id));
      if(rule.divergenceBlocking!==false)failures.push(failure('SECRET_PATH_CONTRACT','Credential divergence is the declared outcome, not a blocker',null,rule.id));
      if(typeof rule.attestation!=='string'||rule.attestation.length<16)failures.push(failure('SECRET_PATH_CONTRACT','A secret-path rule requires a written attestation',null,rule.id));
      for(const rel of rule.selector.paths??[])if(!classifySecretPath(rel).secret)failures.push(failure('SECRET_PATH_CONTRACT','A secret-path rule may only name paths the credential policy recognises',null,rel,{rule:rule.id}));
    }else if(rule.class===OWNER_SCOPED_CLASS){
      if(!SLOT_NAMES.includes(rule.owner))failures.push(failure('OWNER_SCOPE_CONTRACT','An owner-scoped rule names exactly one of the three agents as owner',null,rule.id,{owner:safeText(String(rule.owner))}));
      if(rule.productionReachable!==false)failures.push(failure('OWNER_SCOPE_CONTRACT','Owner-scoped content cannot be production-reachable',null,rule.id));
      if(rule.bytesMustMatch!==false)failures.push(failure('OWNER_SCOPE_CONTRACT','Owner-scoped content is not compared across repositories',null,rule.id));
      if(rule.divergenceBlocking!==false)failures.push(failure('OWNER_SCOPE_CONTRACT','Owner-scoped divergence is the declared outcome, not a blocker',null,rule.id));
      if(typeof rule.attestation!=='string'||rule.attestation.length<16)failures.push(failure('OWNER_SCOPE_CONTRACT','Owner-scoped content requires a written attestation',null,rule.id));
      if(typeof rule.ownerTreeDigest!=='string'||!/^sha256:[0-9a-f]{64}$/.test(rule.ownerTreeDigest))failures.push(failure('OWNER_SCOPE_CONTRACT','Owner-scoped content requires a measured tree digest',null,rule.id));
      if(!rule.selector.directory)failures.push(failure('OWNER_SCOPE_CONTRACT','Owner-scoped rules select a directory, so every member file is enumerated',null,rule.id));
    }else if(AGENT_OWNED_CLASSES.has(rule.class)){
      // Each agent ships its own interface at the same path. Bytes are not
      // compared; ownership, root containment, and the absence of shared
      // behaviour are what is enforced instead.
      for(const f of verifyAgentOwnedUiRule(rule,SLOT_NAMES))failures.push(failure(f.failureClass,f.message,null,rule.id,f.details));
    }else if(rule.owner!==undefined||rule.ownerTreeDigest!==undefined||rule.attestation!==undefined){
      failures.push(failure('OWNER_SCOPE_CONTRACT','Only an owner-scoped rule may carry owner, attestation, or tree digest',null,rule.id));
    }
  }
  for(let i=0;i<manifest.rules.length;i++)for(let j=i+1;j<manifest.rules.length;j++)if(selectorsOverlap(manifest.rules[i].selector,manifest.rules[j].selector))failures.push(failure('AMBIGUOUS_RULES','Classification rule domains overlap',null,null,{rules:[manifest.rules[i].id,manifest.rules[j].id]}));
  const folded=new Map();for(const x of pathKeys){const key=x.value.normalize('NFC').toLowerCase();const prior=folded.get(key);if(prior&&prior.value!==x.value)failures.push(failure('CASE_CONFUSABLE_PATH','Case-fold-confusable manifest paths',null,x.value,{other:prior.value}));else folded.set(key,x);}
  return failures;
}

function validateInventoryContract(inventory,manifest){
  const failures=[];const directoryRules=manifest.rules.filter((r)=>r.selector.directory);const expected=new Set(directoryRules.map((r)=>r.id));
  for(const id of Object.keys(inventory.rules)){if(!expected.has(id))failures.push(failure('INVENTORY_RULE_UNKNOWN','Path inventory contains an unknown/non-directory rule',null,id));}
  for(const rule of directoryRules){const paths=inventory.rules[rule.id];if(!Array.isArray(paths)){failures.push(failure('INVENTORY_RULE_MISSING','Closed directory rule has no path inventory',null,rule.id));continue;}const seen=new Set();for(const rel of paths){for(const e of validateRelativePath(rel))failures.push(failure('PATH_AMBIGUITY',e,null,rel));if(seen.has(rel))failures.push(failure('INVENTORY_DUPLICATE','Duplicate enumerated path',null,rel,{rule:rule.id}));seen.add(rel);const base={...rule.selector};delete base.closedInventory;if(!selectorMatches(rel,base))failures.push(failure('INVENTORY_PATH_OUTSIDE_RULE','Enumerated path is outside its rule domain',null,rel,{rule:rule.id}));}}
  return failures;
}

function git(root,args){return cp.execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
function normalizeRemote(raw){let s=raw.trim().replace(/\.git$/,'');s=s.replace(/^git@([^:]+):/,'$1/').replace(/^ssh:\/\/git@/,'').replace(/^https?:\/\//,'');return s;}
function executableContent(file,buffer,mode){const ext=path.posix.extname(file).toLowerCase();return Boolean(mode&0o111)||EXECUTABLE_SUFFIXES.has(ext)||buffer.subarray(0,128).toString('utf8').startsWith('#!');}
function inspectPng(buffer){
  const sig=Buffer.from([137,80,78,71,13,10,26,10]);if(buffer.length<8||!buffer.subarray(0,8).equals(sig))return 'PNG signature mismatch';let off=8,chunks=0,sawHeader=false,sawEnd=false;
  while(off<buffer.length){if(++chunks>256)return 'PNG chunk count exceeds limit';if(off+12>buffer.length)return 'PNG chunk is truncated';const length=buffer.readUInt32BE(off);const type=buffer.subarray(off+4,off+8).toString('ascii');if(length>64*1024*1024||off+12+length>buffer.length)return 'PNG chunk length is invalid';if(chunks===1&&type!=='IHDR')return 'PNG IHDR is not first';if(type==='IHDR'){if(sawHeader||length!==13)return 'PNG IHDR is invalid';sawHeader=true;const w=buffer.readUInt32BE(off+8),h=buffer.readUInt32BE(off+12);if(!w||!h||w>16384||h>16384||w*h>100_000_000)return 'PNG dimensions exceed limits';}if(['tEXt','zTXt','iTXt','eXIf'].includes(type))return 'PNG active/unreviewed metadata is forbidden';off+=12+length;if(type==='IEND'){if(length!==0)return 'PNG IEND is invalid';sawEnd=true;break;}}
  if(!sawHeader||!sawEnd)return 'PNG is incomplete';if(off!==buffer.length)return 'PNG has unexplained trailing bytes';return null;
}
function canonicalMode(stat){return (stat.mode&0o777).toString(8).padStart(3,'0');}

function walk(root,exclusions){
  const records=[];const collisions=new Map();
  function visit(dir,relDir=''){
    for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>Buffer.from(a.name).compare(Buffer.from(b.name)))){
      const rel=relDir?`${relDir}/${entry.name}`:entry.name;const pathErrors=validateRelativePath(rel);if(pathErrors.length){records.push({path:rel,kind:'invalid-path',pathErrors});continue;}
      const fold=rel.normalize('NFC').toLowerCase();if(collisions.has(fold)&&collisions.get(fold)!==rel)records.push({path:rel,kind:'case-collision',other:collisions.get(fold)});else collisions.set(fold,rel);
      const full=path.join(root,...rel.split('/'));const stat=fs.lstatSync(full);const excluded=exclusions.find((x)=>rel===x.path||rel.startsWith(x.path+'/'));
      if(stat.isSymbolicLink()){records.push({path:rel,kind:'symlink',mode:canonicalMode(stat),target:fs.readlinkSync(full),excluded:Boolean(excluded)});continue;}
      if(excluded){const allowedExclusionTypes=excluded.allowedTypes??['directory'];const actualType=stat.isDirectory()?'directory':stat.isFile()?'file':'special';if(rel===excluded.path&&!allowedExclusionTypes.includes(actualType))records.push({path:rel,kind:'invalid-exclusion-type',mode:canonicalMode(stat)});continue;}
      if(stat.isDirectory())visit(full,rel);else if(stat.isFile())records.push({path:rel,full,kind:stat.nlink>1?'hardlink':'file',stat,mode:canonicalMode(stat)});else records.push({path:rel,kind:'special',mode:canonicalMode(stat)});
    }
  }
  visit(root);return records;
}

function packageProjection(value,fields){return Object.fromEntries(fields.filter((k)=>Object.hasOwn(value,k)).map((k)=>[k,value[k]]));}
function validatePackage(file,expectedName,fields,authority){
  const value=parseStrictJsonText(authority.readText(file));const errors=[];if(value.name!==expectedName)errors.push(`expected package name ${expectedName}`);
  const allowed=new Set(['name','description',...fields]);for(const key of Object.keys(value))if(!allowed.has(key))errors.push(`ungoverned package field ${key}`);
  const projection=packageProjection(value,fields);return {errors,projection,projectionDigest:sha256(stableJson(projection))};
}
function validateContent(record,rule,schemaValidator,slotSpec,manifest,authority){
  const errors=[];if(record.kind!=='file')return errors;const buffer=authority.read(record.full);const text=buffer.toString('utf8');const exec=executableContent(record.path,buffer,record.stat.mode);
  if(VARIABLE_CLASSES.has(rule.class)&&exec)errors.push('variable data/asset/documentation is executable or behavior-bearing');
  const kind=rule.validation.kind;
  if(kind==='inert-image'){const issue=inspectPng(buffer);if(issue)errors.push(issue);}
  if(kind==='documentation'){
    if(record.path.endsWith('.json')){try{parseStrictJsonText(text);}catch(e){errors.push(`invalid documentation JSON: ${e.message}`);}}
    else if(!record.path.endsWith('.md'))errors.push('documentation format is not permitted');
  }
  if(kind==='model-data'){
    if(/<\/?(?:script|iframe|object|embed)\b|javascript:|```(?:js|javascript|ts|typescript|sh|bash|python|html)\b|(?:^|\n)\s*(?:@import|!include|loader:|module:)|\b(?:import\s*\(|require\s*\()/iu.test(text))errors.push('model-facing text contains active or execution-bearing syntax');
  }
  if(kind==='strict-json-data'){try{parseStrictJsonText(text);}catch(e){errors.push(`invalid strict JSON: ${e.message}`);}}
  const schemaKinds={"capsule-schema":'capsule',"deployment-schema":'deployment',"capability-pack-schema":'capabilityPack',"runtime-manifest-schema":'runtimeManifest',"boundary-schema":'boundary'};
  if(schemaKinds[kind]){const v=schemaValidator.parseText(schemaKinds[kind],text);if(!v.ok)errors.push(...v.errors.map((e)=>`${e.keyword}: ${e.message}`));}
  const governedKind=record.path.startsWith('trio/governance/capability-packs/')?'capabilityPack':record.path==='trio/governance/runtime-manifest.characterization.json'?'runtimeManifest':record.path.startsWith('trio/governance/deployment/')?'deployment':record.path==='trio/governance/boundary-manifest.json'?'boundary':null;
  if(governedKind&&!schemaKinds[kind]){const v=schemaValidator.parseText(governedKind,text);if(!v.ok)errors.push(...v.errors.map((e)=>`${e.keyword}: ${e.message}`));}
  return {errors,buffer,exec};
}
function framedDigest(records){const hash=crypto.createHash('sha256');for(const record of [...records].sort((a,b)=>Buffer.from(a.path).compare(Buffer.from(b.path)))){const bytes=Buffer.from(stableJson(record));const frame=Buffer.alloc(8);frame.writeBigUInt64BE(BigInt(bytes.length));hash.update(frame);hash.update(bytes);}return `sha256:${hash.digest('hex')}`;}
function framedEnvelope(fields){
  const hash=crypto.createHash('sha256');
  for(const key of Object.keys(fields).sort((a,b)=>Buffer.from(a).compare(Buffer.from(b)))){
    const keyBytes=Buffer.from(key),valueBytes=Buffer.from(stableJson(fields[key]));
    for(const bytes of [keyBytes,valueBytes]){const frame=Buffer.alloc(8);frame.writeBigUInt64BE(BigInt(bytes.length));hash.update(frame);hash.update(bytes);}
  }
  return `sha256:${hash.digest('hex')}`;
}
function canonicalInventory(value){const out=structuredClone(value);for(const key of Object.keys(out.rules))out.rules[key].sort((a,b)=>Buffer.from(a).compare(Buffer.from(b)));return stable(out);}
function publicRecord(record,rule,manifestVersion,content,packageInfo){return {path:record.path,classification:rule.class,fileType:record.kind,mode:record.mode,executable:Boolean(content?.exec),byteLength:content?.buffer?.length??null,byteDigest:content?.buffer?`sha256:${sha256(content.buffer)}`:null,behaviorDigest:packageInfo?`sha256:${packageInfo.projectionDigest}`:content?.buffer?`sha256:${sha256(content.buffer)}`:null,symlinkDisposition:record.kind==='symlink'?'rejected':'not-symlink',hardLinkDisposition:record.kind==='hardlink'?'rejected-multiple-links':'single-link',manifestVersion};}

function classifyRepository(slot,root,manifest,inventory,schemaValidator,authority,committed){
  const spec=manifest.repositories[slot];const failures=[];const rootReal=fs.realpathSync(root);const files=walk(rootReal,manifest.exclusions);const governed=[];const unknown=[];const rejected=[];const symlinks=[];const contentInvalid=[];const packageProjections={};const secretPaths=[];
  for(const exclusion of manifest.exclusions.filter((x)=>x.kind==='dependency-tree')){const tracked=committed?(committed.trackedUnderExclusions?.[exclusion.path]??[]):git(rootReal,['ls-files','--',exclusion.path]).split('\n').filter(Boolean);for(const rel of tracked)failures.push(failure('REPOSITORY_OWNED_EXCLUDED_FILE','A Git-tracked repository file is hidden inside an installed-dependency exclusion',slot,rel,{exclusion:exclusion.path}));}
  for(const rule of manifest.rules.filter((r)=>VARIABLE_CLASSES.has(r.class)&&r.selector.paths))for(const rel of rule.selector.paths){const full=path.join(rootReal,...rel.split('/'));if(fs.existsSync(full)){const stat=fs.lstatSync(full);if(!stat.isFile()&&!stat.isSymbolicLink())failures.push(failure('VARIABLE_FILE_TYPE','Variable path must be a regular file',slot,rel,{actual:stat.isDirectory()?'directory':'special'}));}}
  for(const file of files){
    if(file.kind==='invalid-path'){rejected.push({path:safeText(file.path),classification:'rejected-invalid-path',fileType:'unknown',mode:null,byteLength:null,byteDigest:null,reason:file.pathErrors.map(safeText)});for(const e of file.pathErrors)failures.push(failure('PATH_AMBIGUITY',e,slot,file.path));continue;}
    if(file.kind==='case-collision'){rejected.push({path:safeText(file.path),classification:'rejected-case-collision',fileType:'unknown',mode:null,byteLength:null,byteDigest:null,other:safeText(file.other)});failures.push(failure('CASE_CONFUSABLE_PATH','Repository contains case-fold-confusable paths',slot,file.path,{other:safeText(file.other)}));continue;}
    if(file.kind==='symlink'){
      const item={agent:slot,path:safeText(file.path),target:safeText(file.target),excluded:file.excluded};symlinks.push(item);rejected.push({path:item.path,classification:'rejected-symlink',fileType:'symlink',mode:file.mode,byteLength:Buffer.byteLength(file.target),byteDigest:`sha256:${sha256(file.target)}`,target:item.target});failures.push(failure('SYMLINK_REJECTED','In-scope or exclusion-boundary symlink rejected',slot,file.path));continue;}
    if(file.kind==='hardlink'){
      const buffer=authority.read(file.full);rejected.push({path:file.path,classification:'rejected-hardlink',fileType:'hardlink',mode:file.mode,byteLength:buffer.length,byteDigest:`sha256:${sha256(buffer)}`});failures.push(failure('HARDLINK_REJECTED','Governed regular file has multiple hard links',slot,file.path));continue;}
    if(file.kind!=='file'){rejected.push({path:file.path,classification:'rejected-special',fileType:file.kind,mode:file.mode,byteLength:null,byteDigest:null});failures.push(failure('FILE_TYPE','Non-regular governed filesystem entry',slot,file.path));continue;}
    // Decide secrecy from the path before a descriptor exists. Everything below this line
    // that reads bytes is unreachable for a credential-bearing path.
    const secret=classifySecretPath(file.path);
    const matches=manifest.rules.filter((r)=>selectorMatches(file.path,r.selector,inventory,r.id));
    if(matches.length!==1){
      // A newly encountered credential-like path is still fail-closed -- it is reported as
      // unclassified like any other unknown file -- but it is classified by path policy
      // rather than opened, so an unreviewed secret never enters the evidence.
      if(secret.secret){
        secretPaths.push({agent:slot,path:safeText(file.path),result:'SECRET_PATH_EXCLUDED',reason:secret.reason,classification:'unclassified',mode:file.mode,contentsRead:false});
        unknown.push({agent:slot,path:safeText(file.path),classification:matches.length?'ambiguous':'unclassified',fileType:'file',mode:file.mode,executable:Boolean(file.stat.mode&0o111),byteLength:null,byteDigest:null,secretPathExcluded:true,matches:matches.map((x)=>x.id).sort()});
        failures.push(failure('SECRET_PATH_UNGOVERNED','Credential-bearing path is not declared by a secret-path rule',slot,file.path,{reason:secret.reason}));
        continue;
      }
      const buffer=authority.read(file.full);unknown.push({agent:slot,path:safeText(file.path),classification:matches.length?'ambiguous':'unclassified',fileType:'file',mode:file.mode,executable:executableContent(file.path,buffer,file.stat.mode),byteLength:buffer.length,byteDigest:`sha256:${sha256(buffer)}`,matches:matches.map((x)=>x.id).sort()});failures.push(failure(matches.length?'AMBIGUOUS_CLASSIFICATION':'UNCLASSIFIED_FILE',matches.length?'File matches multiple rules':'File is not in the closed inventory',slot,file.path,{rules:matches.map((x)=>x.id).sort()}));continue;}
    const rule=matches[0];
    if(secret.secret||rule.class===SECRET_EXCLUDED_CLASS){
      // Only metadata is available, so metadata is all that is checked: a regular file,
      // not executable, not group- or world-writable. No byte length, no digest, no excerpt.
      const modeProblems=secretModeProblems(file.stat.mode);
      if(!secret.secret)failures.push(failure('SECRET_PATH_CONTRACT','A secret-path rule governs a path the credential policy does not recognise',slot,file.path,{rule:rule.id}));
      else if(rule.class!==SECRET_EXCLUDED_CLASS)failures.push(failure('SECRET_PATH_MISCLASSIFIED','Credential-bearing path is governed by a rule that would read its contents',slot,file.path,{rule:rule.id,class:rule.class,reason:secret.reason}));
      for(const problem of modeProblems)failures.push(failure('SECRET_PATH_MODE',problem,slot,file.path,{mode:file.mode}));
      secretPaths.push({agent:slot,path:safeText(file.path),result:'SECRET_PATH_EXCLUDED',reason:secret.reason??'declared secret-path rule',classification:rule.class,ruleId:rule.id,mode:file.mode,contentsRead:false});
      governed.push({path:file.path,classification:rule.class,fileType:file.kind,mode:file.mode,executable:Boolean(file.stat.mode&0o111),byteLength:null,byteDigest:null,behaviorDigest:null,symlinkDisposition:'not-symlink',hardLinkDisposition:'single-link',manifestVersion:manifest.schemaVersion,secretPathExcluded:true,ruleId:rule.id,bytesMustMatch:rule.bytesMustMatch,modeMustMatch:rule.modeMustMatch,divergenceBlocking:rule.divergenceBlocking,transitional:rule.transitional});
      continue;
    }
    let packageInfo=null;let content;
    try{
      content=validateContent(file,rule,schemaValidator,spec,manifest,authority);
      if(rule.validation.kind==='package-behavior'){packageInfo=validatePackage(file.full,spec.packageNames[file.path],manifest.packageBehaviorFields,authority);packageProjections[file.path]=packageInfo.projection;if(packageInfo.errors.length)content.errors.push(...packageInfo.errors);}
    }catch(error){
      // A refusal is a security decision, not a validation hiccup: it must not be folded into
      // this record and it must not be re-read "just to get a digest".
      if(isSecurityBoundaryError(error))throw error;
      const buffer=authority.read(file.full);
      content={errors:[error.message],buffer,exec:executableContent(file.path,buffer,file.stat.mode)};
    }
    if(content.errors.length){contentInvalid.push({agent:slot,path:file.path,errors:content.errors.map(safeText)});for(const e of content.errors)failures.push(failure('CONTENT_VALIDATION',e,slot,file.path));}
    governed.push({...publicRecord(file,rule,manifest.schemaVersion,content,packageInfo),ruleId:rule.id,bytesMustMatch:rule.bytesMustMatch,modeMustMatch:rule.modeMustMatch,divergenceBlocking:rule.divergenceBlocking,transitional:rule.transitional});
  }
  const byClass=(classes)=>governed.filter((x)=>classes.includes(x.classification));
  const canonicalUnknown=unknown.map(({agent,...x})=>x);const completeObserved=[...governed,...canonicalUnknown,...rejected];const digests={
    scaffoldingDigest:framedDigest(governed.filter((x)=>x.path.startsWith('trio/')||x.path.startsWith('scripts/trio/'))),
    sourceRuntimeDigest:framedDigest(governed.filter((x)=>x.path.startsWith('src/')||x.path.startsWith('tui/src/'))),
    behavioralTreeDigest:framedDigest(byClass(['behavior-identical','generated-behavior-identical','model-behavior-data','test-behavior-identical','quarantined-blocking-divergence'])),
    compiledArtifactDigest:framedDigest(byClass(['generated-behavior-identical'])),
    unclassifiedTreeDigest:framedDigest(canonicalUnknown),
    rejectedTreeDigest:framedDigest(rejected),
    completeObservedTreeDigest:framedDigest(completeObserved)
  };
  // On a committed-tree run the snapshot has no .git; identity comes from the authoritative
  // capture taken against the source repository before materialization.
  const identity=committed??{head:git(rootReal,['rev-parse','HEAD']),branch:git(rootReal,['branch','--show-current']),remote:normalizeRemote(git(rootReal,['remote','get-url','origin'])),dirty:git(rootReal,['status','--porcelain=v1','--ignored=no']).split('\n').filter(Boolean)};
  return {slot,root:rootReal,head:identity.head,branch:identity.branch,remote:identity.remote,dirty:(identity.dirty??[]).map(safeText),governed,unknown,rejected,symlinks,contentInvalid,packageProjections,secretPaths,digests,failures,authority};
}

function identityPreflight(slots,manifest,schemaValidator,makeAuthority,committedIdentities){
  const failures=[];const resolved={};const realpaths=new Map();
  for(const slot of SLOT_NAMES){
    const supplied=slots?.[slot];if(typeof supplied!=='string'||!supplied){failures.push(failure('MISSING_REPOSITORY','Required labeled repository slot was not supplied',slot));continue;}
    try{
      if(!fs.existsSync(supplied)||!fs.statSync(supplied).isDirectory())throw new Error('repository does not exist or is not a directory');
      fs.accessSync(supplied,fs.constants.R_OK);const real=fs.realpathSync(supplied);resolved[slot]=real;
      // Built from a metadata-only sweep, before this slot's first content read.
      const authority=makeAuthority(real);
      if(realpaths.has(real))failures.push(failure('DUPLICATE_REPOSITORY','Two labeled slots resolve to the same canonical repository',slot,null,{otherAgent:realpaths.get(real)}));else realpaths.set(real,slot);
      const spec=manifest.repositories[slot];
      // On a committed-tree run the input is a snapshot directory, so its basename is a
      // temporary name by construction. The repository identity was established against the
      // source repository before materialization and is carried in the committed identity.
      const expectedName=committedIdentities?.[slot]?.expectedRepositoryName??spec.expectedRepositoryName;
      const actualName=committedIdentities?.[slot]?.repositoryName??path.basename(real);
      if(actualName!==expectedName)failures.push(failure('REPOSITORY_NAME_MISMATCH','Canonical repository directory name does not match the labeled slot',slot));
      let remote;if(committedIdentities?.[slot])remote=committedIdentities[slot].remote;else try{remote=normalizeRemote(git(real,['remote','get-url','origin']));}catch{throw new Error('Git origin remote is missing or unreadable');}if(remote!==spec.remoteIdentity)failures.push(failure('REMOTE_IDENTITY_MISMATCH','Git origin does not match the expected stable identity',slot,null,{expected:spec.remoteIdentity,actual:safeText(remote)}));
      for(const [packagePath,expected] of Object.entries(spec.packageNames)){try{const p=parseStrictJsonText(authority.readText(path.join(real,packagePath)));if(p.name!==expected)failures.push(failure('PACKAGE_IDENTITY_MISMATCH','Package identity does not match the labeled slot',slot,packagePath,{expected,actual:safeText(p.name)}));}catch(error){if(isSecurityBoundaryError(error))throw error;failures.push(failure('PACKAGE_IDENTITY_MISMATCH',error.message,slot,packagePath));}}
      const capsule=schemaValidator.parseText('capsule',authority.readText(path.join(real,spec.capsulePath)));if(!capsule.ok)failures.push(failure('CAPSULE_IDENTITY_MISMATCH','Expected capsule is missing or schema-invalid',slot,spec.capsulePath,{errors:capsule.errors}));else if(capsule.value.identity.id!==spec.capsuleIdentity)failures.push(failure('CAPSULE_IDENTITY_MISMATCH','Capsule identity does not match the labeled slot',slot,spec.capsulePath,{expected:spec.capsuleIdentity,actual:safeText(capsule.value.identity.id)}));
    }catch(error){if(isSecurityBoundaryError(error))throw error;failures.push(failure('MALFORMED_REPOSITORY',error.message,slot));}
  }
  return {resolved,failures};
}

function compare(repositories,manifest,inventory,manifestDigest){
  const failures=[];const maps=Object.fromEntries(repositories.map((r)=>[r.slot,new Map(r.governed.map((x)=>[x.path,x]))]));const inventoried=[...new Set(Object.values(inventory.rules).flat())];const allPaths=[...new Set([...repositories.flatMap((r)=>r.governed.map((x)=>x.path)),...inventoried])].sort((a,b)=>Buffer.from(a).compare(Buffer.from(b)));
  const identical=[],divergent=[],missing=[],variableDifferences=[],quarantined=[],ownerScoped=[],agentOwnedUi=[],secretExcluded=[];
  for(const rel of allPaths){const rows=SLOT_NAMES.map((s)=>maps[s].get(rel));const classes=new Set(rows.filter(Boolean).map((x)=>x.classification));if(classes.size>1){failures.push(failure('CLASSIFICATION_MISMATCH','Corresponding path has different classifications',null,rel,{classes:[...classes].sort()}));continue;}const inventoryRule=manifest.rules.find((r)=>(inventory.rules[r.id]??[]).includes(rel));const klass=[...classes][0]??inventoryRule?.class;const present=rows.filter(Boolean);
    if(klass===SECRET_EXCLUDED_CLASS){
      // Presence may legitimately differ (one deployment holds a backup the others do not)
      // and the bytes are unavailable by policy, so the only cross-repository statement the
      // verifier can honestly make is that the path was seen and never opened.
      for(const i of SLOT_NAMES.keys())if(rows[i])secretExcluded.push({path:rel,agent:SLOT_NAMES[i],mode:rows[i].mode,result:'SECRET_PATH_EXCLUDED',contentsRead:false});
      continue;
    }
    if(AGENT_OWNED_CLASSES.has(klass)){
      // (1) excluded from byte comparison, (2) present only in declared owners,
      // (8) different features permitted.
      // Resolve the rule by path as well as by inventory: a rule that selects
      // explicit paths has no inventory entry, and treating that as "no owners"
      // made every legitimate file look like an intruder.
      const ownRule=inventoryRule??manifest.rules.find((r)=>AGENT_OWNED_CLASSES.has(r.class)&&selectorMatches(rel,r.selector));
      const owners=ownRule?.owners??[];
      const intruders=owners.length?SLOT_NAMES.filter((s2,i)=>rows[i]&&!owners.includes(s2)):[];
      if(intruders.length)failures.push(failure('UI_OWNERSHIP_VIOLATION','Agent-owned UI path is present in an agent that does not declare the surface',null,rel,{owners,presentIn:intruders}));
      // Owning a copy is not the same as owning the behaviour. An executable that two or
      // three agents all ship, at the same path, with different bytes, is shared surface
      // drift wearing an ownership label -- and "obsolete" is a claim about the file, not
      // evidence about it. Only a rule that declares the divergence to be agent identity
      // escapes the comparison; everything else is compared where it is present.
      // Scoped to agent-owned *content*. An agent-owned UI is a different product surface by
      // design -- the three agents ship deliberately different interfaces -- so comparing its
      // bytes would flag the very variation the class exists to permit. What keeps a UI
      // honest is the shared-behaviour checks below, not byte equality.
      const strictExecutables=klass===AGENT_OWNED_CONTENT_CLASS&&ownRule?.executablePolicy!=='agent-identity';
      if(strictExecutables&&present.length>1&&present.some((x)=>x.executable)){
        const digests=present.map((x)=>x.byteDigest);
        if(new Set(digests).size>1){
          divergent.push({path:rel,class:klass,records:Object.fromEntries(SLOT_NAMES.map((s2,i)=>[s2,rows[i]?{mode:rows[i].mode,byteDigest:rows[i].byteDigest,behaviorDigest:rows[i].behaviorDigest}:null]))});
          failures.push(failure('BEHAVIOR_DIVERGENCE','Executable content shipped by more than one agent diverges under an ownership claim',null,rel,{class:klass,rule:ownRule?.id??null,presentIn:SLOT_NAMES.filter((_,i)=>rows[i])}));
        }
      }
      for(const i of SLOT_NAMES.map((s2,i2)=>i2))if(rows[i])agentOwnedUi.push({path:rel,agent:SLOT_NAMES[i],digest:rows[i].byteDigest,mode:rows[i].mode});
      continue;
    }
    if(klass===OWNER_SCOPED_CLASS){
      // Present in its owner and absent everywhere else. Absence elsewhere is the contract,
      // so presence elsewhere is the violation -- an owner-scoped path appearing in a second
      // repository is an undeclared shared tree wearing an exemption.
      const owner=inventoryRule?.owner;const ownerIndex=SLOT_NAMES.indexOf(owner);
      const intruders=SLOT_NAMES.filter((s,i)=>rows[i]&&i!==ownerIndex);
      if(intruders.length)failures.push(failure('OWNER_SCOPE_VIOLATION','Owner-scoped path is present outside its declared owner',null,rel,{owner:safeText(String(owner)),presentIn:intruders}));
      else if(!rows[ownerIndex])failures.push(failure('OWNER_SCOPE_ABSENT','Owner-scoped path is absent from its declared owner',null,rel,{owner:safeText(String(owner))}));
      else ownerScoped.push({path:rel,owner,digest:rows[ownerIndex].byteDigest,mode:rows[ownerIndex].mode});
      continue;
    }
    if(MATCH_CLASSES.has(klass)){
      if(present.length!==SLOT_NAMES.length){const item={path:rel,class:klass,missingIn:SLOT_NAMES.filter((_,i)=>!rows[i])};missing.push(item);failures.push(failure('MISSING_BEHAVIOR_FILE','Behavior-bearing file is missing from one or more repositories',null,rel,{missingIn:item.missingIn}));continue;}
      const values=rows.map((x)=>`${x.fileType}:${x.mode}:${x.behaviorDigest}`);if(new Set(values).size!==1){divergent.push({path:rel,class:klass,records:Object.fromEntries(SLOT_NAMES.map((s,i)=>[s,{mode:rows[i].mode,byteDigest:rows[i].byteDigest,behaviorDigest:rows[i].behaviorDigest}]))});failures.push(failure('BEHAVIOR_DIVERGENCE','Behavioral canonical record differs',null,rel,{class:klass}));}else identical.push({path:rel,class:klass,digest:rows[0].behaviorDigest,mode:rows[0].mode});
      if(klass==='quarantined-blocking-divergence'){quarantined.push({path:rel,status:present.length===3&&new Set(values).size===1?'identical-but-quarantined':'divergent-or-missing'});failures.push(failure('QUARANTINED_DIVERGENCE','Transitional behavior-bearing path remains quarantined',null,rel));}
    }else if(VARIABLE_CLASSES.has(klass)){
      const values=rows.map((x)=>x?`${x.fileType}:${x.mode}:${x.byteDigest}`:'missing');if(new Set(values).size>1)variableDifferences.push({path:rel,class:klass,records:Object.fromEntries(SLOT_NAMES.map((s,i)=>[s,rows[i]?{mode:rows[i].mode,digest:rows[i].byteDigest}:null]))});
      if(present.length!==SLOT_NAMES.length)failures.push(failure('VARIABLE_PRESENCE_MISMATCH','Required variable-data path is not present in every repository',null,rel,{missingIn:SLOT_NAMES.filter((_,i)=>!rows[i])}));
      else if(new Set(rows.map((x)=>x.fileType)).size!==1)failures.push(failure('VARIABLE_TYPE_MISMATCH','Variable-data file types differ',null,rel));
      else if(rows[0].modeMustMatch&&new Set(rows.map((x)=>x.mode)).size!==1)failures.push(failure('VARIABLE_MODE_MISMATCH','Variable-data modes differ despite modeMustMatch',null,rel));
    }
  }
  // A governed file whose declared format could not be established is quarantined rather
  // than accepted. A malformed or polyglot asset has no single meaning, and a verifier that
  // shrugs at "it is probably a PNG" is the verifier that let the polyglot through.
  for(const rel of [...new Set(repositories.flatMap((r)=>r.contentInvalid.map((x)=>x.path)))].sort((a,b)=>Buffer.from(a).compare(Buffer.from(b)))){
    quarantined.push({path:rel,status:'content-invalid-quarantined'});
    failures.push(failure('QUARANTINED_DIVERGENCE','Governed content could not be established as valid for its declared format and is quarantined',null,rel));
  }
  const blockingByClass={};for(const f of failures)blockingByClass[f.failureClass]=(blockingByClass[f.failureClass]??0)+1;
  // (3)(4)(5)(6)(7) Content governance for every declared agent-owned UI tree.
  const sharedContracts=manifest.sharedContractVersions??null;
  const sharedRules=new Set(manifest.rules.filter((r)=>r.class==='behavior-identical'||r.class==='test-behavior-identical').map((r)=>r.id));
  let sharedSourceText='';
  for(const repo of repositories.slice(0,1)){
    for(const rel of (repo.governed??[]).map((x)=>x.path)){
      if(!/\.(ts|tsx|js|mjs|cjs)$/i.test(rel))continue;
      const ir=inventory.rules;const owning=Object.keys(ir).find((k)=>(ir[k]??[]).includes(rel));
      if(!owning||!sharedRules.has(owning))continue;
      if(classifySecretPath(rel).secret)continue;
      // Was `catch{}`: a refusal here would have vanished entirely. Only genuine absence is
      // tolerated; a credential refusal propagates.
      try{sharedSourceText+='\n'+repo.authority.readText(path.join(repo.root,...rel.split('/')));}
      catch(error){if(isSecurityBoundaryError(error))throw error;}
    }
  }
  for(const rule of manifest.rules.filter((r)=>AGENT_OWNED_CLASSES.has(r.class))){
    for(const repo of repositories){
      // Credential paths never enter the agent-owned work list. This is the pass the audit
      // found reaching an unguarded reader, so it is filtered by policy as well as guarded.
      const paths=(inventory.rules[rule.id]??[]).filter((rel)=>maps[repo.slot].has(rel)&&!classifySecretPath(rel).secret);
      if(!paths.length)continue;
      // The secondary agent-owned pass. This is the reader the audit caught: it reached an
      // unrestricted primitive with no secret classification and turned the resulting error
      // into `null`, so a credential read looked exactly like an absent optional file and
      // verification carried on to publish PARITY.
      const read=(rel)=>{
        try{return repo.authority.readText(path.join(repo.root,...rel.split('/')));}
        catch(error){if(isSecurityBoundaryError(error))throw error;return null;}
      };
      for(const f of verifyAgentOwnedUi({slot:repo.slot,rule,paths,read,sharedContracts}))
        failures.push(failure(f.failureClass,f.message,f.agent,f.affectedPath,f.details));
      // Uniqueness is not ownership: shared code must not reach into it, and
      // portable role behaviour must not hide inside it.
      for(const f of verifyAgentOwnedHasNoPortableRoleLogic({slot:repo.slot,rule,paths,read}))
        failures.push(failure(f.failureClass,f.message,f.agent,f.affectedPath,f.details));
      if(repo===repositories[0])for(const f of verifyAgentOwnedNotImportedByShared({rule,paths,sharedSourceText}))
        failures.push(failure(f.failureClass,f.message,f.agent,f.affectedPath,f.details));
    }
  }
  return {identical,divergent,missing,variableDifferences,quarantined,ownerScoped,agentOwnedUi,secretExcluded,failures,blockingByClass};
}


/**
 * Prove an owner-scoped tree is genuinely outside the shared distribution.
 *
 * Absence from the other two repositories is cheap to declare and worthless on its own: a
 * tree that nothing shares but everything imports is still shared behaviour. These checks
 * are what the exemption is paid for -- the tree must be unreachable from the runtime, must
 * not overlap System A's governed set, must not carry a service unit or build output, must
 * not be named by a package hook, and must not be loaded as model-facing prompt data.
 */
function verifyOwnerScopedIsolation(repositories,manifest,inventory,resolved){
  const authorityFor=(slot)=>repositories.find((r)=>r.slot===slot)?.authority;
  const failures=[];
  const rules=manifest.rules.filter((r)=>r.class===OWNER_SCOPED_CLASS);
  if(!rules.length)return failures;
  for(const rule of rules){
    const owner=rule.owner;const ownerRoot=resolved[owner];if(!ownerRoot)continue;
    const members=(inventory.rules[rule.id]??[]);
    const prefix=rule.selector.directory+'/';

    // (a) no overlap with System A's closure or shared inventory, in any repository
    for(const slot of SLOT_NAMES){
      const root=resolved[slot];if(!root)continue;
      let closure,systemA;
      try{closure=parseStrictJsonText(authorityFor(slot).readText(path.join(root,'trio/runtime-closure.json')));}catch(error){if(isSecurityBoundaryError(error))throw error;closure=null;}
      try{systemA=parseStrictJsonText(authorityFor(slot).readText(path.join(root,'trio/path-inventory.json')));}catch(error){if(isSecurityBoundaryError(error))throw error;systemA=null;}
      const governedSets=[];
      if(closure)governedSets.push(closure.entryPoints??[],closure.governedCommon??[],closure.configurationData??[],closure.spawnedRuntimeFiles??[],closure.generatedRuntime?.governedCommon??[]);
      if(systemA)governedSets.push(systemA.sharedFiles??[],systemA.configurationData??[]);
      for(const set of governedSets)for(const p of set){
        if(p===rule.selector.directory||p.startsWith(prefix))failures.push(failure('OWNER_SCOPE_REACHABLE','Owner-scoped path appears in the shared runtime closure or inventory',slot,p,{rule:rule.id}));
      }
      if(systemA)for(const dir of systemA.closedDirectories??[])if(dir===rule.selector.directory||dir.startsWith(prefix)||rule.selector.directory.startsWith(dir+'/'))failures.push(failure('OWNER_SCOPE_REACHABLE','Owner-scoped directory intersects a closed runtime directory',slot,dir,{rule:rule.id}));
    }

    // (b) nothing governed may reference the tree: imports, requires, or bare path mentions
    const ownerRepo=repositories.find((r)=>r.slot===owner);
    if(ownerRepo){
      for(const record of ownerRepo.governed){
        if(record.path===rule.selector.directory||record.path.startsWith(prefix))continue;
        if(record.classification===OWNER_SCOPED_CLASS)continue;
        // The governance tree necessarily names the directory in order to declare it. That
        // is the declaration itself, not a runtime reference, and excluding it here is what
        // keeps the check about reachability rather than about its own bookkeeping.
        if(record.path.startsWith('trio/'))continue;
        // The retained vulnerable fixture carries a frozen copy of a boundary manifest, so it
        // names directories for the same declarative reason the live governance tree does.
        if(record.path.startsWith('scripts/trio/fixtures/'))continue;
        // A credential-bearing object is excluded by policy *before* the read is attempted.
        // Leaning on the authority to refuse would still mean asking to open it, and the
        // reachability question does not need its bytes: a credential cannot legitimately be
        // the thing that reaches an owner-scoped tree.
        if(record.secretPathExcluded===true||classifySecretPath(record.path).secret)continue;
        let text;try{text=authorityFor(owner).readText(path.join(ownerRoot,...record.path.split('/')));}catch(error){if(isSecurityBoundaryError(error))throw error;continue;}
        // Path-shaped references only. Prose that happens to contain the directory's name is
        // not reachability, but a quoted segment or a path prefix is how the tree would
        // actually be reached -- `join(root, 'memories')` must fire, "fond memories" must not.
        const d=rule.selector.directory;
        const referenced=text.includes(d+'/')||text.includes(`'${d}'`)||text.includes(`"${d}"`)||text.includes('`'+d+'`');
        if(referenced)failures.push(failure('OWNER_SCOPE_REFERENCED','A governed file references an owner-scoped tree',owner,record.path,{rule:rule.id}));
      }
    }

    // (c) the tree itself may not carry a service entrypoint or compiled build output
    for(const rel of members){
      if(/\.service$/.test(rel))failures.push(failure('OWNER_SCOPE_ENTRYPOINT','Owner-scoped trees cannot carry a service unit',owner,rel,{rule:rule.id}));
      if(/(^|\/)dist\//.test(rel)||/\.map$/.test(rel))failures.push(failure('OWNER_SCOPE_BUILD_OUTPUT','Owner-scoped trees cannot carry build output',owner,rel,{rule:rule.id}));
    }

    // (d) no package hook may name it
    try{
      const pkg=parseStrictJsonText(authorityFor(owner).readText(path.join(ownerRoot,'package.json')));
      for(const [name,body] of Object.entries(pkg.scripts??{}))if(typeof body==='string'&&body.includes(rule.selector.directory))failures.push(failure('OWNER_SCOPE_PACKAGE_HOOK','A package script invokes an owner-scoped tree',owner,`scripts.${safeText(name)}`,{rule:rule.id}));
      for(const field of ['main','module','types','browser','bin','exports'])if(JSON.stringify(pkg[field]??null).includes(rule.selector.directory))failures.push(failure('OWNER_SCOPE_PACKAGE_HOOK','A package entrypoint field names an owner-scoped tree',owner,field,{rule:rule.id}));
    }catch(error){if(isSecurityBoundaryError(error))throw error;/* package identity is already validated in the identity preflight */}

    // (e) the capsule may not load it as model-facing data
    try{
      const capsuleText=authorityFor(owner).readText(path.join(ownerRoot,manifest.repositories[owner].capsulePath));
      if(capsuleText.includes(rule.selector.directory))failures.push(failure('OWNER_SCOPE_PROMPT_LOAD','A capsule loads an owner-scoped tree as model-facing data',owner,manifest.repositories[owner].capsulePath,{rule:rule.id}));
    }catch(error){if(isSecurityBoundaryError(error))throw error;/* capsule validity is asserted in the identity preflight */}

    // (f) the declared tree digest must equal what is on disk
    const hash=crypto.createHash('sha256');
    for(const rel of [...members].sort((a,b)=>Buffer.from(a).compare(Buffer.from(b)))){
      if(classifySecretPath(rel).secret)continue;
      let bytes;try{bytes=authorityFor(owner).read(path.join(ownerRoot,rel));}catch(error){if(isSecurityBoundaryError(error))throw error;continue;}
      hash.update(`file:${Buffer.byteLength(rel)}:`).update(rel).update(`:${bytes.length}:`).update(bytes);
    }
    const measured=`sha256:${hash.digest('hex')}`;
    if(measured!==rule.ownerTreeDigest)failures.push(failure('OWNER_SCOPE_DIGEST','Owner-scoped tree does not match its acknowledged digest',owner,rule.selector.directory,{expected:rule.ownerTreeDigest,actual:measured}));
  }
  return failures;
}

export function verify({slots,manifestPath,committedIdentities=null}){
  try{
    if(!manifestPath)return invalidResult('INVALID_INPUT',[failure('MISSING_MANIFEST','A boundary manifest path is required')]);
    const manifestReal=path.resolve(manifestPath);const governanceRoot=path.dirname(manifestReal);const governanceAuthority=createReadAuthority({root:governanceRoot,secretObjects:scanSecretObjects(governanceRoot)});const manifestBytes=governanceAuthority.read(manifestReal);const schemaDir=path.join(governanceRoot,'schemas');const schemaValidator=createSchemaValidator(schemaDir,{readText:(file)=>governanceAuthority.readText(file)});const manifestValidation=schemaValidator.parseText('boundary',manifestBytes.toString('utf8'));
    if(!manifestValidation.ok)return invalidResult('SCHEMA_INVALID',manifestValidation.errors.map((e)=>failure('SCHEMA_VALIDATION',`${e.keyword}: ${e.message}`,null,manifestReal,e.params)));
    const manifest=manifestValidation.value;const contractFailures=validateManifestContract(manifest);if(manifest.pathInventory.path!=='path-inventory.json')contractFailures.push(failure('INVENTORY_PATH_INVALID','The closed inventory must use the exact governed path path-inventory.json',null,manifest.pathInventory.path));if(contractFailures.length)return invalidResult('MANIFEST_INVALID',contractFailures,{boundaryManifestDigest:`sha256:${sha256(manifestBytes)}`});
    const inventoryReal=path.join(governanceRoot,manifest.pathInventory.path);const inventoryBytes=governanceAuthority.read(inventoryReal);const inventoryValidation=schemaValidator.parseText('pathInventory',inventoryBytes.toString('utf8'));
    if(!inventoryValidation.ok)return invalidResult('SCHEMA_INVALID',inventoryValidation.errors.map((e)=>failure('SCHEMA_VALIDATION',`${e.keyword}: ${e.message}`,null,inventoryReal,e.params)));
    const inventory=inventoryValidation.value;const inventoryFailures=validateInventoryContract(inventory,manifest);if(inventoryFailures.length)return invalidResult('MANIFEST_INVALID',inventoryFailures);
    // One authorization boundary per repository, built from a metadata-only sweep so an alias
    // is refused whether or not its canonical path has been walked yet.
    const declaredSecretPaths=manifest.rules.filter((r)=>r.class===SECRET_EXCLUDED_CLASS).flatMap((r)=>r.selector.paths??[]);
    const authorities=new Map();
    const makeAuthority=(realRoot)=>{
      if(!authorities.has(realRoot))authorities.set(realRoot,createReadAuthority({root:realRoot,secretObjects:scanSecretObjects(realRoot,{exclusions:manifest.exclusions,declaredPaths:declaredSecretPaths})}));
      return authorities.get(realRoot);
    };
    const identities=identityPreflight(slots,manifest,schemaValidator,makeAuthority,committedIdentities);if(identities.failures.length)return invalidResult('IDENTITY_INVALID',identities.failures,{repositoryInputs:Object.fromEntries(SLOT_NAMES.map((s)=>[s,slots?.[s]??null]))});
    // The Truth Firewall is the authority this trio defers to, so a parity verdict that did
    // not know which Truth was running would be a verdict about nothing. Resolve the
    // activated release, recompute its closure, and refuse to continue if the executable
    // authority is not the pinned one.
    const truth=verifyTruthRelease(manifest.truthRelease);
    if(!truth.ok)return invalidResult('TRUTH_IDENTITY_MISMATCH',truth.problems.map((x)=>failure('TRUTH_IDENTITY_MISMATCH',x.message,null,manifest.truthRelease?.activationWrapper??null,Object.fromEntries(Object.entries(x).filter(([k])=>k!=='message')))),{truthRelease:{pinned:manifest.truthRelease??null,validationMethod:TRUTH_BINDING_CONTRACT.validationMethod}});
    const manifestDigest=`sha256:${sha256(stableJson(canonicalManifest(manifest)))}`;const manifestByteDigest=`sha256:${sha256(manifestBytes)}`;const inventoryDigest=`sha256:${sha256(stableJson(canonicalInventory(inventory)))}`;const inventoryByteDigest=`sha256:${sha256(inventoryBytes)}`;const manifestFailures=[];
    for(const slot of SLOT_NAMES){
      const local=path.join(identities.resolved[slot],'trio/governance/boundary-manifest.json'),localInventory=path.join(identities.resolved[slot],'trio/governance/path-inventory.json');
      try{
        const authority=makeAuthority(identities.resolved[slot]);const localValidation=schemaValidator.parseText('boundary',authority.readText(local));if(!localValidation.ok){manifestFailures.push(failure('MANIFEST_DIVERGENCE','Repository-local boundary manifest is invalid',slot,'trio/governance/boundary-manifest.json',{errors:localValidation.errors}));continue;}
        const localContract=validateManifestContract(localValidation.value);if(localContract.length){manifestFailures.push(failure('MANIFEST_DIVERGENCE','Repository-local boundary manifest violates the classification contract',slot,'trio/governance/boundary-manifest.json',{errors:localContract}));continue;}
        const digest=`sha256:${sha256(stableJson(canonicalManifest(localValidation.value)))}`;if(digest!==manifestDigest)manifestFailures.push(failure('MANIFEST_DIVERGENCE','Repository-local boundary manifest differs semantically from the governing manifest',slot,'trio/governance/boundary-manifest.json',{expected:manifestDigest,actual:digest}));
        const localInvValidation=schemaValidator.parseText('pathInventory',authority.readText(localInventory));if(!localInvValidation.ok){manifestFailures.push(failure('INVENTORY_DIVERGENCE','Repository-local path inventory is invalid',slot,'trio/governance/path-inventory.json',{errors:localInvValidation.errors}));continue;}
        const localInvContract=validateInventoryContract(localInvValidation.value,manifest);if(localInvContract.length){manifestFailures.push(failure('INVENTORY_DIVERGENCE','Repository-local path inventory violates the closed inventory contract',slot,'trio/governance/path-inventory.json',{errors:localInvContract}));continue;}
        const localInvDigest=`sha256:${sha256(stableJson(canonicalInventory(localInvValidation.value)))}`;if(localInvDigest!==inventoryDigest)manifestFailures.push(failure('INVENTORY_DIVERGENCE','Repository-local path inventory differs semantically from the governing inventory',slot,'trio/governance/path-inventory.json',{expected:inventoryDigest,actual:localInvDigest}));
      }catch(error){if(isSecurityBoundaryError(error))throw error;manifestFailures.push(failure('MANIFEST_DIVERGENCE',error.message,slot,'trio/governance/boundary-manifest.json'));}
    }
    // Each repository also pins Truth in its runtime closure. A second pin that disagrees
    // with the executable authority is exactly the kind of stale claim this verifier exists
    // to catch, so it is compared rather than assumed to agree.
    const truthClosureFailures=[];
    for(const slot of SLOT_NAMES){
      const rel=manifest.truthRelease.runtimeClosureDeclarationPath;
      try{
        const closure=parseStrictJsonText(makeAuthority(identities.resolved[slot]).readText(path.join(identities.resolved[slot],...rel.split('/'))));
        const declared=(closure.legitimateExternalDependencies??[]).find((d)=>d.specifier===manifest.truthRelease.specifier);
        if(!declared)truthClosureFailures.push(failure('TRUTH_IDENTITY_MISMATCH','Repository runtime closure declares no Truth release',slot,rel));
        else for(const [field,actual] of [['releaseId',declared.releaseId],['packageClosureSha256',declared.packageClosureSha256],['packageClosureFileCount',declared.packageClosureFileCount]])
          if(actual!==truth.identity[field])truthClosureFailures.push(failure('TRUTH_IDENTITY_MISMATCH',`Repository runtime closure pins a ${field} that is not the activated Truth authority`,slot,rel,{field,pinned:actual===undefined?null:actual,activated:truth.identity[field]}));
      }catch(error){if(isSecurityBoundaryError(error))throw error;truthClosureFailures.push(failure('TRUTH_IDENTITY_MISMATCH',`Repository runtime closure is unreadable: ${error.message}`,slot,rel));}
    }
    // A stale pin is a blocking finding, not a reason to stop looking. Failing to resolve the
    // authority at all is different -- that is handled above, because a verifier that does
    // not know which Truth is running cannot say anything useful about the rest.
    if(manifestFailures.length)return invalidResult('MANIFEST_DIVERGENCE',manifestFailures,{boundaryManifestDigest:manifestDigest,truthRelease:truth.identity});
    const repositories=SLOT_NAMES.map((slot)=>classifyRepository(slot,identities.resolved[slot],manifest,inventory,schemaValidator,makeAuthority(identities.resolved[slot]),committedIdentities?.[slot]??null));const repoFailures=repositories.flatMap((r)=>r.failures);const compared=compare(repositories,manifest,inventory,manifestDigest);const ownerScopeFailures=verifyOwnerScopedIsolation(repositories,manifest,inventory,identities.resolved);// Certification state is measured here and enforced at the publication boundary (see
    // publishedResult). Keeping the gate out of the comparison engine is deliberate: if
    // verify() refused to run uncertified, certifying would require a certification, and the
    // release step could never bootstrap. That circularity is the recursive test execution
    // this design is required to avoid.
    const certification=validateCertification();
    const failures=[...repoFailures,...compared.failures,...ownerScopeFailures,...truthClosureFailures];const blockingByClass={};for(const f of failures)blockingByClass[f.failureClass]=(blockingByClass[f.failureClass]??0)+1;
    const packageBehaviorProjection=Object.fromEntries(repositories.map((r)=>[r.slot,{projection:r.packageProjections,digest:`sha256:${sha256(stableJson(r.packageProjections))}`} ]));
    const implementationPaths={verifier:fileURLToPath(import.meta.url),strictParser:path.join(path.dirname(fileURLToPath(import.meta.url)),'strict-json.mjs'),validator:path.join(path.dirname(fileURLToPath(import.meta.url)),'schema-validation.mjs')};
    const implementationRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');const implementationAuthority=makeAuthority(implementationRoot);
    const implementation=Object.fromEntries(Object.entries(implementationPaths).map(([key,file])=>[key,{version:key==='verifier'?VERIFIER_CONTRACT.version:key==='strictParser'?'3.0.0':SCHEMA_VALIDATOR.version,digest:`sha256:${sha256(implementationAuthority.read(file))}`} ]));
    const schemaFiles=['boundary.schema.json','path-inventory.schema.json','capsule.schema.json','deployment.schema.json','capability-pack.schema.json','runtime-manifest.schema.json'];const schemas=Object.fromEntries(schemaFiles.map((name)=>{const bytes=governanceAuthority.read(path.join(schemaDir,name));return [name,{digest:`sha256:${sha256(bytes)}`,id:parseStrictJsonText(bytes.toString('utf8')).$id}];}));
    const completeRuleDigest=framedEnvelope({rules:canonicalManifest(manifest).rules,pathInventory:canonicalInventory(inventory)}),completeExclusionDigest=framedEnvelope({exclusions:canonicalManifest(manifest).exclusions});
    const identityContract=Object.fromEntries(SLOT_NAMES.map((slot)=>[slot,manifest.repositories[slot]]));
    const contractFields={verifier:VERIFIER_CONTRACT,implementation,validator:SCHEMA_VALIDATOR,schemas,boundaryManifestDigest:manifestDigest,boundaryManifestByteDigest:manifestByteDigest,pathInventoryDigest:inventoryDigest,pathInventoryByteDigest:inventoryByteDigest,completeRuleDigest,completeExclusionDigest,expectedRepositoryIdentity:identityContract,packageBehaviorFields:manifest.packageBehaviorFields,symlinkPolicy:VERIFIER_CONTRACT.symlinkPolicy,hardLinkPolicy:VERIFIER_CONTRACT.hardLinkPolicy,unicodeCasePathPolicy:{normalization:'NFC',allowedPathCharacters:'ASCII printable except ambiguous segment forms',case:VERIFIER_CONTRACT.casePolicy},generatedOutputPolicy:'compared when inventoried; not reproducibly rebuilt',dependencyPolicy:'excluded installed dependencies represented by governed lock and package-manager configuration, not installed bytes',quarantinePolicy:'all listed quarantine remains blocking',credentialPathPolicy:{version:SECRET_PATH_POLICY_VERSION,rule:'credential-bearing paths are classified by path and never opened'},truthRelease:truth.identity,verifierCertification:certification.ok?certification.certification.certificationDigest:null};
    const topLevelContractDigest=framedEnvelope(contractFields);
    const repositoryIdentities=repositories.map((r)=>{const lockDigests=Object.fromEntries(['pnpm-lock.yaml','tui/pnpm-lock.yaml','scripts/trio/package-lock.json'].map((p)=>[p,fs.existsSync(path.join(r.root,p))?`sha256:${sha256(r.authority.read(path.join(r.root,p)))}`:null]));const snapshot={agent:r.slot,canonicalRealpath:r.root,expectedRepositoryName:manifest.repositories[r.slot].expectedRepositoryName,remoteIdentity:r.remote,packageIdentity:manifest.repositories[r.slot].packageNames,capsuleIdentity:manifest.repositories[r.slot].capsuleIdentity,head:r.head,branch:r.branch,dirty:r.dirty,dirtyStateVisible:r.dirty.length>0,digests:r.digests,lockDigests,packageProjectionDigest:packageBehaviorProjection[r.slot].digest,generatedOutputState:{digest:r.digests.compiledArtifactDigest,reproduciblyBuilt:false},knownQuarantineCount:r.governed.filter((x)=>x.classification==='quarantined-blocking-divergence').length};return {...snapshot,behavioralEnvelopeDigest:framedEnvelope({topLevelContractDigest,slot:r.slot,expectedIdentity:manifest.repositories[r.slot],snapshot:{head:r.head,branch:r.branch,dirty:r.dirty},treeDigests:r.digests,lockDigests,packageProjectionDigest:packageBehaviorProjection[r.slot].digest,generatedOutputState:snapshot.generatedOutputState})};});
    const blockingStateDigest=framedEnvelope({failures:[...failures].sort((a,b)=>stableJson(a).localeCompare(stableJson(b))),comparison:{divergent:compared.divergent,missing:compared.missing,quarantined:compared.quarantined,variableDifferences:compared.variableDifferences}});const observationEnvelopeDigest=framedEnvelope({topLevelContractDigest,repositorySnapshots:repositoryIdentities.map((x)=>({agent:x.agent,head:x.head,branch:x.branch,dirty:x.dirty,behavioralEnvelopeDigest:x.behavioralEnvelopeDigest,completeObservedTreeDigest:x.digests.completeObservedTreeDigest})),blockingStateDigest,status:failures.length?'VERIFIER_OK_DIVERGENCE':'VERIFIER_OK_PARITY'});
    const result={schemaVersion:'3.0.0',status:failures.length?'VERIFIER_OK_DIVERGENCE':'VERIFIER_OK_PARITY',generatedAt:new Date().toISOString(),validator:SCHEMA_VALIDATOR,identityLimitations:['Mutable Git remote/package/capsule metadata verifies labeling consistency, not cryptographic provenance.','Compiled artifacts are compared when inventoried but are not proven reproducible.','Excluded third-party dependency bytes are not individually attested; pinned lock and package-manager configuration are governed.','Identical code may still be unsafe.'],topLevelIdentity:{contractDigest:topLevelContractDigest,observationEnvelopeDigest,blockingStateDigest,contract:contractFields},boundaryManifest:{path:manifestReal,digest:manifestDigest,byteDigest:manifestByteDigest,schemaVersion:manifest.schemaVersion,pathInventoryDigest:inventoryDigest,pathInventoryByteDigest:inventoryByteDigest,inclusionRuleDigest:`sha256:${sha256(stableJson(manifest.rules))}`,exclusionRuleDigest:`sha256:${sha256(stableJson(manifest.exclusions))}`,completeRuleDigest,completeExclusionDigest},repositoryIdentities,packageBehaviorProjection,summary:{verdict:failures.length?'BLOCKING_DIVERGENCE':'PARITY',blockingCount:failures.length,blockingByClass,identical:compared.identical.length,behavioralDivergences:compared.divergent.length,missingBehaviorFiles:compared.missing.length,quarantined:compared.quarantined.length,variableDifferences:compared.variableDifferences.length,ownerScopedFiles:compared.ownerScoped.length,agentOwnedUiFiles:compared.agentOwnedUi.length,secretPathsExcluded:compared.secretExcluded.length,unclassifiedFiles:repositories.reduce((n,r)=>n+r.unknown.length,0),symlinks:repositories.reduce((n,r)=>n+r.symlinks.length,0),contentValidationFailures:repositories.reduce((n,r)=>n+r.contentInvalid.length,0)},intentionalBlockingDivergences:manifest.blockingDivergences,divergent:compared.divergent,missing:compared.missing,quarantined:compared.quarantined,variableDifferences:compared.variableDifferences,ownerScoped:compared.ownerScoped,agentOwnedUi:compared.agentOwnedUi,secretPathsExcluded:compared.secretExcluded,secretPathPolicy:{version:SECRET_PATH_POLICY_VERSION,contentsRead:false,result:'SECRET_PATH_EXCLUDED'},truthRelease:truth.identity,verifierCertification:certification.ok?certification.certification:{certified:false,problems:certification.problems},unclassified:repositories.flatMap((r)=>r.unknown),symlinks:repositories.flatMap((r)=>r.symlinks),contentValidationFailures:repositories.flatMap((r)=>r.contentInvalid),failures};return result;
  }catch(error){
    // Checked before the generic classes below so a refusal can never be reported as a
    // missing input or a parse problem, which is how it would get shrugged off.
    if(isSecurityBoundaryError(error))return invalidResult('VERIFIER_SECURITY_BLOCKED',[failure(error.code,'A repository-content read was refused by the verifier security boundary',null,error.relativePath,{category:error.category??'trapped-forbidden-read',contentsRead:false})]);
    const kind=error instanceof StrictJsonError?'JSON_INVALID':error?.code==='ENOENT'?'MISSING_INPUT':'VERIFIER_EXCEPTION';return invalidResult(kind,[failure(kind,error.message,null,manifestPath??null)]);}
}

/**
 * Apply the self-certification gate to a verdict before it leaves the verifier.
 *
 * PARITY is a claim about three repositories; certification is the claim the verifier has to
 * make about itself first, for exactly these implementation bytes and exactly this fixture
 * set. An uncertified release may still report what it observed -- the observations are
 * useful -- but it may not call the result parity.
 */
export function publishedResult(result){
  const certification=result?.verifierCertification;
  if(!certification||certification.certified!==false)return result;
  const failures=[...(result.failures??[]),...(certification.problems??[]).map((x)=>failure('VERIFIER_UNCERTIFIED',x.message,null,CERTIFICATION_CONTRACT.artifact,Object.fromEntries(Object.entries(x).filter(([k])=>k!=='message'))))];
  const blockingByClass={};for(const f of failures)blockingByClass[f.failureClass]=(blockingByClass[f.failureClass]??0)+1;
  return {...result,status:'VERIFIER_UNCERTIFIED',failures,summary:{...result.summary,verdict:'VERIFIER_UNCERTIFIED',blockingCount:failures.length,blockingByClass}};
}

export function human(result){const s=result.summary;const lines=[`TRIO verifier status: ${result.status}`,`verdict=${s.verdict} blocking=${s.blockingCount}`];if(s.behavioralDivergences!==undefined)lines.push(`behavior-divergent=${s.behavioralDivergences} missing=${s.missingBehaviorFiles} quarantined=${s.quarantined} variable-differences=${s.variableDifferences} unclassified=${s.unclassifiedFiles}`);for(const f of result.failures.slice(0,200))lines.push(`${f.failureClass}${f.agent?` agent=${f.agent}`:''}${f.affectedPath?` path=${safeText(f.affectedPath)}`:''}: ${safeText(f.message)}`);if(result.failures.length>200)lines.push(`... ${result.failures.length-200} additional failures omitted from human output; use --json`);return lines.join('\n');}
function parseArgs(argv){const out={slots:{}};for(let i=0;i<argv.length;i++){const a=argv[i];if(a==='--json')out.json=true;else if(a==='--manifest')out.manifestPath=argv[++i];else if(SLOT_NAMES.some((s)=>a===`--${s}`))out.slots[a.slice(2)]=argv[++i];else out.error=`Unknown argument: ${safeText(a)}`;}return out;}
const isMain=process.argv[1]!==undefined&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isMain){const args=parseArgs(process.argv.slice(2));let result;if(args.error)result=invalidResult('INVALID_INPUT',[failure('ARGUMENT_ERROR',args.error)]);else{const ownRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');result=verify({slots:args.slots,manifestPath:path.resolve(args.manifestPath??path.join(ownRoot,'trio/governance/boundary-manifest.json'))});}result=publishedResult(result);process.stdout.write((args.json?JSON.stringify(result,null,2):human(result))+'\n');process.exitCode=result.summary.verdict==='PARITY'?0:1;}
