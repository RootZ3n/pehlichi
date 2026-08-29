#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {createReadAuthority,scanSecretObjects} from './governed-reader.mjs';
import {parseStrictJsonText} from './strict-json.mjs';

const BUILTINS=new Map([
  ['node:fs',new Map([['readFileSync','filesystem.readFileSync'],['readFile','filesystem.readFile'],['readSync','filesystem.readSync'],['read','filesystem.read'],['readvSync','filesystem.readvSync'],['readv','filesystem.readv'],['openSync','filesystem.openSync'],['open','filesystem.open'],['createReadStream','filesystem.createReadStream']])],
  ['fs',new Map([['readFileSync','filesystem.readFileSync'],['readFile','filesystem.readFile'],['readSync','filesystem.readSync'],['read','filesystem.read'],['readvSync','filesystem.readvSync'],['readv','filesystem.readv'],['openSync','filesystem.openSync'],['open','filesystem.open'],['createReadStream','filesystem.createReadStream']])],
  ['node:fs/promises',new Map([['readFile','filesystem.promises.readFile'],['open','filesystem.promises.open']])],
  ['fs/promises',new Map([['readFile','filesystem.promises.readFile'],['open','filesystem.promises.open']])],
  ['node:child_process',new Map([['exec','process.exec'],['execSync','process.execSync'],['execFile','process.execFile'],['execFileSync','process.execFileSync'],['spawn','process.spawn'],['spawnSync','process.spawnSync'],['fork','process.fork']])],
  ['child_process',new Map([['exec','process.exec'],['execSync','process.execSync'],['execFile','process.execFile'],['execFileSync','process.execFileSync'],['spawn','process.spawn'],['spawnSync','process.spawnSync'],['fork','process.fork']])],
  ['node:util',new Map([['promisify','utility.promisify']])],
  ['util',new Map([['promisify','utility.promisify']])],
  ['node:vm',new Map([['runInThisContext','dynamic.vm'],['runInNewContext','dynamic.vm'],['runInContext','dynamic.vm'],['compileFunction','dynamic.vm'],['SourceTextModule','dynamic.vm']])],
  ['vm',new Map([['runInThisContext','dynamic.vm'],['runInNewContext','dynamic.vm'],['runInContext','dynamic.vm'],['compileFunction','dynamic.vm'],['SourceTextModule','dynamic.vm']])]
]);
const DYNAMIC_GLOBALS=new Map([['eval','dynamic.eval'],['Function','dynamic.function-constructor']]);
const CAP_PREFIX='cap:';
const FN_PREFIX='fn:';
const MOD_PREFIX='module:';
const EXP_PREFIX='export:';
const PARAM_PREFIX='param:';
const OBJ_PREFIX='object:';
const normalize=(value)=>value.replaceAll('\\','/');
const compact=(node,source)=>source.text.slice(node.pos,node.end).replace(/\s+/g,' ').trim();
const literal=(node)=>ts.isStringLiteralLike(node)||ts.isNoSubstitutionTemplateLiteral(node)?node.text:null;
const values=(...items)=>new Set(items.flatMap((item)=>[...(item??[])]));
const addAll=(target,source)=>{let changed=false;for(const item of source??[]){if(!target.has(item)){target.add(item);changed=true;}}return changed;};
const bindingKey=(file,name)=>`${file}#${name}`;

export class SemanticClosureError extends Error{
  constructor(problems){super(`semantic reader closure rejected ${problems.length} condition(s)`);this.name='SemanticClosureError';this.problems=problems;}
}

function bindingNames(name,out=[]){
  if(ts.isIdentifier(name))out.push(name.text);
  else for(const element of name.elements)if(ts.isBindingElement(element))bindingNames(element.name,out);
  return out;
}

