import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import {parseStrictJsonText,StrictJsonError,STRICT_JSON_CONTRACT} from './strict-json.mjs';

const reject=(text,code)=>assert.throws(()=>parseStrictJsonText(text),(error)=>error instanceof StrictJsonError&&error.code===code);

for(const key of ['__proto__','constructor','prototype']){
  test(`strict object semantics reject root ${key}`,()=>reject(`{"${key}":{"polluted":true}}`,'JSON_FORBIDDEN_KEY'));
  test(`strict object semantics reject nested ${key}`,()=>reject(`{"safe":{"${key}":1}}`,'JSON_FORBIDDEN_KEY'));
}

test('decoded key identity rejects escaped sensitive names and duplicates',()=>{
  reject('{"__pr\\u006fto__":1}','JSON_FORBIDDEN_KEY');
  reject('{"c\\u006fnstructor":1}','JSON_FORBIDDEN_KEY');
  reject('{"pr\\u006ftotype":1}','JSON_FORBIDDEN_KEY');
  reject('{"safe":1,"s\\u0061fe":2}','JSON_DUPLICATE_KEY');
});

test('accepted objects have null prototypes and explicit immutable own properties',()=>{
  const value=parseStrictJsonText('{"root":{"value":1},"array":[{"ok":true}]}');
  assert.equal(Object.getPrototypeOf(value),null);
  assert.equal(Object.getPrototypeOf(value.root),null);
  assert.equal(Object.getPrototypeOf(value.array[0]),null);
  assert.equal(Object.hasOwn(value,'root'),true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(value,'root'),{value:value.root,writable:false,enumerable:true,configurable:false});
  assert.equal(Object.hasOwn(value,'polluted'),false);
});

test('strict parser, JSON serialization, spread, and independent Ajv agree on accepted own data',()=>{
  const text='{"schemaVersion":"1.0.0","nested":{"enabled":true}}';
  const strict=parseStrictJsonText(text),ordinary=JSON.parse(text),spread={...strict};
  assert.deepEqual(JSON.parse(JSON.stringify(strict)),ordinary);
  assert.deepEqual(JSON.parse(JSON.stringify(spread)),ordinary);
  const ajv=new Ajv2020({strict:true,ownProperties:true,coerceTypes:false,useDefaults:false,removeAdditional:false});
  const validate=ajv.compile({type:'object',required:['schemaVersion','nested'],additionalProperties:false,properties:{schemaVersion:{const:'1.0.0'},nested:{type:'object',required:['enabled'],additionalProperties:false,properties:{enabled:{const:true}}}}});
  assert.equal(validate(strict),true);
  const inherited=Object.create({schemaVersion:'1.0.0',nested:{enabled:true}});
  assert.equal(validate(inherited),false);
});

test('sensitive duplicate-like inputs reject precisely rather than mutating a prototype',()=>{
  reject('{"__proto__":1,"__pr\\u006fto__":2}','JSON_FORBIDDEN_KEY');
  assert.equal(({}).polluted,undefined);
  assert.equal(STRICT_JSON_CONTRACT.objectPrototype,'null');
  assert.equal(STRICT_JSON_CONTRACT.propertySemantics,'own-data-properties-only');
});

test('documented numeric semantics accept finite extremes and reject overflow/non-JSON forms',()=>{
  assert.equal(Object.is(parseStrictJsonText('-0'),-0),true);
  assert.equal(parseStrictJsonText('1e-9999'),0);
  assert.equal(parseStrictJsonText('1.7976931348623157e308'),Number.MAX_VALUE);
  for(const value of ['1e9999','NaN','Infinity','+1','01'])reject(value,value==='1e9999'?'JSON_NUMBER':'JSON_SYNTAX');
});

test('documented Unicode semantics preserve unpaired escapes while rejecting BOM, malformed escapes, comments, and trailing data',()=>{
  assert.equal(parseStrictJsonText('"\\ud800"').charCodeAt(0),0xd800);
  for(const value of ['\ufeff{}','"\\uZZZZ"','{/*x*/}','{} trailing'])reject(value,'JSON_SYNTAX');
});
