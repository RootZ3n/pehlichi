/**
 * TEMPORARY-STORAGE POLICY — the structural control.
 *
 * `/tmp` is forbidden for every lab-owned runtime, test, fixture, subprocess, and generated
 * artifact, and every temporary path must come from the governed authority
 * (`src/core/temp-authority.ts`). This suite scans the COMMITTED tree (git ls-files, the same
 * inventory provenance derives from) and fails on:
 *
 *   - a `/tmp` literal in executable lab-owned code;
 *   - an `os.tmpdir()` / `tmpdir()` call outside the authority;
 *   - an ungoverned `mkdtempSync`/`mktemp`/`tempfile` use;
 *   - a Python/shell helper writing outside the governed root.
 *
 * Inert fixtures may contain the text `/tmp` ONLY to prove refusal, and each such file must be
 * declared below WITH its justification. The allowlist is part of the reviewed boundary: adding
 * to it is a policy change, not a convenience.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * Declared exceptions are CONTENT-ANCHORED, not pathname-anchored.
 *
 * A pathname allowlist exempts a file wholesale: once declared, any future `/tmp` use inside
 * it passes unseen. Each entry therefore pins the exact set of matching lines by SHA-256
 * digest. Adding, changing or removing a matching line in a declared file fails this suite
 * until the declaration is updated deliberately.
 *
 * Digests rather than literal lines, for one reason: this scanner is itself a declared file,
 * and embedding its own matching lines would change what it matches. Hex digests contain
 * none of the patterns, so the declaration is a fixed point.
 *
 * The list is the UNION across the Trio — this file is byte-identical in all three repos, so
 * an entry may name a sibling-only file (e.g. a per-identity helper script).
 */
interface DeclaredException {
  readonly reason: string;
  /** SHA-256 of each trimmed matching line, sorted. */
  readonly lineDigests: readonly string[];
}

