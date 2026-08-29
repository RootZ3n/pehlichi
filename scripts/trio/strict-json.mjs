import { UnauthorizedParserAccess } from './governed-reader.mjs';

export const JSON_LIMITS=Object.freeze({maxBytes:1_048_576,maxDepth:32,maxCollectionItems:4096,maxStringLength:65_536});
export const STRICT_JSON_CONTRACT=Object.freeze({version:'3.0.0',objectPrototype:'null',propertySemantics:'own-data-properties-only',numbers:'RFC-8259 syntax; finite IEEE-754 values including negative zero and finite underflow',unicode:'decoded UTF-16 strings; unpaired surrogate escapes are accepted and preserved',forbiddenKeys:['__proto__','constructor','prototype']});
const FORBIDDEN_KEYS=new Set(STRICT_JSON_CONTRACT.forbiddenKeys);

export class StrictJsonError extends Error{
  constructor(code,message,offset){super(message);this.name='StrictJsonError';this.code=code;this.offset=offset;}
}

export function parseStrictJsonText(text,limits=JSON_LIMITS){
  if(Buffer.byteLength(text,'utf8')>limits.maxBytes)throw new StrictJsonError('JSON_SIZE_LIMIT','JSON input exceeds the byte limit',0);
  let i=0;
  const fail=(code,message)=>{throw new StrictJsonError(code,message,i);};
  const ws=()=>{while(i<text.length&&/[\x20\x09\x0a\x0d]/.test(text[i]))i++;};
  function string(){
    if(text[i++]!=='"')fail('JSON_SYNTAX','Expected string');let out='';
    while(i<text.length){const c=text[i++];if(c==='"'){if(out.length>limits.maxStringLength)fail('JSON_STRING_LIMIT','JSON string exceeds the character limit');return out;}if(c==='\\'){if(i>=text.length)fail('JSON_SYNTAX','Unterminated escape');const e=text[i++];if(e==='u'){const h=text.slice(i,i+4);if(!/^[0-9a-fA-F]{4}$/.test(h))fail('JSON_SYNTAX','Invalid Unicode escape');out+=String.fromCharCode(Number.parseInt(h,16));i+=4;}else{const m={"\"":'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};if(!(e in m))fail('JSON_SYNTAX','Invalid escape');out+=m[e];}}else{if(c.charCodeAt(0)<0x20)fail('JSON_SYNTAX','Unescaped control character');out+=c;}if(out.length>limits.maxStringLength)fail('JSON_STRING_LIMIT','JSON string exceeds the character limit');}
    fail('JSON_SYNTAX','Unterminated string');
  }
  function value(depth){
    if(depth>limits.maxDepth)fail('JSON_DEPTH_LIMIT','JSON nesting exceeds the depth limit');ws();const c=text[i];
    if(c==='"')return string();
    if(c==='{'){i++;const out=Object.create(null);const keys=new Set();let count=0;ws();if(text[i]==='}'){i++;return out;}while(true){ws();if(text[i]!=='"')fail('JSON_SYNTAX','Expected object key');const key=string();if(keys.has(key))fail('JSON_DUPLICATE_KEY','Duplicate JSON object key');if(FORBIDDEN_KEYS.has(key))fail('JSON_FORBIDDEN_KEY','Security-sensitive JSON object key is forbidden');keys.add(key);if(++count>limits.maxCollectionItems)fail('JSON_COLLECTION_LIMIT','JSON object exceeds the member limit');ws();if(text[i++]!==':')fail('JSON_SYNTAX','Expected colon');const parsed=value(depth+1);Object.defineProperty(out,key,{value:parsed,enumerable:true,writable:false,configurable:false});ws();if(text[i]==='}'){i++;return out;}if(text[i++]!==',')fail('JSON_SYNTAX','Expected comma');}}
    if(c==='['){i++;const out=[];ws();if(text[i]===']'){i++;return out;}while(true){if(out.length>=limits.maxCollectionItems)fail('JSON_COLLECTION_LIMIT','JSON array exceeds the item limit');out.push(value(depth+1));ws();if(text[i]===']'){i++;return out;}if(text[i++]!==',')fail('JSON_SYNTAX','Expected comma');}}
    const rest=text.slice(i);const literal=rest.match(/^(true|false|null)/)?.[1];if(literal){i+=literal.length;return literal==='true'?true:literal==='false'?false:null;}
    const number=rest.match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/)?.[0];if(number){i+=number.length;const n=Number(number);if(!Number.isFinite(n))fail('JSON_NUMBER','JSON number is not finite');return n;}
    fail('JSON_SYNTAX','Expected JSON value');
  }
  const result=value(0);ws();if(i!==text.length)fail('JSON_SYNTAX','Trailing JSON content');return result;
}

export function readStrictJson(file,limits=JSON_LIMITS){
  void limits;
  throw new UnauthorizedParserAccess(String(file));
}
