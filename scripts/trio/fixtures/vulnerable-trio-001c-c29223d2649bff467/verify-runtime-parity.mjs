#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSchemaValidator,SCHEMA_VALIDATOR } from './schema-validation.mjs';
import { readStrictJson,StrictJsonError } from './strict-json.mjs';

export const SLOT_NAMES=Object.freeze(['pehlichi','loony-luna','mad-ptah']);
const MATCH_CLASSES=new Set(['behavior-identical','generated-behavior-identical','test-behavior-identical','quarantined-blocking-divergence']);
const VARIABLE_CLASSES=new Set(['validated-variable-data','inert-variable-asset','documentation']);
const EXECUTABLE_SUFFIXES=new Set(['.ts','.tsx','.js','.jsx','.mjs','.cjs','.py','.sh','.bash','.zsh','.fish','.rb','.pl','.php','.go','.rs','.java','.kt','.swift','.wasm','.node','.exe','.dll','.so','.dylib','.html','.htm','.service']);
const SAFE_EXCLUSION=/^(?:\.git|(?:[^/]+\/)*(?:node_modules|coverage|\.next))$/;
const sha256=(data)=>crypto.createHash('sha256').update(data).digest('hex');
const stable=(value)=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map((k)=>[k,stable(value[k])])):value;
const stableJson=(value)=>JSON.stringify(stable(value));
function canonicalManifest(value){const out=structuredClone(value);out.rules.sort((a,b)=>a.id.localeCompare(b.id));out.exclusions.sort((a,b)=>a.path.localeCompare(b.path));out.blockingDivergences.sort((a,b)=>a.path.localeCompare(b.path));out.packageBehaviorFields.sort();for(const rule of out.rules){if(rule.selector.paths)rule.selector.paths.sort();if(rule.selector.excludedPaths)rule.selector.excludedPaths.sort();if(rule.selector.excludedDirectories)rule.selector.excludedDirectories.sort();if(rule.selector.allowedSuffixes)rule.selector.allowedSuffixes.sort();rule.allowedTypes.sort();rule.permittedFormats.sort();}return out;}
const safeText=(value)=>String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g,(c)=>`\\u{${c.codePointAt(0).toString(16)}}`);

function failure(failureClass,message,agent=null,affectedPath=null,details={}){return {failureClass,message:safeText(message),agent,affectedPath:affectedPath===null?null:safeText(affectedPath),details};}
function invalidResult(status,failures,metadata={}){return {schemaVersion:'2.0.0',status,generatedAt:new Date().toISOString(),validator:SCHEMA_VALIDATOR,summary:{verdict:'VERIFIER_ERROR',blockingCount:failures.length},failures,...metadata};}

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

