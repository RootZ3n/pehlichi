#!/usr/bin/env node
// Manual characterization utility. This is never called by the verifier or a production path.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readStrictJson} from './strict-json.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const ownRoot=path.resolve(here,'../..');
const roots=process.argv.slice(2);
if(roots.length!==3)throw new Error('usage: build-closed-inventory.mjs <pehlichi> <loony-luna> <mad-ptah>');
const manifestPath=path.join(ownRoot,'trio/governance/boundary-manifest.json');
const manifest=structuredClone(readStrictJson(manifestPath));
manifest.pathInventory={path:'path-inventory.json',schemaVersion:'1.0.0'};
manifest.exclusions=manifest.exclusions.filter((x)=>x.path!=='.next'&&x.path!=='coverage');
for(const rule of manifest.rules){
  if(rule.selector.directory)rule.selector.closedInventory=true;
  if(rule.id==='documentation-tree'||rule.id==='root-documentation'){
    rule.class='model-behavior-data';rule.bytesMustMatch=true;rule.divergenceBlocking=true;rule.validation={kind:'model-data'};
  }
  if(rule.id==='inert-root-images'){
    rule.class='quarantined-blocking-divergence';rule.bytesMustMatch=true;rule.divergenceBlocking=true;rule.transitional=true;rule.expiresBefore='independently audited asset trust contract';rule.validation={kind:'inert-image'};
  }
}
const scriptsRule=manifest.rules.find((x)=>x.id==='trio-verification-code');
scriptsRule.selector.excludedDirectories=[...new Set([...(scriptsRule.selector.excludedDirectories??[]),'scripts/trio/fixtures'])];
if(!manifest.rules.some((x)=>x.id==='retained-vulnerable-fixture'))manifest.rules.push({id:'retained-vulnerable-fixture',selector:{directory:'scripts/trio/fixtures',closedInventory:true},class:'test-behavior-identical',bytesMustMatch:true,modeMustMatch:true,allowedTypes:['file'],permittedFormats:['javascript','json'],validation:{kind:'none'},productionReachable:false,divergenceBlocking:true,transitional:false,expiresBefore:null});

const excluded=(rel)=>manifest.exclusions.some((x)=>rel===x.path||rel.startsWith(x.path+'/'));
const baseMatch=(rel,s)=>{
  if(s.paths)return s.paths.includes(rel);
  if(!rel.startsWith(s.directory+'/'))return false;
  if((s.excludedPaths??[]).includes(rel))return false;
  if((s.excludedDirectories??[]).some((d)=>rel===d||rel.startsWith(d+'/')))return false;
  if(s.allowedSuffixes&&!s.allowedSuffixes.some((x)=>rel.endsWith(x)))return false;
  return true;
};
function files(root){const out=[];function visit(dir,relDir=''){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const rel=relDir?`${relDir}/${ent.name}`:ent.name;if(excluded(rel))continue;const full=path.join(dir,ent.name);if(ent.isDirectory())visit(full,rel);else out.push(rel);}}visit(fs.realpathSync(root));return out;}
const union=new Set(roots.flatMap(files));
const inventory={schemaVersion:'1.0.0',status:'characterization',rules:{}};
for(const rule of manifest.rules.filter((x)=>x.selector.directory))inventory.rules[rule.id]=[...union].filter((p)=>baseMatch(p,rule.selector)).sort((a,b)=>Buffer.from(a).compare(Buffer.from(b)));
const stable=(v)=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map((k)=>[k,stable(v[k])])):v;
fs.writeFileSync(manifestPath,JSON.stringify(stable(manifest),null,2)+'\n',{flag:'w'});
fs.writeFileSync(path.join(ownRoot,'trio/governance/path-inventory.json'),JSON.stringify(stable(inventory),null,2)+'\n',{flag:'w'});
