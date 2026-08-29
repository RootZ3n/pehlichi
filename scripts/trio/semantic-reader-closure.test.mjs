import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {analyzeSemanticClosure,SemanticClosureError} from './semantic-reader-closure.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const liveRoot=path.resolve(here,'../..');
const manifest=JSON.parse(fs.readFileSync(path.join(here,'reader-capabilities.json'),'utf8'));
const tempRoot=fs.mkdtempSync(path.join(os.tmpdir(),'semantic-reader-closure-'));
const fixtures=[];
test.after(()=>fs.rmSync(tempRoot,{recursive:true,force:true}));

function copyFixture(name){
  const root=path.join(tempRoot,name);fixtures.push(root);
  for(const rel of [...manifest.modules,'scripts/trio/reader-capabilities.json','scripts/trio/verify-local.sh']){
    const dest=path.join(root,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(liveRoot,rel),dest);
  }
  return root;
}
function append(root,rel,text){fs.appendFileSync(path.join(root,rel),`\n${text}\n`);}
function reject(name,mutate,expected){
  test(name,()=>{const root=copyFixture(name.replaceAll(/[^a-z0-9]+/gi,'-'));mutate(root);assert.throws(()=>analyzeSemanticClosure({root}),error=>error instanceof SemanticClosureError&&(!expected||error.problems.some((p)=>p.code===expected)),expected??'semantic rejection');});
}
function accept(name,mutate=()=>{}){
  test(name,()=>{const root=copyFixture(name.replaceAll(/[^a-z0-9]+/gi,'-'));mutate(root);assert.equal(analyzeSemanticClosure({root}).ok,true);});
}

reject('aliased named readFileSync import',root=>append(root,'scripts/trio/verify-runtime-parity.mjs',"import {readFileSync as concealedRepositoryRead} from 'node:fs'; concealedRepositoryRead('/repository/content');"),'OBSERVED_CAPABILITY_UNDECLARED');
reject('namespace fs read',root=>append(root,'scripts/trio/verify-runtime-parity.mjs',"import * as hiddenFs from 'node:fs'; hiddenFs.readFileSync('/repository/content');"),'OBSERVED_CAPABILITY_UNDECLARED');
reject('CommonJS destructured read',root=>append(root,'scripts/trio/verify-runtime-parity.mjs',"const {readFileSync: commonRead}=require('node:fs'); commonRead('/repository/content');"),'OBSERVED_CAPABILITY_UNDECLARED');
reject('two-step local alias',root=>append(root,'scripts/trio/verify-runtime-parity.mjs',"import {readFileSync as originalRead} from 'node:fs'; const aliasOne=originalRead; const aliasTwo=aliasOne; aliasTwo('/repository/content');"),'OBSERVED_CAPABILITY_UNDECLARED');
reject('re-exported reader imported elsewhere',root=>{append(root,'scripts/trio/reexport-reader.mjs',"export {readFileSync as exportedRead} from 'node:fs';");append(root,'scripts/trio/verify-runtime-parity.mjs',"import {exportedRead} from './reexport-reader.mjs'; exportedRead('/repository/content');");},'NEW_REACHABLE_MODULE');
reject('reader passed as callback',root=>append(root,'scripts/trio/verify-runtime-parity.mjs',"import {readFileSync as callbackRead} from 'node:fs'; function invokeReader(callback){return callback('/repository/content');} invokeReader(callbackRead);"),'OBSERVED_CAPABILITY_UNDECLARED');
reject('parser passed as callback with repository path',root=>append(root,'scripts/trio/verify-runtime-parity.mjs',"import {readStrictJson as pathParser} from './strict-json.mjs'; function invokeParser(repositoryPath,parser){return parser(repositoryPath);} invokeParser('/repository/content',pathParser);"),'OBSERVED_CAPABILITY_UNDECLARED');
reject('validateFile under an alias',root=>append(root,'scripts/trio/verify-runtime-parity.mjs',"const hiddenValidator={validateFile(){}}; const aliasedValidate=hiddenValidator.validateFile; aliasedValidate('boundary','/repository/content');"),'OBSERVED_CAPABILITY_UNDECLARED');
reject('path-based hash wrapper',root=>append(root,'scripts/trio/verify-runtime-parity.mjs',"import {readFileSync as hashPathRead} from 'node:fs'; function hashPath(repositoryPath){return hashPathRead(repositoryPath);} hashPath('/repository/content');"),'OBSERVED_CAPABILITY_UNDECLARED');
reject('promisified fs.readFile',root=>append(root,'scripts/trio/verify-runtime-parity.mjs',"import {readFile as asyncRead} from 'node:fs'; import {promisify} from 'node:util'; const promisedRead=promisify(asyncRead); promisedRead('/repository/content');"),'OBSERVED_CAPABILITY_UNDECLARED');
reject('aliased execFileSync reading repository file',root=>append(root,'scripts/trio/verify-runtime-parity.mjs',"import {execFileSync as concealedExec} from 'node:child_process'; concealedExec('cat',['/repository/content']);"),'OBSERVED_CAPABILITY_UNDECLARED');
reject('spawn of cat',root=>append(root,'scripts/trio/verify-runtime-parity.mjs',"import {spawnSync as spawnReader} from 'node:child_process'; spawnReader('cat',['/repository/content']);"),'OBSERVED_CAPABILITY_UNDECLARED');
reject('shell redirection reading repository file',root=>append(root,'scripts/trio/verify-runtime-parity.mjs',"import {execSync as shellReader} from 'node:child_process'; shellReader('cat < /repository/content',{shell:true});"),'OBSERVED_CAPABILITY_UNDECLARED');
reject('git show used for content extraction',root=>append(root,'scripts/trio/verify-runtime-parity.mjs',"git('/repository',['show','HEAD:package.json']);"),'UNCLASSIFIED_GIT_OPERATION');
reject('git cat-file used for content extraction',root=>append(root,'scripts/trio/verify-runtime-parity.mjs',"git('/repository',['cat-file','blob','HEAD:package.json']);"),'UNCLASSIFIED_GIT_OPERATION');
reject('Node test wrapper receives an arbitrary repository file',root=>append(root,'scripts/trio/write-evidence-bundle.mjs',"run('../../repository/arbitrary.mjs');"),'UNCLASSIFIED_NODE_TEST');
reject('aliased child-process wrapper',root=>append(root,'scripts/trio/verify-runtime-parity.mjs',"import {execFileSync as wrappedExec} from 'node:child_process'; function invokeTool(tool){return tool('cat',['/repository/content']);} invokeTool(wrappedExec);"),'OBSERVED_CAPABILITY_UNDECLARED');
reject('nonliteral dynamic import',root=>append(root,'scripts/trio/verify-runtime-parity.mjs',"const selectedModule=process.argv[2]; import(selectedModule);"),'NONLITERAL_DYNAMIC_IMPORT');
reject('unresolved local import',root=>append(root,'scripts/trio/verify-runtime-parity.mjs',"import './module-that-does-not-exist.mjs';"),'UNRESOLVED_LOCAL_IMPORT');
reject('new module added to verdict closure',root=>{append(root,'scripts/trio/new-reachable.mjs','export const harmless=true;');append(root,'scripts/trio/verify-runtime-parity.mjs',"import './new-reachable.mjs';");},'NEW_REACHABLE_MODULE');
reject('disabled analyzer invocation',root=>{const file=path.join(root,'scripts/trio/verify-local.sh');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('run_check semantic-reader-closure node "$script_dir/semantic-reader-closure.mjs"',''));},'AGGREGATE_GATE_MISSING');
reject('removed analyzer mutation-suite invocation',root=>{const file=path.join(root,'scripts/trio/verify-local.sh');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('run_check semantic-reader-mutations node "$script_dir/semantic-reader-closure.test.mjs"',''));},'AGGREGATE_GATE_MISSING');
reject('altered manifest hiding an observed capability',root=>{const file=path.join(root,'scripts/trio/reader-capabilities.json');const value=JSON.parse(fs.readFileSync(file,'utf8'));value.capabilities=value.capabilities.filter((x)=>x.resolvedCapability!=='filesystem.readFileSync');fs.writeFileSync(file,JSON.stringify(value));},'OBSERVED_CAPABILITY_UNDECLARED');
reject('removal of a declared descriptor reader',root=>{const file=path.join(root,'scripts/trio/governed-reader.mjs');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('return fs.readFileSync(fd,encoding);','return Buffer.alloc(0);'));},'DECLARED_CAPABILITY_ABSENT');