function selectorMatches(rel,selector){
  if(selector.paths)return selector.paths.includes(rel);
  const prefix=selector.directory+'/';if(!rel.startsWith(prefix))return false;
  if((selector.excludedPaths??[]).includes(rel))return false;
  if((selector.excludedDirectories??[]).some((d)=>rel===d||rel.startsWith(d+'/')))return false;
  if(selector.allowedSuffixes&&!selector.allowedSuffixes.some((s)=>rel.endsWith(s)))return false;
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
  const failures=[];const ids=new Set();const pathKeys=[];
  for(const exclusion of manifest.exclusions){for(const e of validateRelativePath(exclusion.path))failures.push(failure('PATH_AMBIGUITY',e,null,exclusion.path));if(!SAFE_EXCLUSION.test(exclusion.path))failures.push(failure('UNATTESTED_EXCLUSION','Only Git metadata, dependency trees, and named cache trees may be excluded',null,exclusion.path));pathKeys.push({value:exclusion.path,kind:'exclusion'});}
  for(const rule of manifest.rules){
    if(ids.has(rule.id))failures.push(failure('DUPLICATE_RULE','Duplicate classification rule ID',null,rule.id));ids.add(rule.id);
    const values=rule.selector.paths??[rule.selector.directory,...(rule.selector.excludedPaths??[]),...(rule.selector.excludedDirectories??[])];
    for(const p of values){for(const e of validateRelativePath(p))failures.push(failure('PATH_AMBIGUITY',e,null,p));pathKeys.push({value:p,kind:`rule:${rule.id}`});}
    const variable=VARIABLE_CLASSES.has(rule.class);if(variable&&rule.bytesMustMatch)failures.push(failure('RULE_CONTRACT','Variable class cannot claim byte identity',null,rule.id));
    if(MATCH_CLASSES.has(rule.class)&&!rule.bytesMustMatch&&rule.validation.kind!=='package-behavior')failures.push(failure('RULE_CONTRACT','Behavioral class must require byte identity unless governed by a semantic package projection',null,rule.id));
    if(rule.class==='quarantined-blocking-divergence'&&(!rule.divergenceBlocking||!rule.transitional||!rule.expiresBefore))failures.push(failure('RULE_CONTRACT','Quarantine must be blocking, transitional, and expiring',null,rule.id));
    if(variable&&rule.productionReachable)failures.push(failure('VARIABLE_BEHAVIOR','Variable content cannot be production-reachable',null,rule.id));
  }
  for(let i=0;i<manifest.rules.length;i++)for(let j=i+1;j<manifest.rules.length;j++)if(selectorsOverlap(manifest.rules[i].selector,manifest.rules[j].selector))failures.push(failure('AMBIGUOUS_RULES','Classification rule domains overlap',null,null,{rules:[manifest.rules[i].id,manifest.rules[j].id]}));
  const folded=new Map();for(const x of pathKeys){const key=x.value.normalize('NFC').toLowerCase();const prior=folded.get(key);if(prior&&prior.value!==x.value)failures.push(failure('CASE_CONFUSABLE_PATH','Case-fold-confusable manifest paths',null,x.value,{other:prior.value}));else folded.set(key,x);}
  return failures;
}

function git(root,args){return cp.execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
function normalizeRemote(raw){let s=raw.trim().replace(/\.git$/,'');s=s.replace(/^git@([^:]+):/,'$1/').replace(/^ssh:\/\/git@/,'').replace(/^https?:\/\//,'');return s;}
function executableContent(file,buffer,mode){const ext=path.posix.extname(file).toLowerCase();return Boolean(mode&0o111)||EXECUTABLE_SUFFIXES.has(ext)||buffer.subarray(0,128).toString('utf8').startsWith('#!');}
function png(buffer){return buffer.length>=8&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));}
function canonicalMode(stat){return (stat.mode&0o777).toString(8).padStart(3,'0');}

function walk(root,exclusions){
  const records=[];const collisions=new Map();
  function visit(dir,relDir=''){
    for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>Buffer.from(a.name).compare(Buffer.from(b.name)))){
      const rel=relDir?`${relDir}/${entry.name}`:entry.name;const pathErrors=validateRelativePath(rel);if(pathErrors.length){records.push({path:rel,kind:'invalid-path',pathErrors});continue;}
      const fold=rel.normalize('NFC').toLowerCase();if(collisions.has(fold)&&collisions.get(fold)!==rel)records.push({path:rel,kind:'case-collision',other:collisions.get(fold)});else collisions.set(fold,rel);
      const full=path.join(root,...rel.split('/'));const stat=fs.lstatSync(full);const excluded=exclusions.find((x)=>rel===x.path||rel.startsWith(x.path+'/'));
      if(stat.isSymbolicLink()){records.push({path:rel,kind:'symlink',mode:canonicalMode(stat),target:fs.readlinkSync(full),excluded:Boolean(excluded)});continue;}
      if(excluded){if(rel===excluded.path&&!stat.isDirectory())records.push({path:rel,kind:'invalid-exclusion-type',mode:canonicalMode(stat)});continue;}
      if(stat.isDirectory())visit(full,rel);else if(stat.isFile())records.push({path:rel,full,kind:'file',stat,mode:canonicalMode(stat)});else records.push({path:rel,kind:'special',mode:canonicalMode(stat)});
    }
  }
  visit(root);return records;
}