function localTarget(file,specifier,root){
  if(!specifier.startsWith('.'))return null;
  const base=path.resolve(path.dirname(path.join(root,file)),specifier);
  const candidates=path.extname(base)?[base]:[`${base}.mjs`,`${base}.js`,path.join(base,'index.mjs'),path.join(base,'index.js')];
  return candidates.map((candidate)=>normalize(path.relative(root,candidate))).find((candidate)=>!candidate.startsWith('../'))??null;
}

function parseModule(file,text){
  const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const diagnostics=source.parseDiagnostics??[];
  if(diagnostics.length)throw new SemanticClosureError(diagnostics.map((d)=>({code:'SOURCE_PARSE_ERROR',module:file,message:ts.flattenDiagnosticMessageText(d.messageText,' ')})));
  return source;
}

export function analyzeSemanticClosure({root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),manifestPath=path.join(root,'scripts/trio/reader-capabilities.json')}={}){
  root=path.resolve(root);
  const authority=createReadAuthority({root,secretObjects:scanSecretObjects(root,{exclusions:[{path:'.git'},{path:'node_modules'},{path:'dist'}]})});
  const manifest=parseStrictJsonText(authority.readText(manifestPath));
  const problems=[];
  const aggregateText=authority.readText(path.join(root,manifest.aggregateGate.wrapper));
  for(const invocation of manifest.aggregateGate.requiredInvocations)if(!aggregateText.includes(invocation))problems.push({code:'AGGREGATE_GATE_MISSING',module:manifest.aggregateGate.wrapper,invocation});
  const modules=new Map();
  const pending=[...manifest.entryPoints];
  const external=new Set(manifest.externalModules??[]);
  while(pending.length){
    const file=normalize(pending.shift());
    if(modules.has(file))continue;
    if(file.startsWith('../')||path.isAbsolute(file)){problems.push({code:'MODULE_OUTSIDE_ROOT',module:file});continue;}
    let text;
    try{text=authority.readText(path.join(root,...file.split('/')));}catch(error){problems.push({code:'UNRESOLVED_LOCAL_IMPORT',module:file,message:error.code??error.message});continue;}
    const source=parseModule(file,text);modules.set(file,{file,text,source,imports:[],exports:new Map(),env:new Map(),functions:new Map(),objects:new Map()});
    const inspectImport=(specifier,node)=>{
      const target=localTarget(file,specifier,root);
      if(target){try{authority.authorize(path.join(root,...target.split('/')));pending.push(target);}catch(error){problems.push({code:'UNRESOLVED_LOCAL_IMPORT',module:file,target,message:error.code??error.message});}return target;}
      if(!BUILTINS.has(specifier)&&!external.has(specifier))problems.push({code:'UNDECLARED_EXTERNAL_MODULE',module:file,target:specifier});
      return specifier;
    };
    const walkImports=(node)=>{
      if(ts.isImportDeclaration(node)){const spec=literal(node.moduleSpecifier);if(spec===null)problems.push({code:'NONLITERAL_MODULE_TARGET',module:file});else modules.get(file).imports.push({node,target:inspectImport(spec,node),specifier:spec});}
      if(ts.isExportDeclaration(node)&&node.moduleSpecifier){const spec=literal(node.moduleSpecifier);if(spec===null)problems.push({code:'NONLITERAL_MODULE_TARGET',module:file});else modules.get(file).imports.push({node,target:inspectImport(spec,node),specifier:spec,reexport:true});}
      if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword){const spec=literal(node.arguments[0]);if(spec===null)problems.push({code:'NONLITERAL_DYNAMIC_IMPORT',module:file,site:source.getLineAndCharacterOfPosition(node.getStart()).line+1});else inspectImport(spec,node);}
      if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='require'){
        const spec=literal(node.arguments[0]);if(spec===null)problems.push({code:'NONLITERAL_REQUIRE',module:file,site:source.getLineAndCharacterOfPosition(node.getStart()).line+1});else inspectImport(spec,node);
      }
      ts.forEachChild(node,walkImports);
    };
    walkImports(source);
  }
  const observedModules=[...modules.keys()].sort();
  const declaredModules=[...manifest.modules].sort();
  for(const file of observedModules)if(!declaredModules.includes(file))problems.push({code:'NEW_REACHABLE_MODULE',module:file});
  for(const file of declaredModules)if(!modules.has(file))problems.push({code:'DECLARED_MODULE_ABSENT',module:file});
  const unwrap=(node)=>ts.isCallExpression(node)&&node.arguments.length?unwrap(node.arguments[0]):node;
  const objectProperty=(node,name)=>{node=unwrap(node);if(!node||!ts.isObjectLiteralExpression(node))return null;const property=node.properties.find((p)=>ts.isPropertyAssignment(p)&&('text'in p.name)&&String(p.name.text)===name);return property?unwrap(property.initializer):null;};
  const declaredSuiteFiles=(ctx,propertyNames)=>{
    const files=[];
    for(const statement of ctx.source.statements)if(ts.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations)if(ts.isIdentifier(declaration.name)&&declaration.name.text==='CERTIFICATION_CONTRACT')for(const propertyName of propertyNames){const array=objectProperty(declaration.initializer,propertyName);if(!array||!ts.isArrayLiteralExpression(array)){problems.push({code:'UNRESOLVED_BUNDLED_SUITE_SET',module:ctx.file,property:propertyName});continue;}for(const element of array.elements){const fileNode=objectProperty(element,'file');const file=literal(fileNode);if(file===null)problems.push({code:'RUNTIME_SELECTED_TEST_SUITE',module:ctx.file,property:propertyName});else files.push(file);}}
    return files.sort();
  };
  const releaseContext=modules.get('scripts/trio/release-certification.mjs');
  if(releaseContext){const actual=declaredSuiteFiles(releaseContext,['requiredSuites','auditSuites']);const expected=[...manifest.bundledTestSuites.certification].sort();if(JSON.stringify(actual)!==JSON.stringify(expected))problems.push({code:'BUNDLED_SUITE_SET_CHANGED',module:releaseContext.file,expected,actual});}

  const exportValues=new Map(),functionParams=new Map(),functionReturns=new Map();
  const memberValues=new Map();
  const valueOf=(ctx,node,env=ctx.env)=>{
    if(!node)return new Set();
    if(ts.isIdentifier(node))return values(env.get(node.text),DYNAMIC_GLOBALS.has(node.text)?[CAP_PREFIX+DYNAMIC_GLOBALS.get(node.text)]:[]);
    if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isTypeAssertionExpression(node)||ts.isNonNullExpression(node))return valueOf(ctx,node.expression,env);
    if(ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node)){
      const base=valueOf(ctx,node.expression,env);const name=ts.isPropertyAccessExpression(node)?node.name.text:literal(node.argumentExpression);
      const out=new Set();
      for(const item of base){
        if(item.startsWith(MOD_PREFIX)&&name){const moduleName=item.slice(MOD_PREFIX.length);const cap=BUILTINS.get(moduleName)?.get(name);if(cap)out.add(CAP_PREFIX+cap);else if(moduleName==='node:fs'&&name==='promises')out.add(MOD_PREFIX+'node:fs/promises');}
        if(item.startsWith(OBJ_PREFIX)&&name)addAll(out,memberValues.get(`${item}:${name}`));
      }
      if(name==='validateFile')out.add(CAP_PREFIX+'parser.validateFile');
      return out;
    }
    if(ts.isFunctionExpression(node)||ts.isArrowFunction(node)){const key=`${ctx.file}#anonymous@${node.getStart()}`;ctx.functions.set(key,node);return new Set([FN_PREFIX+key]);}
    if(ts.isObjectLiteralExpression(node)){const key=`${ctx.file}@${node.getStart()}`;for(const prop of node.properties){if(ts.isPropertyAssignment(prop)){const name=prop.name&&('text'in prop.name?String(prop.name.text):null);if(name)memberValues.set(`${OBJ_PREFIX}${key}:${name}`,valueOf(ctx,prop.initializer,env));}else if(ts.isShorthandPropertyAssignment(prop))memberValues.set(`${OBJ_PREFIX}${key}:${prop.name.text}`,valueOf(ctx,prop.name,env));}return new Set([OBJ_PREFIX+key]);}
    if(ts.isCallExpression(node)){
      const callee=valueOf(ctx,node.expression,env);const out=new Set();
      if([...callee].some((x)=>x===CAP_PREFIX+'utility.promisify'))for(const arg of node.arguments)addAll(out,valueOf(ctx,arg,env));
      for(const target of callee)if(target.startsWith(FN_PREFIX))addAll(out,functionReturns.get(target.slice(FN_PREFIX.length)));
      return out;
    }
    return new Set();
  };
  const assignBinding=(ctx,name,val,env=ctx.env)=>{
    if(ts.isIdentifier(name))addAll(env.get(name.text)??(env.set(name.text,new Set()),env.get(name.text)),val);
    else if(ts.isObjectBindingPattern(name))for(const element of name.elements){const prop=element.propertyName&&('text'in element.propertyName)?String(element.propertyName.text):element.name.text;const selected=new Set();for(const item of val){if(item.startsWith(MOD_PREFIX)){const cap=BUILTINS.get(item.slice(MOD_PREFIX.length))?.get(prop);if(cap)selected.add(CAP_PREFIX+cap);}if(item.startsWith(OBJ_PREFIX))addAll(selected,memberValues.get(`${item}:${prop}`));}assignBinding(ctx,element.name,selected,env);}
  };
  for(const ctx of modules.values()){
    for(const statement of ctx.source.statements){
      if(ts.isImportDeclaration(statement)&&statement.importClause){const spec=literal(statement.moduleSpecifier);const target=localTarget(ctx.file,spec,root)??spec;const clause=statement.importClause;
        if(clause.name)ctx.env.set(clause.name.text,new Set([target.startsWith('node:')||target==='fs'||target==='child_process'||target==='vm'?MOD_PREFIX+target:EXP_PREFIX+bindingKey(target,'default')]));
        if(clause.namedBindings&&ts.isNamespaceImport(clause.namedBindings))ctx.env.set(clause.namedBindings.name.text,new Set([BUILTINS.has(target)?MOD_PREFIX+target:EXP_PREFIX+bindingKey(target,'*')]));
        if(clause.namedBindings&&ts.isNamedImports(clause.namedBindings))for(const item of clause.namedBindings.elements){const original=item.propertyName?.text??item.name.text;const cap=BUILTINS.get(target)?.get(original)??(target==='scripts/trio/strict-json.mjs'&&original==='readStrictJson'?'parser.readStrictJson':null);ctx.env.set(item.name.text,new Set([cap?CAP_PREFIX+cap:EXP_PREFIX+bindingKey(target,original)]));}
      }
      if(ts.isFunctionDeclaration(statement)&&statement.name){const key=bindingKey(ctx.file,statement.name.text);ctx.functions.set(key,statement);ctx.env.set(statement.name.text,new Set([FN_PREFIX+key]));functionParams.set(key,statement.parameters.map(()=>new Set()));}
      if(ts.isVariableStatement(statement))for(const decl of statement.declarationList.declarations)for(const name of bindingNames(decl.name)){if(!ctx.env.has(name))ctx.env.set(name,new Set());if(ts.isIdentifier(decl.name)&&decl.initializer&&(ts.isArrowFunction(decl.initializer)||ts.isFunctionExpression(decl.initializer))){const key=bindingKey(ctx.file,name);ctx.functions.set(key,decl.initializer);ctx.env.get(name).add(FN_PREFIX+key);functionParams.set(key,decl.initializer.parameters.map(()=>new Set()));}}
    }
  }
  // Resolve exports, aliases, CommonJS bindings, and local imports to a fixed point.
  for(let round=0;round<20;round++){
    let changed=false;
    for(const ctx of modules.values()){
      const visitDecl=(node,env=ctx.env)=>{
        if(ts.isVariableDeclaration(node)&&node.initializer){let val;
          if(ts.isCallExpression(node.initializer)&&ts.isIdentifier(node.initializer.expression)&&node.initializer.expression.text==='require'){
            const spec=literal(node.initializer.arguments[0]);if(spec===null){problems.push({code:'NONLITERAL_REQUIRE',module:ctx.file,site:ctx.source.getLineAndCharacterOfPosition(node.getStart()).line+1});val=new Set();}
            else {const target=localTarget(ctx.file,spec,root)??spec;val=new Set([BUILTINS.has(target)?MOD_PREFIX+target:EXP_PREFIX+bindingKey(target,'default')]);}
          }else val=valueOf(ctx,node.initializer,env);
          const before=[...bindingNames(node.name)].map((name)=>env.get(name)?.size??0).reduce((a,b)=>a+b,0);assignBinding(ctx,node.name,val,env);const after=[...bindingNames(node.name)].map((name)=>env.get(name)?.size??0).reduce((a,b)=>a+b,0);if(after>before)changed=true;
        }
        if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isIdentifier(node.left)){const target=env.get(node.left.text)??new Set();if(addAll(target,valueOf(ctx,node.right,env))){env.set(node.left.text,target);changed=true;}}
        ts.forEachChild(node,(child)=>visitDecl(child,env));
      };
      visitDecl(ctx.source);
      for(const statement of ctx.source.statements){
        const exported=statement.modifiers?.some((m)=>m.kind===ts.SyntaxKind.ExportKeyword);
        if(exported&&(ts.isFunctionDeclaration(statement)||ts.isVariableStatement(statement))){const names=ts.isFunctionDeclaration(statement)&&statement.name?[statement.name.text]:statement.declarationList.declarations.flatMap((d)=>bindingNames(d.name));for(const name of names){const key=bindingKey(ctx.file,name),bucket=exportValues.get(key)??new Set();if(addAll(bucket,ctx.env.get(name)))changed=true;exportValues.set(key,bucket);}}
        if(ts.isExportAssignment(statement)){const key=bindingKey(ctx.file,'default'),bucket=exportValues.get(key)??new Set();if(addAll(bucket,valueOf(ctx,statement.expression)) )changed=true;exportValues.set(key,bucket);}
        if(ts.isExportDeclaration(statement)&&statement.exportClause&&ts.isNamedExports(statement.exportClause)){const spec=statement.moduleSpecifier&&literal(statement.moduleSpecifier);const target=spec&&(localTarget(ctx.file,spec,root)??spec);for(const item of statement.exportClause.elements){const original=item.propertyName?.text??item.name.text;let val;if(target){const cap=BUILTINS.get(target)?.get(original);val=new Set([cap?CAP_PREFIX+cap:EXP_PREFIX+bindingKey(target,original)]);}else val=ctx.env.get(original);const key=bindingKey(ctx.file,item.name.text),bucket=exportValues.get(key)??new Set();if(addAll(bucket,val))changed=true;exportValues.set(key,bucket);}}
      }
      for(const set of ctx.env.values())for(const item of [...set])if(item.startsWith(EXP_PREFIX)){const resolved=exportValues.get(item.slice(EXP_PREFIX.length));if(addAll(set,resolved))changed=true;}
    }
    for(const set of exportValues.values())for(const item of [...set])if(item.startsWith(EXP_PREFIX)&&addAll(set,exportValues.get(item.slice(EXP_PREFIX.length))))changed=true;
    if(!changed)break;
  }

  const observations=[];const seenObservation=new Set(),calledFunctions=new Set();
  const observe=(ctx,node,capability)=>{const pos=ctx.source.getLineAndCharacterOfPosition(node.getStart());const record={module:ctx.file,resolvedCapability:capability,importedOriginalBinding:capability,allowedOperation:capability.startsWith('process.')?'classified-process':capability.startsWith('filesystem.')?'descriptor-content-access':'forbidden-dynamic-content',constraints:{expression:compact(node,ctx.source),line:pos.line+1,column:pos.character+1}};const key=JSON.stringify(record);if(!seenObservation.has(key)){seenObservation.add(key);observations.push(record);}};
  const scanBody=(ctx,node,env,owner)=>{
    const visit=(child)=>{
      if(ts.isVariableDeclaration(child)&&child.initializer)assignBinding(ctx,child.name,valueOf(ctx,child.initializer,env),env);
      if(ts.isCallExpression(child)){
        if(child.expression.kind===ts.SyntaxKind.ImportKeyword){/* graph pass already handled it */}
        else {
          const targets=valueOf(ctx,child.expression,env);
          if(ts.isIdentifier(child.expression)&&child.expression.text==='require'){
            const spec=literal(child.arguments[0]);if(spec===null)observe(ctx,child,'dynamic.require');
          }
          for(const target of targets){
            if(target.startsWith(CAP_PREFIX))observe(ctx,child,target.slice(CAP_PREFIX.length));
            if(target.startsWith(PARAM_PREFIX)&&![...targets].some((x)=>x.startsWith(FN_PREFIX)))problems.push({code:'RUNTIME_SELECTED_CALL_TARGET',module:ctx.file,site:ctx.source.getLineAndCharacterOfPosition(child.getStart()).line+1,parameter:target.slice(PARAM_PREFIX.length)});
            if(target.startsWith(FN_PREFIX)){const key=target.slice(FN_PREFIX.length),params=functionParams.get(key);if(params){child.arguments.forEach((arg,index)=>addAll(params[index],valueOf(ctx,arg,env)));calledFunctions.add(key);}}
          }
          if([...targets].some((x)=>x===FN_PREFIX+bindingKey('scripts/trio/verify-runtime-parity.mjs','git'))){
            const args=child.arguments[1];const parts=args&&ts.isArrayLiteralExpression(args)?args.elements.map(literal):[];let signature=parts.every((x)=>x!==null)?parts.join(' '):null;
            if(args&&ts.isArrayLiteralExpression(args)&&parts[0]==='ls-files'&&parts[1]==='--'&&args.elements.length===3)signature='ls-files -- <governed-exclusion-path>';
            const allowed=['ls-files --', 'rev-parse HEAD','branch --show-current','remote get-url origin','status --porcelain=v1 --ignored=no'];
            if(signature===null||!allowed.some((x)=>signature===x||signature.startsWith(`${x} `)))problems.push({code:'UNCLASSIFIED_GIT_OPERATION',module:ctx.file,site:ctx.source.getLineAndCharacterOfPosition(child.getStart()).line+1,operation:signature});
          }
          if([...targets].some((x)=>x===FN_PREFIX+bindingKey('scripts/trio/write-evidence-bundle.mjs','run'))){const file=literal(child.arguments[0]);if(file===null||!manifest.bundledTestSuites.evidenceWriter.includes(file))problems.push({code:'UNCLASSIFIED_NODE_TEST',module:ctx.file,site:ctx.source.getLineAndCharacterOfPosition(child.getStart()).line+1,file});}
          if([...targets].some((x)=>x===FN_PREFIX+bindingKey('scripts/trio/release-certification.mjs','runSuite'))&&!['required.file','extra.file'].includes(compact(child.arguments[0],ctx.source)))problems.push({code:'RUNTIME_SELECTED_TEST_SUITE',module:ctx.file,site:ctx.source.getLineAndCharacterOfPosition(child.getStart()).line+1,source:compact(child.arguments[0],ctx.source)});
        }
      }
      if(ts.isNewExpression(child)){for(const target of valueOf(ctx,child.expression,env))if(target.startsWith(CAP_PREFIX))observe(ctx,child,target.slice(CAP_PREFIX.length));}
      if(ts.isReturnStatement(child)&&child.expression&&owner){const bucket=functionReturns.get(owner)??new Set();addAll(bucket,valueOf(ctx,child.expression,env));functionReturns.set(owner,bucket);}
      ts.forEachChild(child,visit);
    };visit(node);
  };
  for(let round=0;round<20;round++){
    const before=observations.length+problems.length+[...functionParams.values()].reduce((n,p)=>n+p.reduce((x,s)=>x+s.size,0),0);
    for(const ctx of modules.values()){
      scanBody(ctx,ctx.source,new Map(ctx.env),null);
      for(const [key,fn] of ctx.functions){const env=new Map(ctx.env);const params=functionParams.get(key)??fn.parameters.map(()=>new Set());fn.parameters.forEach((param,index)=>{const val=values(params[index],[PARAM_PREFIX+`${key}:${index}`]);assignBinding(ctx,param.name,val,env);});scanBody(ctx,fn.body??fn,env,key);}
    }
    const after=observations.length+problems.length+[...functionParams.values()].reduce((n,p)=>n+p.reduce((x,s)=>x+s.size,0),0);if(after===before)break;
  }
  const uniqueProblems=[];const problemKeys=new Set();for(const problem of problems){const key=JSON.stringify(problem);if(!problemKeys.has(key)){problemKeys.add(key);uniqueProblems.push(problem);}}
  observations.sort((a,b)=>a.module.localeCompare(b.module)||a.constraints.line-b.constraints.line||a.resolvedCapability.localeCompare(b.resolvedCapability));
  const expected=manifest.capabilities;
  if(!Array.isArray(expected))uniqueProblems.push({code:'CAPABILITY_MANIFEST_INVALID',message:'capabilities must be an array'});
  else for(const item of expected){
    if(typeof item.justification!=='string'||item.justification.length<12)uniqueProblems.push({code:'CAPABILITY_MANIFEST_INVALID',module:item.module,message:'capability justification is missing'});
    if(!Number.isSafeInteger(item.expectedCallSites)||item.expectedCallSites<1)uniqueProblems.push({code:'CAPABILITY_MANIFEST_INVALID',module:item.module,message:'expectedCallSites must be a positive integer'});
    const count=observations.filter((x)=>x.module===item.module&&x.resolvedCapability===item.resolvedCapability).length;
    if(count!==item.expectedCallSites)uniqueProblems.push({code:'CAPABILITY_CALL_COUNT_CHANGED',module:item.module,resolvedCapability:item.resolvedCapability,expected:item.expectedCallSites,actual:count});
  }
  const identity=(x)=>JSON.stringify({module:x.module,resolvedCapability:x.resolvedCapability,importedOriginalBinding:x.importedOriginalBinding,allowedOperation:x.allowedOperation,constraints:x.constraints});
  const observedKeys=new Map(observations.map((x)=>[identity(x),x])),expectedKeys=new Map(expected.map((x)=>[identity(x),x]));
  for(const [key,item] of observedKeys)if(!expectedKeys.has(key))uniqueProblems.push({code:'OBSERVED_CAPABILITY_UNDECLARED',observation:item});
  for(const [key,item] of expectedKeys)if(!observedKeys.has(key))uniqueProblems.push({code:'DECLARED_CAPABILITY_ABSENT',declaration:item});
  const result={ok:uniqueProblems.length===0,parser:{name:'typescript',version:ts.version,api:'createSourceFile'},entryPoints:manifest.entryPoints,modules:observedModules,capabilities:observations,problems:uniqueProblems};
  if(!result.ok)throw new SemanticClosureError(uniqueProblems);
  return result;
}

const isMain=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isMain){try{const result=analyzeSemanticClosure();process.stdout.write(JSON.stringify({status:'SEMANTIC_READER_CLOSURE_OK',...result},null,2)+'\n');}catch(error){const problems=error instanceof SemanticClosureError?error.problems:[{code:'ANALYZER_EXCEPTION',message:error.message}];process.stdout.write(JSON.stringify({status:'SEMANTIC_READER_CLOSURE_BLOCKED',ok:false,problems},null,2)+'\n');process.exitCode=1;}}
