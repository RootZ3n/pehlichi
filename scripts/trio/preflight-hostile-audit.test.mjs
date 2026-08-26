// The earlier hand-built "TRIO-001B baseline" was not an exact retained implementation.
// This test prevents that unavailable historical claim from being reinstated.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const fixture=JSON.parse(fs.readFileSync(path.join(here,'fixtures/vulnerable-trio-001c-c29223d2649bff467/fixture-manifest.json'),'utf8'));

test('historical evidence is limited to the exact retained vulnerable TRIO-001C fixture',()=>{
  assert.equal(fixture.productionImportAllowed,false);
  assert.match(fixture.purpose,/does not reconstruct TRIO-001B/);
  assert.match(fixture.historicalLimit,/No retained artifact supports reconstruction claims about TRIO-001B/);
  assert.equal(fixture.files['verify-runtime-parity.mjs'],'sha256:c29223d2649bff4671e213562cd40aee7a9a3a4bd261f45a6801d025b3883342');
  assert.equal(fixture.reproduces.length,6);
});