function packageProjection(value,fields){return Object.fromEntries(fields.filter((k)=>Object.hasOwn(value,k)).map((k)=>[k,value[k]]));}
function validatePackage(file,expectedName,fields){
  const value=readStrictJson(file);const errors=[];if(value.name!==expectedName)errors.push(`expected package name ${expectedName}`);
  const allowed=new Set(['name','description',...fields]);for(const key of Object.keys(value))if(!allowed.has(key))errors.push(`ungoverned package field ${key}`);
  const projection=packageProjection(value,fields);return {errors,projection,projectionDigest:sha256(stableJson(projection))};
}
function validateContent(record,rule,schemaValidator,slotSpec,manifest){
  const errors=[];if(record.kind!=='file')return errors;const buffer=fs.readFileSync(record.full);const exec=executableContent(record.path,buffer,record.stat.mode);
  if(VARIABLE_CLASSES.has(rule.class)&&exec)errors.push('variable data/asset/documentation is executable or behavior-bearing');
  const kind=rule.validation.kind;
  if(kind==='inert-image'&&!png(buffer))errors.push('inert asset failed PNG magic validation');
  if(kind==='documentation'){
    if(record.path.endsWith('.json')){try{readStrictJson(record.full);}catch(e){errors.push(`invalid documentation JSON: ${e.message}`);}}
    else if(!record.path.endsWith('.md'))errors.push('documentation format is not permitted');
  }
  if(kind==='strict-json-data'){try{readStrictJson(record.full);}catch(e){errors.push(`invalid strict JSON: ${e.message}`);}}
  const schemaKinds={"capsule-schema":'capsule',"deployment-schema":'deployment',"capability-pack-schema":'capabilityPack',"runtime-manifest-schema":'runtimeManifest',"boundary-schema":'boundary'};
  if(schemaKinds[kind]){const v=schemaValidator.validateFile(schemaKinds[kind],record.full);if(!v.ok)errors.push(...v.errors.map((e)=>`${e.keyword}: ${e.message}`));}
  const governedKind=record.path.startsWith('trio/capability-packs/')?'capabilityPack':record.path==='trio/runtime-manifest.characterization.json'?'runtimeManifest':record.path.startsWith('trio/deployment/')?'deployment':record.path==='trio/boundary-manifest.json'?'boundary':null;
  if(governedKind&&!schemaKinds[kind]){const v=schemaValidator.validateFile(governedKind,record.full);if(!v.ok)errors.push(...v.errors.map((e)=>`${e.keyword}: ${e.message}`));}
  return {errors,buffer,exec};
}
function framedDigest(records){const hash=crypto.createHash('sha256');for(const record of [...records].sort((a,b)=>Buffer.from(a.path).compare(Buffer.from(b.path)))){const bytes=Buffer.from(stableJson(record));const frame=Buffer.alloc(8);frame.writeBigUInt64BE(BigInt(bytes.length));hash.update(frame);hash.update(bytes);}return `sha256:${hash.digest('hex')}`;}
function publicRecord(record,rule,manifestVersion,content,packageInfo){return {path:record.path,classification:rule.class,fileType:record.kind,mode:record.mode,executable:Boolean(content?.exec),byteLength:content?.buffer?.length??null,byteDigest:content?.buffer?`sha256:${sha256(content.buffer)}`:null,behaviorDigest:packageInfo?`sha256:${packageInfo.projectionDigest}`:content?.buffer?`sha256:${sha256(content.buffer)}`:null,symlinkDisposition:record.kind==='symlink'?'rejected':'not-symlink',manifestVersion};}