const TMP_TEXT_DECLARATIONS: ReadonlyArray<readonly [string, DeclaredException]> = [
  // Split deliberately: this path names an owner-scoped tree that exists only in one Trio
  // member, and a governed shared file may not carry a literal reference to it.
  ["interview-demo-" + "factory/scripts/assemble-demo.sh", {
    reason: "guards PEHVERSE_TEMP_ROOT against forbidden values (loony-luna-only)",
    lineDigests: [
      "607d1fbd9910a436c66b1eef9ed87b5bbe21d4b854c524a77aab0f53c97d41b7",
      "bdf12bd625922089ac131e60134c9c2d264da626075c5d2f0d523da231ea5b31",
    ],
  }],
  ["runtime/server/truth-agent-adapter.ts", {
    reason: "names the untrusted roots solely to refuse handing them to a child",
    lineDigests: [
      "9e9a1c91b8fc906c7de8e07033e87c9a6c6fd0e1d1e3ccc3b1eae518ffbbfdc3",
    ],
  }],
  ["scripts/model-test.sh", {
    reason: "guards PEHVERSE_TEMP_ROOT against forbidden values (pehlichi-only)",
    lineDigests: [
      "607d1fbd9910a436c66b1eef9ed87b5bbe21d4b854c524a77aab0f53c97d41b7",
      "bdf12bd625922089ac131e60134c9c2d264da626075c5d2f0d523da231ea5b31",
    ],
  }],
  ["scripts/trio/governed-temp-authority.mjs", {
    reason: "the canonical authority; owns the forbidden-root constants",
    lineDigests: [
      "0ac7e7eeecb03f9e7851e60479843ceed559a932d5900f310709178e177acc1e",
      "ee1bee8df262b938b8023a87415900affd80b43590b3a5458899f9e2151ca4b6",
    ],
  }],
  ["src/core/governed-launch-regression.test.ts", {
    reason: "adversarial fixtures and positive controls proving refusal",
    lineDigests: [
      "068881a4dd8b62bead8be3184e64ecbb005069118b7e2f7de47bdbf66edb5744",
      "135cc39d16e92dc97751fdeda2d12eed79b7e7a937620318493d66d70d747339",
      "1618cb80cd17dc626099d08d1cb55e6b067176e5c56005f31d08832a000ee3ce",
      "1649be840ba73e0d8fcf46af0a3ef482090d71b78bd814fe8c2220366d984e89",
      "183b1baafd2b49158325c4d71ec8fef73a3088a6f85d9631110f08d808a9bdbb",
      "1a8dbed6d43e046ae4fefa68a7fbd4af627e029559e8c2b085dbdcac5bd64db2",
      "2540866490d3ad3c3c4af5bf118fb979dfe47465d1fd419b749f093a3ef318e6",
      "275b6b6a95117482a94264413ce23156ad0e57d1b116e46845cf7bf3af160e9d",
      "2c92a80a97d18768d6961f3c9ea7418fe814b8f4467ea3116ac6f1e355c439fd",
      "3958d2b7eb0c36b19b979f08908c30bde443e1b24e71d7d566c14f68ab954e8d",
      "3a047f92d6ccaec182c8685ccc954667ce1f6262b97fd033efa066e2d9a6f7ff",
      "3a32bb1a651679d11bb40280d8655ee4a535cf2287f79f1156ebbfeefc7e0499",
      "3a8bca0311ca3db14507e3af64873629c0b06b75bb4bba21905554aeb2cd6fef",
      "3b8e65db96e2247a480ba727c5853f77c943d1a8042f20efaa8ee635d4837f96",
      "4294b78ba3eaa6d6d07065eaf4d53eb7a0828743b38e53b4b1da249aed3b4989",
      "450d99fad621e4e26865782058880c204aaec2aae9c59bf513d52be6a10e7854",
      "451b5fd032a684ccc0b11d5cec32ae721e5e26f0da181641ab8a39a2f01dd053",
      "468924909b7be2e77d0ebd30300cf20692c190400cc8ef78fcbcd87506a92347",
      "49a768f945ea4f4fb8642f02eb87e98e4f6e5a8c84a927371aaa4624a0aabfdb",
      "4b06a6d25c951f14d5d4037f701a459cd527c72043b52ab8ad8fa78dd26c5848",
      "5083bc4c2ee0712cee4cb65b1bfdee29446bb4616d5ac7a180d6707c4f19ee5e",
      "51915a27d4d5a9aeaeaa6964731ded6a0443cb92b1e66d23444dcdb54b138f5d",
      "52161e651b091b1c73ec9be6a69da3186bb3ed2d870d1af4c6bc3a885d044a24",
      "65247f3e9f07abe60d283acb401b07bc024cad5abf1031f745f6afabb8bafeba",
      "6e17d3a1d35c32d832fbd8c2ab81ec603f858449dbd9f381bb8b14cac5dd6d1a",
      "8484711815225d8d1353ea9e72189ef888a4fcbdd5111eaec9795fe0731c1ca0",
      "88f6604a6d7316b6d109bd6881578eff6678fd67c1489f4c79551f5cbeb96cb9",
      "89e46fb44c5d6a6f3ef2eb9c61bd8db814b0c5061cf98a2b9f5ad24b0e8c726a",
      "8f6e721cf9a835791d867da8abff5ea6d0a964365ab3e19d4662daefe1b72d97",
      "9b685a1fcc4096a97a7d928406d38943f843c2d9281c3f164dd6e6500f19bbdd",
      "a4d677f5d6790267782f996ad6ebf9d718374d6231b04b2045e02727eb9361d0",
      "a838414b1f4839d3d08848a30e78c87e4396aac1dfb4ac3f954595e65974ce39",
      "a8fd660827ef8b47d8badbe7bddcbb929fc3b8739e5fc20873915ed51eedd644",
      "af01f0eff7fba6315804984d4b8dca8411d468d817ff578937e1aafb4d9db727",
      "af47c40f0efefe63743f554e7b37e2839da2771d5727196a5bdde8f050501fa6",
      "af92e36b3e109838f692ee78948fdadc1cbc42de9dc55d948082a26965549774",
      "b4e57441c1ca286cfa7c46cb9aabf2208ab75908e41fe0f40d9e9cdb1746413d",
      "bd5905030d6052098e8aaeea51077f5f725ac5c75523f8ae6d3ea8fd29eae78d",
      "c4ec31134ab88195d8af2f0b3f41abbfb095e0894695af66a1fd19972ed7efed",
      "c50546c5a07125799d688c844ee2f4f61e7da0e615004def19dd878ebfe21af3",
      "c93eb99b3bcb378bae85d871c0720a44e53cb5fc201270382ad050794ae85aa8",
      "cb7b02b5e0275f57fec56c575131690832c451bffa1e24e22a4db8e4f0528bd4",
      "d1f9f684bbe9a192c7656eb56bd7e8a8c11fb266f6f4db88acd8981efa4cb66e",
      "d488f8830206ef69cbcbf238e268c7e94be7e68952b2a5c8b77a10ad6b7fe399",
      "dc6ac7c6b0488096fbd89e211dc0ffaf5205f0063cbde1cea1d0e1cb46273955",
      "e7cb72de3ed21b97b9b2fdce0749f2e29f1683bd7a6fd6b5d8eb09ca1a4940c0",
      "ed2547b74857c77f5acc80cc4b1f5644811707a572f0aefe2cebafff07146c0f",
      "ee9ea55a38573b2e4a4c410e693637ac1b0ee4ec8d043482b6cf6939886f8a32",
      "f6fcb7b06b19e404a927da8de2809782b5342b7e5110a7c3350e6148dcea4d19",
      "f78d113d8381cf747c22211e5c1ef2ffce84dcef4b3c2f9b5b18edbd3466c290",
      "fff2c1fbc04eb4ef2f2039759c80275f05e84cd7e00d31bf0caaf9a0fdadc596",
    ],
  }],
  ["src/core/temp-authority.test.ts", {
    reason: "adversarial fixtures prove refusal without touching the forbidden roots",
    lineDigests: [
      "0930e6209f062dd721118ec07eef8e0e46527cea9da8c05d9a31542e35f00df6",
      "17ade1ee7f095d6f6c209ce39c8182df883d754d23dca5492b7b42f034bca696",
      "2d55370d8c8366ab61b5277349ecd454909728de78514268f4018b883545a89b",
      "339eaf746262aa20d66a17fd1a3d79dfb863204db467d9e0778ba3085954ee67",
      "3bc7e7504e3159a75e1f35d7469081d6db3ae78689bb56b1e6e2a8457a1a4570",
      "435d187524dd3eb8d37d530bccb570cb50d14b7785683c4803026c0b5e1503e6",
      "7c85c5c5525500ddc298a17ea280fa6292356eb944c3321a6c7219190afbe21a",
      "814488054f18026be9f91d37c1f35979725a69a792098015027fb6d4890d434d",
      "853006067dcd7725b812e96fcfaa5842ba0c882dd825682d1dd509e92d229e90",
      "8a0a34ce1f1a180fe24720dce30219b885228dc6a411aee11df67cd2b1a27db0",
      "9099a12f48dd596ac1421c2a6fbf9c10658d44530444daa27558c27851d6f710",
      "96e9ae30324005a00098790d580a151fb3b4f90c3f36e29fa9dabcc1ca4a0cf9",
      "ce347a262ffa2578016094e3627310d3929f91b71a9b5b1b59e968ae07f7b654",
      "d210d76ca3ccdcbe21df4042a6275ff7c92c8ea97466599239cedf4f0fea8582",
      "d330bbdfde820597eba6c615b834e78c0fd89d843e60925bf767accba72a343b",
      "dcfcd29b420b91f2b6eae201c306e2d91d9d6e0c317e124a4baf516fe589ded5",
    ],
  }],
  ["src/core/temp-authority.ts", {
    reason: "names the forbidden roots solely to refuse them; the authority wrapper",
    lineDigests: [
      "2f6be7dfd0d409ade72a0d4dc1272a7181f38bba27c203ece56021e3516395a1",
      "54873818fcb608551f308d716c3b27a694c67a8c4fc4de8e044e1f7515b4cf1f",
      "9fdf6d6337266d1cbb6895b1b41dc2d0866d74fa26da7c5e56d491548263efbe",
      "ef0f7d66a32a583c21e41fc1f173c8231786f3aa806167421994d4076f2e8ab2",
    ],
  }],
  ["src/core/temp-policy.test.ts", {
    reason: "this scanner's own patterns and messages",
    lineDigests: [
      "a8ab67cb435fbb02e87d996918a3b62a40580704ed8434e02aa4b1d880ac9a79",
    ],
  }],
  ["stress_test.py", {
    reason: "guards PEHVERSE_TEMP_ROOT against forbidden values",
    lineDigests: [
      "0cf620d8207429931be4794d8ad39c5cc665d0b086a2e7cd7b4ac0907bd16c4d",
      "d2c2959daf2bb817c7daf4ea441b61c80954de2f3d162a2411f86a4e12753c67",
    ],
  }],
  ["tests/runtime/hermes-parity.test.ts", {
    reason: "hostile injection payload proving neutralization; inert",
    lineDigests: [
      "de5dc021a8f0f67481e6f22a661eab38f5338007de7cca2af9e0bd1d33dec309",
    ],
  }],
];

