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
      "0f216268d965e826386b0a865099a8f66ef0d98f5b08fa304f9f837bc8fc9f0f",
      "11e0d8f2a7642245a31373b046dd286d425d5c057073c573c3b2a56d75ec0842",
      "1a8dbed6d43e046ae4fefa68a7fbd4af627e029559e8c2b085dbdcac5bd64db2",
      "275b6b6a95117482a94264413ce23156ad0e57d1b116e46845cf7bf3af160e9d",
      "2c92a80a97d18768d6961f3c9ea7418fe814b8f4467ea3116ac6f1e355c439fd",
      "3add46e38b81d3214ff538303bdd45d651520cf7cf8a78c0d2d0aea076b29e6a",
      "419f12b00e11f7d86a3a8f50cb70ae3c1722acdb7bed1b4d51d4956e7a695c4e",
      "450d99fad621e4e26865782058880c204aaec2aae9c59bf513d52be6a10e7854",
      "452cd5e1289c5714c54637ff02f1dd10a4566c706ab27d60e58842f2cf262607",
      "49a768f945ea4f4fb8642f02eb87e98e4f6e5a8c84a927371aaa4624a0aabfdb",
      "4b06a6d25c951f14d5d4037f701a459cd527c72043b52ab8ad8fa78dd26c5848",
      "65357be2bb7948d551106e212bc6ae0f676bb448b56806d051fdceb87a38c9ca",
      "678aa7956ddd5f00c7416a697cc7f1de0ca26cd811e3c9d92145e6eb41775405",
      "6db2d9c5528b5e00c21ca9462b7e6ec792b07f29222f5e0ad83ed62e1d3fbc0f",
      "6e17d3a1d35c32d832fbd8c2ab81ec603f858449dbd9f381bb8b14cac5dd6d1a",
      "6f917cb185be8b20f01a8759c258d515399e1460aaf2a32062d4d26709e868d7",
      "835fe59c425ab26d72b604d48c4852df6b0a328a63a9b09f56796cd821e2d3fc",
      "83d752b54e3d64ca88af2d70007e179d3a7125aea13a77a457d397cdbc6e3a05",
      "8b26a57c93f5fbc470d60e04ad92026537d387a40ec82af6a5083cfa9064866a",
      "9b685a1fcc4096a97a7d928406d38943f843c2d9281c3f164dd6e6500f19bbdd",
      "af47c40f0efefe63743f554e7b37e2839da2771d5727196a5bdde8f050501fa6",
      "be118a6a69b8772d33df4be786698a643301e3d5735ad87292c4e8419df55ce3",
      "c8c1461447a090ffe0ea45eb73c6f525c111c7b87adaf1cdad127b1724dd4326",
      "c93eb99b3bcb378bae85d871c0720a44e53cb5fc201270382ad050794ae85aa8",
      "d488f8830206ef69cbcbf238e268c7e94be7e68952b2a5c8b77a10ad6b7fe399",
      "d932539f0a899159df6bfd3ea55f218cd5e9cade48ab6f7d494cbe001373e8ef",
      "d950a52a5b65e086f917e4aafd9776c90f2195ede9661f58a56df8b4a3a4b011",
      "ead8fb1a9a6b4debfbaca0e493318bdb06c05905dc624338f71a2d8fe3b11e91",
      "ed2547b74857c77f5acc80cc4b1f5644811707a572f0aefe2cebafff07146c0f",
      "f31c49ddd83830d857ef0cf62f0b27d61f54b9953923c708cdd690682c68b809",
      "f6fcb7b06b19e404a927da8de2809782b5342b7e5110a7c3350e6148dcea4d19",
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
  // Split deliberately: this path names an owner-scoped tree that exists only in one Trio
  // member, and a governed shared file may not carry a literal reference to it.
  ["interview-demo-" + "factory/scripts/assemble-demo.sh", {
    reason: "guards PEHVERSE_TEMP_ROOT against forbidden values (loony-luna-only)",
    lineDigests: [
      "607d1fbd9910a436c66b1eef9ed87b5bbe21d4b854c524a77aab0f53c97d41b7",
      "bdf12bd625922089ac131e60134c9c2d264da626075c5d2f0d523da231ea5b31",
    ],
  }],
];

const TMPDIR_CALL_DECLARATIONS: ReadonlyArray<readonly [string, DeclaredException]> = [
  ["src/core/governed-launch-regression.test.ts", {
    reason: "adversarial fixtures and positive controls proving refusal",
    lineDigests: [
      "162ff3eb49ceabffaffa18d351198ee3122f768fcd6983c925a3521d3424b14a",
      "3a8f78f4494c55de42a40d505e594f7a9947caeba47cfa25bd2c739434b3ed1f",
      "e5b55ed76087a5d02991f654fd6101f6c76fce476a7a566f2234a21d7151e5df",
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


const TMP_TEXT_ALLOWED: ReadonlyMap<string, DeclaredException> = new Map(TMP_TEXT_DECLARATIONS);
const TMPDIR_CALL_ALLOWED: ReadonlyMap<string, DeclaredException> = new Map(TMPDIR_CALL_DECLARATIONS);
const MKDTEMP_CALL_ALLOWED: ReadonlyMap<string, DeclaredException> = new Map(MKDTEMP_CALL_DECLARATIONS);

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
  onlyFiles?: (file: string) => boolean,
): void {
  const offenders: string[] = [];
  const drifted: string[] = [];
  for (const file of trackedExecutableFiles()) {
    if (onlyFiles && !onlyFiles(file)) continue;
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
  for (const map of [TMP_TEXT_ALLOWED, TMPDIR_CALL_ALLOWED, MKDTEMP_CALL_ALLOWED]) {
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