function classifyRepository(slot,root,manifest,schemaValidator){
  const spec=manifest.repositories[slot];const failures=[];const rootReal=fs.realpathSync(root);const files=walk(rootReal,manifest.exclusions);const governed=[];const unknown=[];const symlinks=[];const contentInvalid=[];const packageProjections={};
  for(const file of files){
    if(file.kind==='invalid-path'){for(const e of file.pathErrors)failures.push(failure('PATH_AMBIGUITY',e,slot,file.path));continue;}
    if(file.kind==='case-collision'){failures.push(failure('CASE_CONFUSABLE_PATH','Repository contains case-fold-confusable paths',slot,file.path,{other:safeText(file.other)}));continue;}
    if(file.kind==='symlink'){symlinks.push({agent:slot,path:safeText(file.path),target:safeText(file.target),excluded:file.excluded});failures.push(failure('SYMLINK_REJECTED','In-scope or exclusion-boundary symlink rejected',slot,file.path));continue;}
    if(file.kind!=='file'){failures.push(failure('FILE_TYPE','Non-regular governed filesystem entry',slot,file.path));continue;}
    const matches=manifest.rules.filter((r)=>selectorMatches(file.path,r.selector));
    if(matches.length!==1){unknown.push({agent:slot,path:safeText(file.path),matches:matches.map((x)=>x.id).sort()});failures.push(failure(matches.length?'AMBIGUOUS_CLASSIFICATION':'UNCLASSIFIED_FILE',matches.length?'File matches multiple rules':'File is not in the closed inventory',slot,file.path,{rules:matches.map((x)=>x.id).sort()}));continue;}
    const rule=matches[0];let packageInfo=null;let content;
    try{
      content=validateContent(file,rule,schemaValidator,spec,manifest);
      if(rule.validation.kind==='package-behavior'){packageInfo=validatePackage(file.full,spec.packageNames[file.path],manifest.packageBehaviorFields);packageProjections[file.path]=packageInfo.projection;if(packageInfo.errors.length)content.errors.push(...packageInfo.errors);}
    }catch(error){content={errors:[error.message],buffer:fs.readFileSync(file.full),exec:executableContent(file.path,fs.readFileSync(file.full),file.stat.mode)};}
    if(content.errors.length){contentInvalid.push({agent:slot,path:file.path,errors:content.errors.map(safeText)});for(const e of content.errors)failures.push(failure('CONTENT_VALIDATION',e,slot,file.path));}
    governed.push({...publicRecord(file,rule,manifest.schemaVersion,content,packageInfo),ruleId:rule.id,bytesMustMatch:rule.bytesMustMatch,modeMustMatch:rule.modeMustMatch,divergenceBlocking:rule.divergenceBlocking,transitional:rule.transitional});
  }
  const byClass=(classes)=>governed.filter((x)=>classes.includes(x.classification));
  const digests={
    scaffoldingDigest:framedDigest(governed.filter((x)=>x.path.startsWith('trio/')||x.path.startsWith('scripts/trio/'))),
    sourceRuntimeDigest:framedDigest(governed.filter((x)=>x.path.startsWith('src/')||x.path.startsWith('tui/src/'))),
    behavioralTreeDigest:framedDigest(byClass(['behavior-identical','generated-behavior-identical','test-behavior-identical','quarantined-blocking-divergence'])),
    compiledArtifactDigest:framedDigest(byClass(['generated-behavior-identical']))
  };
  return {slot,root:rootReal,head:git(rootReal,['rev-parse','HEAD']),branch:git(rootReal,['branch','--show-current']),remote:normalizeRemote(git(rootReal,['remote','get-url','origin'])),dirty:git(rootReal,['status','--porcelain=v1','--ignored=no']).split('\n').filter(Boolean).map(safeText),governed,unknown,symlinks,contentInvalid,packageProjections,digests,failures};
}