const TMPDIR_CALL_DECLARATIONS: ReadonlyArray<readonly [string, DeclaredException]> = [
  ["src/core/governed-launch-regression.test.ts", {
    reason: "adversarial fixtures and positive controls proving refusal",
    lineDigests: [
      "162ff3eb49ceabffaffa18d351198ee3122f768fcd6983c925a3521d3424b14a",
      "3a8f78f4494c55de42a40d505e594f7a9947caeba47cfa25bd2c739434b3ed1f",
      "40ff140f7240a4bfe07913da1f9c48a08cda2ed1856133131eb35cc2f041ecb3",
      "5c7e5db164d3b318131cbab0717f708d2a6c010bfa59dad7bd83be31f48c166a",
      "8ffc7ab52b9c184ad8e19c0f4aecf440053cc051e089f8e4b9fa828365f2a7ff",
      "9a3c6e3c68ff28cf5e3107ae61a1dda2ff1037445286428dc04a2a5f548563a9",
      "d8daddf6c8c73a98c40fbec1456a105503c6573d0b37dde54c8ac81d8b2c9c7c",
      "e0e5bb8a9e6de5773e6e99b92f01e952619739b4f93f4bd533bc45a955cf4f5e",
      "e5b55ed76087a5d02991f654fd6101f6c76fce476a7a566f2234a21d7151e5df",
      "f104df5f18a9669adfc26e8b0fe8fb5b633b2b2eed42a44cb504dbb302041a5d",
    ],
  }],
  ["src/core/temp-authority.test.ts", {
    reason: "adversarial fixtures prove refusal without touching the forbidden roots",
    lineDigests: [
      "5e3777ffba745251fea2fef6d22ffc60f148adcbf24c0638cdde1ce396ab7f43",
      "71d61890240775ba4f7f8508bec93c680cd699e99119233a339ffb460360fa10",
      "879f8aa517bd62782eb215b4653eac2d874e49267b7802e3a16c9caa9fb5996e",
      "fa65fc8756db8c18de1a37bb355fad0a2ad73b9e72a5459ca76d1ca75e091e1d",
    ],
  }],
  ["src/core/temp-policy.test.ts", {
    reason: "this scanner's own patterns and messages",
    lineDigests: [
      "cae2ab2969be414c549dc5e8d0c3767685da37f0d8a6b07f04db7daf97bff60d",
    ],
  }],
];

