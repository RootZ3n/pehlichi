import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { readStrictJson,parseStrictJsonText,JSON_LIMITS,StrictJsonError } from './strict-json.mjs';

export const SCHEMA_VALIDATOR=Object.freeze({name:'ajv',version:'8.20.0',draft:'https://json-schema.org/draft/2020-12/schema',contractVersion:'2.0.0'});
const SCHEMAS=Object.freeze({boundary:'boundary.schema.json',capsule:'capsule.schema.json',deployment:'deployment.schema.json',capabilityPack:'capability-pack.schema.json',runtimeManifest:'runtime-manifest.schema.json'});

function cleanErrors(errors=[]){return errors.map((e)=>({instancePath:e.instancePath,schemaPath:e.schemaPath,keyword:e.keyword,message:e.message??'validation failed',params:e.params}));}
export function createSchemaValidator(schemaDir){
  const ajv=new Ajv2020({allErrors:true,strict:true,strictRequired:true,allowUnionTypes:true,validateFormats:false});
  const validators={};
  for(const [kind,name] of Object.entries(SCHEMAS)){const schema=readStrictJson(path.join(schemaDir,name));validators[kind]=ajv.compile(schema);}
  return {
    metadata:SCHEMA_VALIDATOR,
    validateValue(kind,value){const validate=validators[kind];if(!validate)return {ok:false,errors:[{keyword:'schemaKind',message:'unsupported schema kind',params:{kind}}]};const ok=validate(value);return {ok:Boolean(ok),errors:ok?[]:cleanErrors(validate.errors)};},
    validateFile(kind,file){try{const value=readStrictJson(file);const result=this.validateValue(kind,value);return {...result,value};}catch(error){return {ok:false,value:null,errors:[{keyword:error instanceof StrictJsonError?error.code:'read',message:error.message,params:{offset:error.offset}}]};}},
    parseText(kind,text){try{const value=parseStrictJsonText(text);const result=this.validateValue(kind,value);return {...result,value};}catch(error){return {ok:false,value:null,errors:[{keyword:error instanceof StrictJsonError?error.code:'parse',message:error.message,params:{offset:error.offset}}]};}}
  };
}
export { JSON_LIMITS };