function identityPreflight(slots,manifest,schemaValidator){
  const failures=[];const resolved={};const realpaths=new Map();
  for(const slot of SLOT_NAMES){
    const supplied=slots?.[slot];if(typeof supplied!=='string'||!supplied){failures.push(failure('MISSING_REPOSITORY','Required labeled repository slot was not supplied',slot));continue;}
    try{
      if(!fs.existsSync(supplied)||!fs.statSync(supplied).isDirectory())throw new Error('repository does not exist or is not a directory');
      fs.accessSync(supplied,fs.constants.R_OK);const real=fs.realpathSync(supplied);resolved[slot]=real;
      if(realpaths.has(real))failures.push(failure('DUPLICATE_REPOSITORY','Two labeled slots resolve to the same canonical repository',slot,null,{otherAgent:realpaths.get(real)}));else realpaths.set(real,slot);
      const spec=manifest.repositories[slot];if(path.basename(real)!==spec.expectedRepositoryName)failures.push(failure('REPOSITORY_NAME_MISMATCH','Canonical repository directory name does not match the labeled slot',slot));
      let remote;try{remote=normalizeRemote(git(real,['remote','get-url','origin']));}catch{throw new Error('Git origin remote is missing or unreadable');}if(remote!==spec.remoteIdentity)failures.push(failure('REMOTE_IDENTITY_MISMATCH','Git origin does not match the expected stable identity',slot,null,{expected:spec.remoteIdentity,actual:safeText(remote)}));
      for(const [packagePath,expected] of Object.entries(spec.packageNames)){try{const p=readStrictJson(path.join(real,packagePath));if(p.name!==expected)failures.push(failure('PACKAGE_IDENTITY_MISMATCH','Package identity does not match the labeled slot',slot,packagePath,{expected,actual:safeText(p.name)}));}catch(error){failures.push(failure('PACKAGE_IDENTITY_MISMATCH',error.message,slot,packagePath));}}
      const capsule=schemaValidator.validateFile('capsule',path.join(real,spec.capsulePath));if(!capsule.ok)failures.push(failure('CAPSULE_IDENTITY_MISMATCH','Expected capsule is missing or schema-invalid',slot,spec.capsulePath,{errors:capsule.errors}));else if(capsule.value.identity.id!==spec.capsuleIdentity)failures.push(failure('CAPSULE_IDENTITY_MISMATCH','Capsule identity does not match the labeled slot',slot,spec.capsulePath,{expected:spec.capsuleIdentity,actual:safeText(capsule.value.identity.id)}));
    }catch(error){failures.push(failure('MALFORMED_REPOSITORY',error.message,slot));}
  }
  return {resolved,failures};
}

function compare(repositories,manifest,manifestDigest){
  const failures=[];const maps=Object.fromEntries(repositories.map((r)=>[r.slot,new Map(r.governed.map((x)=>[x.path,x]))]));const allPaths=[...new Set(repositories.flatMap((r)=>r.governed.map((x)=>x.path)))].sort((a,b)=>Buffer.from(a).compare(Buffer.from(b)));
  const identical=[],divergent=[],missing=[],variableDifferences=[],quarantined=[];
  for(const rel of allPaths){const rows=SLOT_NAMES.map((s)=>maps[s].get(rel));const classes=new Set(rows.filter(Boolean).map((x)=>x.classification));if(classes.size>1){failures.push(failure('CLASSIFICATION_MISMATCH','Corresponding path has different classifications',null,rel,{classes:[...classes].sort()}));continue;}const klass=[...classes][0];const present=rows.filter(Boolean);
    if(MATCH_CLASSES.has(klass)){
      if(present.length!==SLOT_NAMES.length){const item={path:rel,class:klass,missingIn:SLOT_NAMES.filter((_,i)=>!rows[i])};missing.push(item);failures.push(failure('MISSING_BEHAVIOR_FILE','Behavior-bearing file is missing from one or more repositories',null,rel,{missingIn:item.missingIn}));continue;}
      const values=rows.map((x)=>`${x.fileType}:${x.mode}:${x.behaviorDigest}`);if(new Set(values).size!==1){divergent.push({path:rel,class:klass,records:Object.fromEntries(SLOT_NAMES.map((s,i)=>[s,{mode:rows[i].mode,byteDigest:rows[i].byteDigest,behaviorDigest:rows[i].behaviorDigest}]))});failures.push(failure('BEHAVIOR_DIVERGENCE','Behavioral canonical record differs',null,rel,{class:klass}));}else identical.push({path:rel,class:klass,digest:rows[0].behaviorDigest,mode:rows[0].mode});
      if(klass==='quarantined-blocking-divergence'){quarantined.push({path:rel,status:present.length===3&&new Set(values).size===1?'identical-but-quarantined':'divergent-or-missing'});failures.push(failure('QUARANTINED_DIVERGENCE','Transitional behavior-bearing path remains quarantined',null,rel));}
    }else if(VARIABLE_CLASSES.has(klass)){
      const values=rows.map((x)=>x?`${x.fileType}:${x.mode}:${x.byteDigest}`:'missing');if(new Set(values).size>1)variableDifferences.push({path:rel,class:klass,records:Object.fromEntries(SLOT_NAMES.map((s,i)=>[s,rows[i]?{mode:rows[i].mode,digest:rows[i].byteDigest}:null]))});
    }
  }
  const blockingByClass={};for(const f of failures)blockingByClass[f.failureClass]=(blockingByClass[f.failureClass]??0)+1;
  return {identical,divergent,missing,variableDifferences,quarantined,failures,blockingByClass};
}

