import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createReadAuthority,scanSecretObjects,isSecurityBoundaryError} from './governed-reader.mjs';
import {readStrictJson} from './strict-json.mjs';
import {createSchemaValidator} from './schema-validation.mjs';

const roots=[];const make=()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'reader-mediation-'));roots.push(root);return root;};
test.afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
const write=(file,text)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);};
const authority=(root,hooks={})=>createReadAuthority({root,secretObjects:scanSecretObjects(root),hooks});

test('metadata-to-open replacement reads zero bytes and is security blocked',()=>{
  const root=make(),target=path.join(root,'safe.json'),secret=path.join(root,'.env'),held=path.join(root,'held');write(target,'{"safe":true}');write(secret,'dummy-sentinel');
  let reads=0,openedFd;const a=authority(root,{afterMetadata(){fs.renameSync(target,held);fs.linkSync(secret,target);},afterOpen(_file,fd){openedFd=fd;},beforeRead(){reads++;}});
  assert.throws(()=>a.read(target),(e)=>isSecurityBoundaryError(e)&&e.code==='FILESYSTEM_IDENTITY_CHANGED');assert.equal(reads,0);assert.throws(()=>fs.fstatSync(openedFd),(e)=>e.code==='EBADF');
});

test('replacement after descriptor acquisition cannot change the object read',()=>{
  const root=make(),target=path.join(root,'safe.txt'),secret=path.join(root,'.env'),held=path.join(root,'held');write(target,'safe-bytes');write(secret,'dummy-sentinel');
  let openedFd;const a=authority(root,{afterOpen(_file,fd){openedFd=fd;fs.renameSync(target,held);fs.linkSync(secret,target);}});
  assert.equal(a.readText(target),'safe-bytes');assert.throws(()=>fs.fstatSync(openedFd),(e)=>e.code==='EBADF');
});

test('symlink substitution between metadata and open is security blocked with zero reads',()=>{
  const root=make(),target=path.join(root,'safe.txt'),secret=path.join(root,'.env'),held=path.join(root,'held');write(target,'safe');write(secret,'dummy-sentinel');let reads=0;
  const a=authority(root,{afterMetadata(){fs.renameSync(target,held);fs.symlinkSync(secret,target);},beforeRead(){reads++;}});
  assert.throws(()=>a.read(target),(e)=>isSecurityBoundaryError(e));assert.equal(reads,0);
});

test('a remembered credential object remains refused after its canonical path is removed',()=>{
  const root=make(),secret=path.join(root,'.env'),alias=path.join(root,'alias.txt');write(secret,'dummy-sentinel');fs.linkSync(secret,alias);const a=authority(root);fs.unlinkSync(secret);
  assert.throws(()=>a.read(alias),(e)=>isSecurityBoundaryError(e)&&e.code==='SECRET_READ_REFUSED');
});

test('a legitimate non-secret hard link is read from its verified descriptor',()=>{
  const root=make(),source=path.join(root,'source.txt'),alias=path.join(root,'alias.txt');write(source,'ordinary');fs.linkSync(source,alias);assert.equal(authority(root).readText(alias),'ordinary');
});

test('path-opening parser and validator APIs refuse repository content',()=>{
  const root=make(),file=path.join(root,'input.json');write(file,'{}');
  assert.throws(()=>readStrictJson(file),(e)=>e.code==='UNAUTHORIZED_PARSER_ACCESS');
  const schemas=path.join(root,'schemas');fs.mkdirSync(schemas);const bundled=path.resolve(path.dirname(new URL(import.meta.url).pathname),'../../trio/governance/schemas');
  for(const name of fs.readdirSync(bundled))fs.copyFileSync(path.join(bundled,name),path.join(schemas,name));
  assert.throws(()=>createSchemaValidator(schemas),(e)=>e.code==='UNAUTHORIZED_PARSER_ACCESS');
  const validator=createSchemaValidator(schemas,{readText:(schema)=>fs.readFileSync(schema,'utf8')});assert.throws(()=>validator.validateFile('boundary',file),(e)=>e.code==='UNAUTHORIZED_PARSER_ACCESS');
});
