#!/usr/bin/env node
// Development-only external evidence writer. It never writes inside measured repositories.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verify,publishedResult,SLOT_NAMES} from './verify-runtime-parity.mjs';
import {validateCertification} from './release-certification.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),ownRoot=path.resolve(here,'../..');
const sha256=(data)=>crypto.createHash('sha256').update(data).digest('hex');
const args={slots:{}};for(let i=2;i<process.argv.length;i++){const key=process.argv[i];if(key==='--output-dir')args.outputDir=process.argv[++i];else if(key==='--verification-summary')args.verificationSummaryPath=process.argv[++i];else if(SLOT_NAMES.some((x)=>key===`--${x}`))args.slots[key.slice(2)]=process.argv[++i];else throw new Error(`unsupported argument ${JSON.stringify(key)}`);}
const ecosystem=path.dirname(ownRoot);args.slots.pehlichi??=ownRoot;args.slots['loony-luna']??=path.join(ecosystem,'loony-luna');args.slots['mad-ptah']??=path.join(ecosystem,'mad-ptah');
let outputDir;if(args.outputDir){outputDir=path.resolve(args.outputDir);if(fs.existsSync(outputDir)){if(!fs.statSync(outputDir).isDirectory()||fs.readdirSync(outputDir).length)throw new Error('operator-specified evidence directory must be an existing empty directory or absent');}else fs.mkdirSync(outputDir,{recursive:false});}else outputDir=fs.mkdtempSync(path.join(os.tmpdir(),'trio-001d-evidence-'));
for(const root of Object.values(args.slots)){const real=fs.realpathSync(root);if(outputDir===real||outputDir.startsWith(real+path.sep))throw new Error('evidence directory may not be inside a measured repository');}
const run=(file)=>{const p=cp.spawnSync(process.execPath,[path.join(here,file)],{cwd:ownRoot,encoding:'utf8',env:{...process.env,TMPDIR:process.env.TMPDIR??os.tmpdir()},maxBuffer:32*1024*1024});return {file,exitCode:p.status,signal:p.signal,stdout:p.stdout,stderr:p.stderr,stdoutSha256:sha256(p.stdout),stderrSha256:sha256(p.stderr),tests:Number(p.stdout.match(/^1\.\.(\d+)$/m)?.[1]??0),passed:Number(p.stdout.match(/^# pass (\d+)$/m)?.[1]??0),failed:Number(p.stdout.match(/^# fail (\d+)$/m)?.[1]??0)};};
const preflight=run('vulnerable-six-reproduction.test.mjs');const hostile=run('verify-runtime-parity.test.mjs');const strict=run('strict-json-differential.test.mjs');const schemas=run('schema-validation.test.mjs');
const scaffolding=run('scaffolding.test.mjs');const mutation=run('mutation.test.mjs');const credential=run('credential-nonread.test.mjs');const truthIdentity=run('truth-identity.test.mjs');const certificationSuite=run('certification.test.mjs');
const certification=validateCertification();
const parity=publishedResult(verify({slots:args.slots,manifestPath:path.join(ownRoot,'trio/governance/boundary-manifest.json')}));
const verificationSummary=args.verificationSummaryPath?JSON.parse(fs.readFileSync(path.resolve(args.verificationSummaryPath),'utf8')):null;
const artifactData={
  'TRIO-001D-PREFLIGHT-EVIDENCE.json':JSON.stringify({schemaVersion:'1.0.0',meaning:'Passing tests reproduce exact false-green PARITY behavior in the retained vulnerable TRIO-001C fixture; this is not a TRIO-001B reconstruction.',retainedVerifierDigest:'sha256:c29223d2649bff4671e213562cd40aee7a9a3a4bd261f45a6801d025b3883342',result:preflight},null,2)+'\n',
  'TRIO-001D-HOSTILE-RESULTS.json':JSON.stringify({schemaVersion:'1.0.0',expectedRealVerdict:'BLOCKING_DIVERGENCE',primary:hostile,noVacuousVerifierErrorAcceptance:true,verificationSummary},null,2)+'\n',
  'TRIO-001D-PARITY-RESULT.json':JSON.stringify(parity,null,2)+'\n',
  'TRIO-001D-SCHEMA-RESULTS.json':JSON.stringify({schemaVersion:'1.0.0',strictJsonDifferential:strict,schemaValidation:schemas,validator:parity.validator},null,2)+'\n',
  'TRIO-001E-REMEDIATION-RESULTS.json':JSON.stringify({schemaVersion:'1.0.0',meaning:'Post-remediation suites for the repaired parity verifier. Independent re-audit is pending; this bundle is self-reported.',label:'PARITY_VERIFIER_REMEDIATED / INDEPENDENT_REAUDIT_PENDING',suites:{scaffolding,mutation,credentialNonRead:credential,truthIdentity,certification:certificationSuite},verifierCertification:certification.ok?certification.certification:{certified:false,problems:certification.problems},truthRelease:parity.truthRelease??null,credentialPathPolicy:parity.secretPathPolicy??null,secretPathsExcluded:parity.secretPathsExcluded??[]},null,2)+'\n'
};
const report=[
  '# TRIO-001D implementation evidence',
  '',
  'This report describes verifier/scaffolding evidence only. It does not claim runtime containment, convergence, trusted code, or reproducible compiled artifacts.',
  '',
  `- Retained vulnerable verifier: \`sha256:c29223d2649bff4671e213562cd40aee7a9a3a4bd261f45a6801d025b3883342\``,
  `- Retained six-attack reproduction: exit ${preflight.exitCode}, ${preflight.passed}/${preflight.tests} passing`,
  `- Hardened hostile suite: exit ${hostile.exitCode}, ${hostile.passed}/${hostile.tests} passing`,
  `- Strict JSON differential suite: exit ${strict.exitCode}, ${strict.passed}/${strict.tests} passing`,
  `- Schema suite: exit ${schemas.exitCode}, ${schemas.passed}/${schemas.tests} passing`,
  `- Scaffolding suite: exit ${scaffolding.exitCode}, ${scaffolding.passed}/${scaffolding.tests} passing`,
  `- Mutation suite: exit ${mutation.exitCode}, ${mutation.passed}/${mutation.tests} passing`,
  `- Credential non-read suite: exit ${credential.exitCode}, ${credential.passed}/${credential.tests} passing`,
  `- Truth identity suite: exit ${truthIdentity.exitCode}, ${truthIdentity.passed}/${truthIdentity.tests} passing`,
  `- Certification suite: exit ${certificationSuite.exitCode}, ${certificationSuite.passed}/${certificationSuite.tests} passing`,
  `- Verifier certification: \`${certification.ok?certification.certification.certificationDigest:'UNCERTIFIED'}\``,
  `- Bound Truth release: \`${parity.truthRelease?.releaseId??'unresolved'}\` (${parity.truthRelease?.packageClosureFileCount??'?'} files, ${parity.truthRelease?.validationMethod??'n/a'})`,
  `- Credential paths excluded unread: ${parity.secretPathsExcluded?.length??0}`,
  `- Real-trio verifier status: \`${parity.status}\``,
  `- Real-trio verdict: \`${parity.summary.verdict}\``,
  `- Real-trio blockers: ${parity.summary.blockingCount}`,
  '',
  '## Defects reproduced before fixes',
  '',
  'The exact retained TRIO-001C fixture returned green parity for: prototype-mutated schema input; variable capsule mode mismatch; active Markdown inherited by a broad variable rule; divergent `.next` server JavaScript; divergent coverage browser JavaScript; and a PNG-signature polyglot. The fixture does not establish any TRIO-001B result.',
  '',
  '## Verifier and scaffolding changes',
  '',
  'The strict parser now creates null-prototype immutable own properties and rejects decoded sensitive keys. Ajv validates those exact objects with own-property semantics. Closed path inventories replace parent-directory inheritance. Variable files enforce type, mode, presence symmetry, symlink, and hard-link policy. Generated/cache holes are scanned. Variable assets remain blocking quarantine. Capsule/deployment references are constrained data IDs or opaque handles. Package behavior, rules, exclusions, schemas, implementations, snapshot state, and per-tree identities are bound by a length-framed top-level contract.',
  '',
  '## Post-fix disposition',
  '',
  'Every retained false green is either a precise structured invalid-input rejection or a `VERIFIER_OK_DIVERGENCE / BLOCKING_DIVERGENCE` finding. The real trio remains blocking. No production behavior was changed by this work.',
  '',
  '## Independent verification observations supplied for this evidence run',
  '',
  verificationSummary?'```json\n'+JSON.stringify(verificationSummary,null,2)+'\n```':'No external verification summary was supplied.',
  '',
  'Known limits: Git metadata binds labels rather than cryptographic provenance; generated/compiled artifacts are compared when inventoried but not reproducibly rebuilt; installed dependency bytes are excluded and represented through governed lock/config state; identical bytes do not establish safety.',
  ''
].join('\n');artifactData['TRIO-001D-IMPLEMENTATION-REPORT.md']=report;
for(const [name,data] of Object.entries(artifactData))fs.writeFileSync(path.join(outputDir,name),data,{flag:'wx',mode:0o600});
const artifacts=Object.keys(artifactData).sort().map((name)=>{const file=path.join(outputDir,name),data=fs.readFileSync(file);return {path:file,length:data.length,sha256:sha256(data)};});
const snapshots=(parity.repositoryIdentities??[]).map((x)=>({agent:x.agent,canonicalRealpath:x.canonicalRealpath,head:x.head,branch:x.branch,dirty:x.dirty,behavioralEnvelopeDigest:x.behavioralEnvelopeDigest}));
const evidenceManifest={schemaVersion:'1.0.0',outputDirectory:outputDir,observedRepositorySnapshots:snapshots,artifacts,selfHashPolicy:'The manifest cannot recursively contain its own final digest. Its path and byte identity are reported by the command output and must be hashed externally after generation.'};const manifestPath=path.join(outputDir,'TRIO-001D-EVIDENCE-MANIFEST.json');fs.writeFileSync(manifestPath,JSON.stringify(evidenceManifest,null,2)+'\n',{flag:'wx',mode:0o600});const manifestData=fs.readFileSync(manifestPath);
process.stdout.write(JSON.stringify({status:'EVIDENCE_WRITTEN',outputDirectory:outputDir,artifacts:[...artifacts,{path:manifestPath,length:manifestData.length,sha256:sha256(manifestData)}],observedRepositorySnapshots:snapshots},null,2)+'\n');
process.exitCode=[preflight,hostile,strict,schemas].every((x)=>x.exitCode===0)&&parity.status==='VERIFIER_OK_DIVERGENCE'&&parity.summary.verdict==='BLOCKING_DIVERGENCE'?0:1;