export function verify({slots,manifestPath}){
  try{
    if(!manifestPath)return invalidResult('INVALID_INPUT',[failure('MISSING_MANIFEST','A boundary manifest path is required')]);
    const manifestReal=fs.realpathSync(manifestPath);const schemaDir=path.join(path.dirname(manifestReal),'schemas');const schemaValidator=createSchemaValidator(schemaDir);const manifestValidation=schemaValidator.validateFile('boundary',manifestReal);
    if(!manifestValidation.ok)return invalidResult('SCHEMA_INVALID',manifestValidation.errors.map((e)=>failure('SCHEMA_VALIDATION',`${e.keyword}: ${e.message}`,null,manifestReal,e.params)));
    const manifest=manifestValidation.value;const contractFailures=validateManifestContract(manifest);if(contractFailures.length)return invalidResult('MANIFEST_INVALID',contractFailures,{boundaryManifestDigest:`sha256:${sha256(fs.readFileSync(manifestReal))}`});
    const identities=identityPreflight(slots,manifest,schemaValidator);if(identities.failures.length)return invalidResult('IDENTITY_INVALID',identities.failures,{repositoryInputs:Object.fromEntries(SLOT_NAMES.map((s)=>[s,slots?.[s]??null]))});
    const manifestDigest=`sha256:${sha256(stableJson(canonicalManifest(manifest)))}`;const manifestByteDigest=`sha256:${sha256(fs.readFileSync(manifestReal))}`;const manifestFailures=[];
    for(const slot of SLOT_NAMES){const local=path.join(identities.resolved[slot],'trio/boundary-manifest.json');try{const localValidation=schemaValidator.validateFile('boundary',local);if(!localValidation.ok){manifestFailures.push(failure('MANIFEST_DIVERGENCE','Repository-local boundary manifest is invalid',slot,'trio/boundary-manifest.json',{errors:localValidation.errors}));continue;}const localContract=validateManifestContract(localValidation.value);if(localContract.length){manifestFailures.push(failure('MANIFEST_DIVERGENCE','Repository-local boundary manifest violates the classification contract',slot,'trio/boundary-manifest.json',{errors:localContract}));continue;}const digest=`sha256:${sha256(stableJson(canonicalManifest(localValidation.value)))}`;if(digest!==manifestDigest)manifestFailures.push(failure('MANIFEST_DIVERGENCE','Repository-local boundary manifest differs semantically from the governing manifest',slot,'trio/boundary-manifest.json',{expected:manifestDigest,actual:digest}));}catch(error){manifestFailures.push(failure('MANIFEST_DIVERGENCE',error.message,slot,'trio/boundary-manifest.json'));}}
    if(manifestFailures.length)return invalidResult('MANIFEST_DIVERGENCE',manifestFailures,{boundaryManifestDigest:manifestDigest});
    const repositories=SLOT_NAMES.map((slot)=>classifyRepository(slot,identities.resolved[slot],manifest,schemaValidator));const repoFailures=repositories.flatMap((r)=>r.failures);const compared=compare(repositories,manifest,manifestDigest);const failures=[...repoFailures,...compared.failures];const blockingByClass={};for(const f of failures)blockingByClass[f.failureClass]=(blockingByClass[f.failureClass]??0)+1;
    const packageBehaviorProjection=Object.fromEntries(repositories.map((r)=>[r.slot,{projection:r.packageProjections,digest:`sha256:${sha256(stableJson(r.packageProjections))}`} ]));
    const result={schemaVersion:'2.0.0',status:failures.length?'VERIFIER_OK_DIVERGENCE':'VERIFIER_OK_PARITY',generatedAt:new Date().toISOString(),validator:SCHEMA_VALIDATOR,boundaryManifest:{path:manifestReal,digest:manifestDigest,schemaVersion:manifest.schemaVersion,inclusionRuleDigest:`sha256:${sha256(stableJson(manifest.rules))}`,exclusionRuleDigest:`sha256:${sha256(stableJson(manifest.exclusions))}`},repositoryIdentities:repositories.map((r)=>({agent:r.slot,canonicalRealpath:r.root,expectedRepositoryName:manifest.repositories[r.slot].expectedRepositoryName,remoteIdentity:r.remote,packageIdentity:manifest.repositories[r.slot].packageNames,capsuleIdentity:manifest.repositories[r.slot].capsuleIdentity,head:r.head,branch:r.branch,dirty:r.dirty,dirtyStateVisible:r.dirty.length>0,digests:r.digests,lockDigests:Object.fromEntries(['pnpm-lock.yaml','tui/pnpm-lock.yaml','scripts/trio/package-lock.json'].map((p)=>[p,fs.existsSync(path.join(r.root,p))?`sha256:${sha256(fs.readFileSync(path.join(r.root,p)))}`:null]))})),packageBehaviorProjection,summary:{verdict:failures.length?'BLOCKING_DIVERGENCE':'PARITY',blockingCount:failures.length,blockingByClass,identical:compared.identical.length,behavioralDivergences:compared.divergent.length,missingBehaviorFiles:compared.missing.length,quarantined:compared.quarantined.length,variableDifferences:compared.variableDifferences.length,unclassifiedFiles:repositories.reduce((n,r)=>n+r.unknown.length,0),symlinks:repositories.reduce((n,r)=>n+r.symlinks.length,0),contentValidationFailures:repositories.reduce((n,r)=>n+r.contentInvalid.length,0)},intentionalBlockingDivergences:manifest.blockingDivergences,divergent:compared.divergent,missing:compared.missing,quarantined:compared.quarantined,variableDifferences:compared.variableDifferences,unclassified:repositories.flatMap((r)=>r.unknown),symlinks:repositories.flatMap((r)=>r.symlinks),contentValidationFailures:repositories.flatMap((r)=>r.contentInvalid),failures};return result;
  }catch(error){const kind=error instanceof StrictJsonError?'JSON_INVALID':error?.code==='ENOENT'?'MISSING_INPUT':'VERIFIER_EXCEPTION';return invalidResult(kind,[failure(kind,error.message,null,manifestPath??null)]);}
}