const MKDTEMP_CALL_DECLARATIONS: ReadonlyArray<readonly [string, DeclaredException]> = [
  ["src/core/temp-authority.ts", {
    reason: "names the forbidden roots solely to refuse them; the authority wrapper",
    lineDigests: [
      "6ef0a82f18f9f8756da044872ef830c540925955fc6913b920d4472bf228fae6",
    ],
  }],
];


/**
 * Raw package-manager invocations. `npm`/`pnpm` initialise their compile cache against
 * os.tmpdir() before they read any manifest, so a raw invocation has already written to
 * ungoverned storage by the time any guard could run. The supported interface is therefore an
 * entry point AHEAD of the manager — scripts/trio/governed-npm.mjs and governed-pnpm.mjs — and
 * this scan is what keeps every project-owned call path on it. Declared occurrences are the
 * canonical entries themselves and the controls that prove the refusal.
 */
const RAW_PACKAGE_MANAGER_DECLARATIONS: ReadonlyArray<readonly [string, DeclaredException]> = [
  ["scripts/trio/governed-npm.mjs", {
    reason: "THE canonical npm entry; naming npm is what it exists to do",
    lineDigests: [
      "c648852f9381231b06dacd70d6e0dcceb2efdef65e0a6e69417c50ed58dc7d4e",
    ],
  }],
  ["scripts/trio/governed-pnpm.mjs", {
    reason: "THE canonical pnpm entry; pnpm is the Trio’s own package manager",
    lineDigests: [
      "10cac1b9ec100c53eed15da6276a8ed67c6c7e686304ef2a243e4e94cfb713d0",
    ],
  }],
  ["src/core/agent-tools/ikbi-tools.test.ts", {
    reason: "inert fixture data describing a remote check command; never executed here",
    lineDigests: [
      "1d8aa54498fb160a1a0e801314e2554893fe7fffac309c73f0f0304f4d29018e",
      "6f188f44a0b90d43e64814b5849d6baa8b552225a2a3e3f52cff9e23d69a5991",
    ],
  }],
  ["src/core/governed-launch-regression.test.ts", {
    reason: "positive controls that prove an ungoverned manager allocates, and the refusal matrix",
    lineDigests: [
      "2d94f3e8c7e583319449f35fa005b4a4555990a193df633fa7b519b8b174997e",
      "3a0ba3a0d4f3b880f70250bfaf77cab5063596829adf2c09bec597460befc65e",
      "5e3385e53bf2ab65bc4a51918dadb1871ab38e0465f3e4c24021ccc467e97bf3",
      "ef76789795cdd65c0cdea3d3939bfa4ae820c414f35eabdc2c300442db034e45",
    ],
  }],
  ["src/data/lesson-cards.ts", {
    reason: "lesson prose about a separate teaching project; inert text, never executed",
    lineDigests: [
      "469f04e102fe107a7d1da8d233f749b2fcaf6678cd9fd6723538f6b74d4d57c8",
      "783f8da51a3a6f32705f4f914b7ee449a680d2b5c049c5cc2f7d938ad00e269f",
      "98b28700139e5ca439f3758e3b20ce33b6e3529c05a5e328db13d03170fb1f0e",
    ],
  }],
];