test('aggregate wrapper executes the semantic gate and propagates its failure',()=>{
  const root=copyFixture('aggregate-execution');const bin=path.join(root,'fake-bin'),log=path.join(root,'node.log');fs.mkdirSync(bin);
  const fake=path.join(bin,'node');fs.writeFileSync(fake,`#!/bin/sh\nprintf '%s\\n' "$*" >> "$SEMANTIC_GATE_LOG"\ncase "$*" in\n  *semantic-reader-closure.mjs*) exit 7 ;;\n  *verify-runtime-parity.mjs*) printf '%s\\n' '{"status":"VERIFIER_OK_PARITY","summary":{"verdict":"PARITY"}}'; exit 0 ;;\n  *) exit 0 ;;\nesac\n`);fs.chmodSync(fake,0o755);fs.mkdirSync(path.join(root,'scripts/trio/node_modules/ajv'),{recursive:true});
  const result=spawnSync('/bin/sh',[path.join(root,'scripts/trio/verify-local.sh'),root,root,root],{encoding:'utf8',env:{PATH:`${bin}:/usr/bin:/bin`,SEMANTIC_GATE_LOG:log,TMPDIR:root}});
  assert.equal(result.status,1);const calls=fs.readFileSync(log,'utf8');assert.match(calls,/semantic-reader-closure\.mjs/);assert.match(result.stdout,/TRIO_CHECK_END semantic-reader-closure status=7/);
});

accept('governed-reader descriptor sequence is the only raw filesystem content access');
accept('authorized byte parser is permitted',root=>append(root,'scripts/trio/verify-runtime-parity.mjs',"import {parseStrictJsonText as semanticTextParser} from './strict-json.mjs'; semanticTextParser('{}');"));
accept('enumerated Git metadata operations are permitted');
accept('bundled Node test execution is permitted');
accept('identity-neutral UI and agent-owned constants are permitted',root=>append(root,'scripts/trio/agent-owned-ui.mjs',"export const semanticControl={ui:'identity-owned',content:'non-secret'};"));
