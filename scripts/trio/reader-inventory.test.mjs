import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeSemanticClosure} from './semantic-reader-closure.mjs';

test('the complete production module graph has exactly its declared semantic capabilities',()=>{
  const result=analyzeSemanticClosure();
  assert.equal(result.ok,true);
  assert.equal(result.parser.name,'typescript');
  assert.deepEqual(result.capabilities.map((x)=>x.resolvedCapability),[
    'filesystem.openSync','filesystem.readFileSync','process.spawnSync','process.execFileSync','process.spawnSync'
  ]);
});