export function human(result){const s=result.summary;const lines=[`TRIO verifier status: ${result.status}`,`verdict=${s.verdict} blocking=${s.blockingCount}`];if(s.behavioralDivergences!==undefined)lines.push(`behavior-divergent=${s.behavioralDivergences} missing=${s.missingBehaviorFiles} quarantined=${s.quarantined} variable-differences=${s.variableDifferences} unclassified=${s.unclassifiedFiles}`);for(const f of result.failures.slice(0,200))lines.push(`${f.failureClass}${f.agent?` agent=${f.agent}`:''}${f.affectedPath?` path=${safeText(f.affectedPath)}`:''}: ${safeText(f.message)}`);if(result.failures.length>200)lines.push(`... ${result.failures.length-200} additional failures omitted from human output; use --json`);return lines.join('\n');}
function parseArgs(argv){const out={slots:{}};for(let i=0;i<argv.length;i++){const a=argv[i];if(a==='--json')out.json=true;else if(a==='--manifest')out.manifestPath=argv[++i];else if(SLOT_NAMES.some((s)=>a===`--${s}`))out.slots[a.slice(2)]=argv[++i];else out.error=`Unknown argument: ${safeText(a)}`;}return out;}
const isMain=process.argv[1]!==undefined&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isMain){const args=parseArgs(process.argv.slice(2));let result;if(args.error)result=invalidResult('INVALID_INPUT',[failure('ARGUMENT_ERROR',args.error)]);else{const ownRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');result=verify({slots:args.slots,manifestPath:path.resolve(args.manifestPath??path.join(ownRoot,'trio/boundary-manifest.json'))});}process.stdout.write((args.json?JSON.stringify(result,null,2):human(result))+'\n');process.exitCode=result.summary.verdict==='PARITY'?0:1;}