const TMP_TEXT_ALLOWED: ReadonlyMap<string, DeclaredException> = new Map(TMP_TEXT_DECLARATIONS);
const TMPDIR_CALL_ALLOWED: ReadonlyMap<string, DeclaredException> = new Map(TMPDIR_CALL_DECLARATIONS);
const MKDTEMP_CALL_ALLOWED: ReadonlyMap<string, DeclaredException> = new Map(MKDTEMP_CALL_DECLARATIONS);
const RAW_PACKAGE_MANAGER_ALLOWED: ReadonlyMap<string, DeclaredException> = new Map(RAW_PACKAGE_MANAGER_DECLARATIONS);

const EXECUTABLE = /\.(ts|mts|cts|mjs|cjs|js|sh|py)$/;

/**
 * Strip comments so the literal rule judges only code that can run. String literals are KEPT —
 * a /tmp inside a string is exactly the dangerous case. Crude by design: a stripper clever
 * enough to parse every dialect would itself need trusting.
 */
function withoutComments(file: string, source: string): string {
  if (/\.(sh|py)$/.test(file)) return source.replace(/(^|\s)#[^\n]*/g, "$1");
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function trackedExecutableFiles(): readonly string[] {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter((f) => f.length > 0 && EXECUTABLE.test(f))
    .filter((f) => !f.startsWith("ui/") && !f.startsWith("dist/") && !f.startsWith("node_modules/"));
}

/**
 * The files a package-manager bypass could hide in: every executable, plus the manifests,
 * deployment descriptors and service definitions that name commands without being code.
 */
const PACKAGE_MANAGER_SCANNED = /(?:^|\/)(?:package\.json)$|\.(ts|mts|cts|mjs|cjs|js|sh|py|service|conf|yaml|yml)$/;

function trackedPackageManagerFiles(): readonly string[] {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter((f) => f.length > 0 && PACKAGE_MANAGER_SCANNED.test(f))
    .filter((f) => !f.startsWith("ui/") && !f.startsWith("dist/") && !f.startsWith("node_modules/"))
    .filter((f) => !f.includes("/node_modules/") && f !== "pnpm-lock.yaml");
}

function matchingLines(file: string, pattern: RegExp): readonly string[] {
  const source = withoutComments(file, readFileSync(file, "utf8"));
  return source.split("\n").map((l) => l.trim()).filter((l) => pattern.test(l));
}

const digestOf = (line: string): string => createHash("sha256").update(line).digest("hex");

/**
 * One scan, applied identically to every rule: a file with no match is silent, an undeclared
 * file with a match is an offender, and a declared file must match EXACTLY what it declared.
 */
function assertDeclared(
  pattern: RegExp,
  allowed: ReadonlyMap<string, DeclaredException>,
  label: string,
  files: readonly string[] = trackedExecutableFiles(),
): void {
  const offenders: string[] = [];
  const drifted: string[] = [];
  for (const file of files) {
    const hits = matchingLines(file, pattern);
    if (hits.length === 0) continue;
    const declared = allowed.get(file);
    if (declared === undefined) {
      offenders.push(file);
      continue;
    }
    const actual = [...new Set(hits.map(digestOf))].sort();
    const expected = [...declared.lineDigests].sort();
    if (actual.length !== expected.length || actual.some((d, i) => d !== expected[i])) {
      drifted.push(`${file} (declared ${expected.length}, found ${actual.length})`);
    }
  }
  assert.deepEqual(offenders, [], `${label}: ${offenders.join(", ")}`);
  assert.deepEqual(drifted, [], `${label} — declared content changed, update the declaration deliberately: ${drifted.join(", ")}`);
}

test("no /tmp literal survives in executable lab-owned code outside the declared refusal fixtures", () => {
  assertDeclared(/\/tmp(?:[/"'`\s),;:\]]|$)/, TMP_TEXT_ALLOWED, "executable files containing the forbidden literal");
});

test("os.tmpdir()/tmpdir() is called only by the authority and its proof", () => {
  assertDeclared(/\btmpdir\s*\(/, TMPDIR_CALL_ALLOWED, "ungoverned tmpdir calls");
});

test("mkdtempSync is used only inside the authority — everyone else goes through governedMkdtemp", () => {
  assertDeclared(/\bmkdtempSync\s*\(/, MKDTEMP_CALL_ALLOWED, "ungoverned mkdtempSync calls");
});

test("shell mktemp and Python tempfile are used only under the governed root", () => {
  const offenders: string[] = [];
  for (const file of trackedExecutableFiles()) {
    if (!/\.(sh|py)$/.test(file)) continue;
    const source = readFileSync(file, "utf8");
    if (/\bmktemp\b/.test(source) && !/PEHVERSE_TEMP_ROOT/.test(source)) offenders.push(`${file} (mktemp)`);
    if (/\btempfile\b/.test(source) && !/PEHVERSE_TEMP_ROOT/.test(source)) offenders.push(`${file} (tempfile)`);
  }
  assert.deepEqual(offenders, [], `ungoverned shell/python temp use: ${offenders.join(", ")}`);
});

test("no raw package-manager invocation survives in committed scripts, tests, deployment files or service definitions", () => {
  assertDeclared(
    /(?:^|[\s"'`;&|(])(?:npm|pnpm|npx|yarn)\s+(?:run\b|exec\b|test\b|start\b|install\b|ci\b|dlx\b|add\b|-)|(?:spawn|spawnSync|execFile|execFileSync|execSync)\s*\(\s*["'`](?:npm|pnpm|npx|yarn)["'`]|\bcommand:\s*["'`](?:npm|pnpm|npx|yarn)["'`]|\brunPackageManager\s*\(\s*["'`](?:npm|pnpm|npx|yarn)["'`]/,
    RAW_PACKAGE_MANAGER_ALLOWED,
    "committed files invoking a package manager outside the governed entry",
    trackedPackageManagerFiles(),
  );
});

test("the refusal fixtures declared above still exist and still justify themselves", () => {
  // The allowlist is a Trio-wide union, so existence is checked across this repo AND its
  // sibling checkouts (the same sibling resolution the provenance generator uses).
  const trackedAnywhere = new Set<string>();
  for (const slot of ["pehlichi", "loony-luna", "mad-ptah"]) {
    try {
      const listing = execFileSync("git", ["-C", `../${slot}`, "ls-files", "-z"], { encoding: "utf8" });
      for (const f of listing.split("\0")) trackedAnywhere.add(f);
    } catch {
      /* an absent sibling checkout proves nothing about this repo's entries */
    }
  }
  for (const map of [TMP_TEXT_ALLOWED, TMPDIR_CALL_ALLOWED, MKDTEMP_CALL_ALLOWED, RAW_PACKAGE_MANAGER_ALLOWED]) {
    for (const [file, declared] of map) {
      assert.ok(
        trackedAnywhere.has(file),
        `declared file ${file} (${declared.reason}) is tracked nowhere in the Trio — remove its entry`,
      );
      assert.ok(
        declared.lineDigests.length > 0,
        `declared file ${file} pins no lines — an empty declaration would exempt it wholesale`,
      );
    }
  }
});
