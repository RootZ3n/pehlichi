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
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * THIS FILE IMPORTS NOTHING OF THE TREE IT ANALYSES.
 *
 * A static analysis that imports the module it is judging executes it, and the control that
 * proves this scanner catches a plant inside `scripts/trio/governed-temp-authority.mjs` works by
 * putting a live write into that very file. Reaching the governed scratch directory through the
 * authority's own API would therefore have run the plant — the control caught it immediately, and
 * the coupling is recorded here so it is not reintroduced. The governed root is read from the
 * environment the boundary already establishes, and refused if it is not there.
 */
const GOVERNED_ROOT_ENV = "PEHVERSE_TEMP_ROOT";

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
  ["src/core/containment/argv.ts", {
    reason: "the containment authority names the system temporary directory in order to MASK it: the sandbox replaces it with a private tmpfs and points TMPDIR at governed scratch instead",
    lineDigests: [
      "12eaa972791a0f278442356ccf18c3418642f0454a8432b93f4848553eaece66",
      "2f65cfb09ed5f319124d8589589afe7ef9cc1fa438d502e46ed9fdb63936df09",
      "453b145af743476c3e22eff97244e5c81e1a9e662674271653a96c6488ffc7a9",
      "473ad7f2a65e280507594c29d0b4e875bef5dfb51cf7329bed09c70c7dd95690",
      "6d06617096095080b35979574817c86778e404dc0bb9c86e6c34e4bd7f278e86",
      "ad9cf2968634830fe5d960b9d39ad6d6acad09e417525c2ca961131383cf121e",
      "d6a1d2b1c9c1a71e26dde787790a7058438fa512f539f868f2e440b2f0505a4b",
      "ecb13e87aa2015d49f58e6fdfc7f96ad5b2769368d7ca3d894363b4c7720112e",
    ],
  }],
  ["src/core/containment/availability.ts", {
    reason: "the availability probe runs the real policy shape, which includes that mask; a probe that tested something easier would report a boundary that does not exist",
    lineDigests: [
      "eeee2011693ff60574fa4931e038d78303227066e45d61610e37f2fa0dc6ae66",
    ],
  }],
  ["src/core/containment/conformance.ts", {
    reason: "controls asserting the mask is present in the built argv; naming the forbidden root in order to refuse it is the reviewed case",
    lineDigests: [
      "af06b25f10684b7b0ef36d942d9043665f7de725b3d1f32f94c990328d597bbd",
      "fa20257a88726b4bd96707db4ba0fcc51fecab8e4671558f3d37308da7a3728e",
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
      "5b46a89962b7c75e61ab83ff7ad5810f8db63b83ead33b391f43acc8b800ad7d",
      "65247f3e9f07abe60d283acb401b07bc024cad5abf1031f745f6afabb8bafeba",
      "6e17d3a1d35c32d832fbd8c2ab81ec603f858449dbd9f381bb8b14cac5dd6d1a",
      "8484711815225d8d1353ea9e72189ef888a4fcbdd5111eaec9795fe0731c1ca0",
      "870ee05d330ca588c5a717fa5891a66beb5e4d08c158d92c77164eead1636fcd",
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
 * UNGOVERNED EXECUTION ANALYSIS — command content, not pattern matching.
 *
 * `npm`, `pnpm`, `npx`, `yarn` and `corepack` initialise a compile cache against `os.tmpdir()`
 * before they read any manifest, and `tsc`/`tsx` do the same at loader init. A raw invocation
 * has therefore already written to ungoverned storage by the time any guard could run, so the
 * supported interface is an entry point AHEAD of them — `scripts/trio/governed-npm.mjs`,
 * `governed-pnpm.mjs` and `governed-launch.mjs` — and this analysis is what keeps every
 * project-owned call path on it.
 *
 * A regex over source lines cannot do that job: `PM=pnpm; $PM run test`, `alias pm=pnpm`,
 * `corepack pnpm run build`, `npx tsc`, `sh -c "…"`, `spawnSync("pn" + "pm", …)` and
 * `["p","n","p","m"].join("")` all defeat it. So each governed file type is analysed as what it
 * actually is — a manifest, a shell script, a program, a unit file, a document — and a command
 * whose identity cannot be resolved statically is a finding, not a pass. Absence of evidence is
 * refusal.
 */

/** Package managers: they own a compile cache before they own a manifest. */
const PACKAGE_MANAGERS = ["npm", "pnpm", "npx", "yarn", "corepack"] as const;
/** Compilers and loaders that allocate against os.tmpdir() at start-up. */
const BUILD_TOOLS = ["tsc", "tsx"] as const;
const UNGOVERNED_COMMANDS: readonly string[] = [...PACKAGE_MANAGERS, ...BUILD_TOOLS];

/**
 * The canonical entries. A command that begins with one of these IS the boundary.
 *
 * Identity is the exact repository-relative path, not a filename suffix. A suffix test accepts
 * `./anywhere/governed-launch.mjs`, so anyone could park a file with the right name beside their
 * own script and inherit the boundary's authority without passing through it. The boundary is a
 * specific committed file, and only that file.
 */
const GOVERNED_ENTRY_PATHS: readonly string[] = [
  "scripts/trio/governed-launch.mjs",
  "scripts/trio/governed-npm.mjs",
  "scripts/trio/governed-pnpm.mjs",
];

/**
 * THE CANONICAL SPELLINGS, AND NOTHING ELSE.
 *
 * Normalising a word before comparing it was the fail-open case an independent audit proved.
 * `node ../../scripts/trio/governed-launch.mjs …` and `node foo/../../scripts/trio/governed-launch.mjs …`
 * both collapsed onto the canonical path and inherited the boundary's authority from OUTSIDE the
 * repository, and every command they went on to name was excused. A normaliser cannot separate
 * "a nested manifest reaching the repository root" from "a word that climbs past it", because
 * both are spelled with `..` and both normalise to the same string.
 *
 * So the spelling is enumerated rather than normalised. There are exactly three canonical files
 * and exactly three ways to write each: bare from the repository root, `./`-prefixed from the
 * same place, and ONE `../` from a package one level down — the spelling `tui/package.json`
 * actually uses, and the only relative escape that is a real call path here. Deeper traversal, a
 * traversal that cancels, an absolute path, and a suffix that merely ends in the right name are
 * all something else, and something else is not the boundary.
 */
const GOVERNED_ENTRY_SPELLINGS: ReadonlySet<string> = new Set(
  GOVERNED_ENTRY_PATHS.flatMap((entry) => [entry, `./${entry}`, `../${entry}`]),
);

/**
 * …and the file that spelling names must really BE that file.
 *
 * A spelling test is a claim about text; the boundary is a claim about a file. A symlink
 * committed at `scripts/trio/governed-launch.mjs`, or a symlinked directory anywhere above it,
 * satisfies every spelling above while executing something entirely else — the same substitution
 * the TUI build was independently shown to accept through its output directory. So each
 * component from the repository root down is `lstat`ed: the parents must be real directories, the
 * entry a real regular file, no component a symlink, and the resolved path must land back on the
 * path that was walked.
 *
 * An entry that fails this proof is not a governed entry for anything below, so every command it
 * would have excused becomes a finding instead. Absence of proof is refusal here too.
 */
function entryIsCanonicalOnDisk(root: string, relative: string): boolean {
  try {
    const realRoot = realpathSync(root);
    const segments = relative.split("/");
    let current = realRoot;
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment);
      const stats = lstatSync(current);
      if (stats.isSymbolicLink()) return false;
      if (index === segments.length - 1 ? !stats.isFile() : !stats.isDirectory()) return false;
    }
    return realpathSync(current) === join(realRoot, relative);
  } catch {
    return false;
  }
}

/**
 * The proof is taken once, against the repository this scan is reading — the same tree
 * `git ls-files` is enumerated from — and cached, because it is a property of the tree and not
 * of the command being judged.
 */
let provenGovernedEntries: ReadonlySet<string> | undefined;
function trustedGovernedEntries(): ReadonlySet<string> {
  provenGovernedEntries ??= new Set(
    GOVERNED_ENTRY_PATHS.filter((entry) => entryIsCanonicalOnDisk(process.cwd(), entry)),
  );
  return provenGovernedEntries;
}

const isGovernedEntry = (word: string): boolean =>
  GOVERNED_ENTRY_SPELLINGS.has(word) && trustedGovernedEntries().has(word.replace(/^\.{1,2}\//, ""));

interface Finding {
  /** `ungoverned-command:<tool>`, `literal-ungoverned-command:<tool>` or `unresolved-command`. */
  readonly kind: string;
  /** The command text the finding was made on, normalised to single spaces. */
  readonly text: string;
}

const baseOf = (word: string): string => word.replace(/^.*\//, "");
const isUngoverned = (word: string): boolean => UNGOVERNED_COMMANDS.includes(baseOf(word));
const normalise = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 200);
const finding = (kind: string, text: string): Finding => ({ kind, text: normalise(text) });

function unquote(value: string): string {
  const t = value.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) return t.slice(1, -1);
  return t;
}

/** Tokenise one command, keeping quoted runs together. */
function tokenise(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const c of command) {
    if (quote !== null) { if (c === quote) quote = null; else cur += c; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ""; } continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Split a shell fragment into individual commands on operators, respecting quotes.
 *
 * Two constructs are kept whole because splitting them manufactures commands that were never
 * written. `name=(a b c)` is an array ASSIGNMENT -- its parentheses hold data, and cutting there
 * turns the operands into a command line. `${…}` is one word, and cutting on its braces leaves a
 * bare `$` standing where a command name would be.
 *
 * A parenthesis directly after an IDENTIFIER character is a third. `node
 * --eval=require('node:child_process').spawnSync('pnpm', [])` writes its parentheses as part of a
 * call, where a shell sees a syntax error rather than a subshell -- and cutting there shredded the
 * injected program into fragments that named no command at all, which is how that exact spelling
 * walked past this analysis. `$(`, `=(` and ` (` are still the shell's own, and still cut.
 */
function splitCommands(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let assignmentDepth = 0;
  let callDepth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (quote !== null) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === "$" && text[i + 1] === "{") {
      const end = text.indexOf("}", i + 2);
      if (end >= 0) { cur += text.slice(i, end + 1); i = end; continue; }
    }
    if (c === "(" && cur.endsWith("=")) { assignmentDepth++; cur += c; continue; }
    if (c === ")" && assignmentDepth > 0) { assignmentDepth--; cur += c; continue; }
    if (c === "(" && /[A-Za-z0-9_.]$/.test(cur)) { callDepth++; cur += c; continue; }
    if (c === ")" && callDepth > 0) { callDepth--; cur += c; continue; }
    if (c === "\n" || c === ";" || c === "|" || c === "&" || "(){}".includes(c)) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Words that pass a command through unchanged: what follows is still a command. */
const NEUTRAL_PREFIX = new Set(["exec", "command", "nohup", "time", "builtin", "eval",
  "if", "elif", "while", "until", "then", "else", "do", "done", "fi", "!"]);
/** Words after which the rest is operands, not a command: a test expression or a word list. */
const TERMINAL_WORD = new Set(["[[", "[", "test", "for", "in", "case", "esac", "select", "local",
  "declare", "readonly", "export", "unset", "shift", "return", "trap", "echo", "printf", "read", "set"]);
const SHELLS = ["sh", "bash", "zsh", "dash", "ksh"];
/** A command-position VARIABLE — the shape `$PM run test` has. A fragment that merely contains
 *  `$` is a path or a substitution remnant, not a command name, and judging it is noise. */
const COMMAND_VARIABLE = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/;
/** Every shell expansion form, so what remains of a word can be judged on its own. */
const EXPANSION = /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?$!-]/g;
const withoutExpansions = (word: string): string => word.replace(EXPANSION, "");

/** A `-c` flag, alone or combined with other single letters: `-c`, `-ec`, `-ce`, `-euxc`. */
const SHELL_COMMAND_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;
/** `sudo` options that consume the following word, so the command is not the next token. */
const SUDO_OPTION_WITH_VALUE = new Set(["-u", "--user", "-g", "--group", "-p", "--prompt",
  "-C", "--close-from", "-h", "--host", "-U", "--other-user", "-r", "--role", "-t", "--type",
  "-T", "--command-timeout", "-R", "--chroot", "-D", "--chdir"]);
/** `xargs` options that consume the following word. Everything after them is the command. */
const XARGS_OPTION_WITH_VALUE = new Set(["-I", "-i", "-n", "-L", "-P", "-s", "-E", "-d", "-a",
  "--replace", "--max-args", "--max-lines", "--max-procs", "--max-chars", "--eof",
  "--delimiter", "--arg-file", "--process-slot-var"]);
/** The interpreters whose arguments say what actually runs. */
const NODE_COMMANDS = ["node", "nodejs"];

/** Drop options from an option-taking wrapper, so the head lands on the real command. */
function skipOptions(tokens: readonly string[], withValue: ReadonlySet<string>): string[] {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined || !token.startsWith("-") || token === "--") break;
    index += token.includes("=") || !withValue.has(token) ? 1 : 2;
  }
  return tokens.slice(index);
}

/**
 * NODE'S OWN OPTIONS, BY ARITY AND BY WHAT THE VALUE MEANS.
 *
 * Treating every dash-prefixed word as a valueless switch is what let `--require ./loader.cjs`,
 * `--import tsx`, `--loader=./loader.mjs` and `--eval <code>` stand in front of a canonical
 * governed entry and be excused by it: the walk stepped over the flag, found the entry, and
 * returned clean while Node was being told to run arbitrary code BEFORE that entry ever loaded.
 * Arity is therefore parsed, and a value is judged by what Node does with it.
 *
 *   CODE    the value IS a program (`--eval`, `--print`). It is analysed as one.
 *   MODULE  the value names something Node loads ahead of the entry (`--require`, `--import`,
 *           `--loader`, and `--env-file`, whose contents can set `NODE_OPTIONS` and so reach the
 *           same place). A known tool is that tool; anything else is code this analysis cannot
 *           read, and unreadable code ahead of the boundary fails closed.
 *   INERT   the value is data — a size, a pattern, a directory. Consumed, not judged.
 *
 * Everything else is a switch. A dash-word in NONE of these sets is an option whose arity is
 * unknown, and an unknown arity means the analysis cannot say which word is the script: that is
 * a finding, not a shrug. The lists are deliberately explicit — an option this repository never
 * writes is one this analysis has never had to be right about.
 */
const NODE_CODE_OPTIONS: ReadonlySet<string> = new Set(["--eval", "-e", "--print", "-p"]);
const NODE_MODULE_OPTIONS: ReadonlySet<string> = new Set(["--require", "-r", "--import", "--loader",
  "--experimental-loader", "--env-file", "--env-file-if-exists", "--experimental-config-file"]);
const NODE_INERT_VALUE_OPTIONS: ReadonlySet<string> = new Set(["--conditions", "-C", "--input-type",
  "--max-old-space-size", "--max-semi-space-size", "--stack-size", "--v8-pool-size", "--title",
  "--icu-data-dir", "--openssl-config", "--tls-cipher-list", "--tls-keylog", "--dns-result-order",
  "--unhandled-rejections", "--disable-proto", "--disable-warning", "--max-http-header-size",
  "--report-directory", "--report-filename", "--report-signal", "--diagnostic-dir",
  "--redirect-warnings", "--secure-heap", "--secure-heap-min", "--snapshot-blob",
  "--build-snapshot-config", "--heapsnapshot-signal", "--heapsnapshot-near-heap-limit",
  "--trace-event-categories", "--trace-event-file-pattern", "--cpu-prof-dir", "--cpu-prof-name",
  "--cpu-prof-interval", "--heap-prof-dir", "--heap-prof-name", "--heap-prof-interval",
  "--allow-fs-read", "--allow-fs-write", "--localstorage-file", "--watch-path", "--run",
  "--test-name-pattern", "--test-skip-pattern", "--test-reporter", "--test-reporter-destination",
  "--test-shard", "--test-concurrency", "--test-timeout", "--test-isolation",
  "--experimental-test-isolation", "--experimental-policy", "--policy-integrity"]);
const NODE_SWITCHES: ReadonlySet<string> = new Set(["--test", "--test-only", "--test-force-exit",
  "--test-update-snapshots", "--test-coverage-include", "--experimental-test-coverage", "--watch",
  "--watch-preserve-output", "--check", "-c", "--interactive", "-i", "--version", "-v", "--help",
  "-h", "--v8-options", "--no-warnings", "--warnings", "--trace-warnings", "--trace-deprecation",
  "--throw-deprecation", "--no-deprecation", "--pending-deprecation", "--trace-exit",
  "--trace-sync-io", "--trace-uncaught", "--trace-exit-code", "--track-heap-objects",
  "--zero-fill-buffers", "--abort-on-uncaught-exception", "--enable-source-maps",
  "--experimental-vm-modules", "--experimental-wasm-modules", "--experimental-import-meta-resolve",
  "--experimental-global-webcrypto", "--experimental-fetch", "--experimental-network-imports",
  "--experimental-permission", "--experimental-sqlite", "--experimental-strip-types",
  "--experimental-transform-types", "--experimental-detect-module", "--no-experimental-fetch",
  "--no-experimental-strip-types", "--allow-child-process", "--allow-worker", "--allow-addons",
  "--frozen-intrinsics", "--force-fips", "--enable-fips", "--use-openssl-ca", "--use-bundled-ca",
  "--use-largepages", "--openssl-legacy-provider", "--openssl-shared-config",
  "--force-node-api-uncaught-exceptions-policy", "--jitless", "--no-addons",
  "--no-force-async-hooks-checks", "--no-global-search-paths", "--preserve-symlinks",
  "--preserve-symlinks-main", "--prof", "--prof-process", "--cpu-prof", "--heap-prof",
  "--report-compact", "--report-on-fatalerror", "--report-on-signal", "--report-uncaught-exception",
  "--inspect", "--inspect-brk", "--inspect-wait", "--inspect-port", "--inspect-publish-uid",
  "--disallow-code-generation-from-strings", "--node-memory-debug", "--expose-gc",
  "--perf-basic-prof", "--perf-prof", "--stack-trace-limit"]);

/**
 * Code handed to Node on its own command line.
 *
 * `--eval` and `--print` are an execution surface with no file behind them, so the value is
 * analysed as the program it is. It is analysed WITHOUT the import-namespace requirement a source
 * file gets: a one-line snippet declares no bindings, and refusing to read
 * `require('node:child_process').spawnSync(…)` because nothing imported it is exactly how
 * `node --eval "require('node:child_process').spawnSync('pnpm', [])"` walked past this analysis.
 *
 * It is also read as a shell fragment. `--eval "pnpm run build"` is not valid JavaScript, and an
 * analysis that only ever parsed it as a program would let it through on the strength of being
 * malformed; what the author wrote is a command, and it is judged as one.
 *
 * A value that is not READABLE is a different matter from a value that resolves to nothing. An
 * empty snippet, or one still carrying a shell expansion or substitution, is code this analysis
 * cannot see, and code it cannot see running ahead of a governed entry fails closed. A snippet it
 * can read in full and finds no tool in is exactly what it looks like: inert.
 */
function analyseInjectedCode(code: string, raw: string, depth: number): Finding[] {
  if (depth > 3) return [finding("unresolved-command", raw)];
  if (code.trim().length === 0 || /[$`]/.test(code)) return [finding("unresolved-command", raw)];
  const findings: Finding[] = [
    ...analyseProgram(code, depth + 1),
    ...analyseShell(code, new Map(), depth + 1, false),
  ].map((f) => finding(f.kind.replace(/^literal-/, ""), raw));
  // A snippet declares no imports, so the namespace a source file is judged through does not
  // exist here. `require('node:child_process').spawnSync('pnpm', …)` is read on its own terms.
  for (const m of code.matchAll(/\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*(?:\?\.)?\s*\(([^,)]*)/g)) {
    // A shell tokeniser has already stripped the snippet's own quotes by the time a command line
    // reaches here, so an argument that folds to nothing is still read as the bare word it is.
    const bare = (m[1] ?? "").trim().replace(/^["'`]|["'`]$/g, "");
    const command = fold(m[1] ?? "", new Map()) ?? bare;
    if (isUngoverned(command)) findings.push(finding(`ungoverned-command:${baseOf(command)}`, raw));
  }
  return findings;
}

/**
 * Analyse a `node` invocation's ARGUMENTS.
 *
 * Node is not a package manager, so an analysis that stopped at the executable saw nothing wrong
 * with `node --import tsx src/server.ts` — which is a `tsx` loader start-up, cache and all — or
 * with `node --no-warnings scripts/trio/…`, where checking only the first argument missed the
 * entry entirely. Every argument is inspected instead, in Node's own grammar: options first, each
 * consuming the values it really consumes, then the script, then the script's own operands.
 *
 * The first non-option word that is a canonical governed entry ENDS the option walk. That word is
 * the boundary, and what it goes on to run is governed by construction — which is precisely why
 * the word has to be the proven canonical file and not merely something ending in the right name.
 * Findings already made by the options AHEAD of it are kept, not discarded: a loader that ran
 * before the entry ran before the boundary existed.
 */
function analyseNodeArguments(tokens: readonly string[], raw: string, depth = 0): Finding[] {
  const findings: Finding[] = [];
  let optionsDone = false;
  let scriptSeen = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (!scriptSeen) {
      if (!optionsDone && token === "--") { optionsDone = true; continue; }
      // `node -` reads the program from standard input: a script this analysis can never see.
      if (!optionsDone && token === "-") { findings.push(finding("unresolved-command", raw)); return findings; }
      if (!optionsDone && token.startsWith("-")) {
        const equals = token.indexOf("=");
        const name = equals >= 0 ? token.slice(0, equals) : token;
        const inline = equals >= 0 ? token.slice(equals + 1) : undefined;
        const code = NODE_CODE_OPTIONS.has(name);
        const module_ = NODE_MODULE_OPTIONS.has(name);
        const inert = NODE_INERT_VALUE_OPTIONS.has(name);
        if (!code && !module_ && !inert) {
          if (!NODE_SWITCHES.has(name)) { findings.push(finding("unresolved-command", raw)); return findings; }
          if (inline !== undefined && isUngoverned(inline))
            findings.push(finding(`ungoverned-command:${baseOf(inline)}`, raw));
          continue;
        }
        let value = inline;
        if (value === undefined) { value = tokens[index + 1]; index += 1; }
        if (value === undefined) { findings.push(finding("unresolved-command", raw)); return findings; }
        if (code) { findings.push(...analyseInjectedCode(value, raw, depth)); continue; }
        if (isUngoverned(value)) { findings.push(finding(`ungoverned-command:${baseOf(value)}`, raw)); continue; }
        // A module Node loads before the entry is code with a name this analysis cannot read.
        if (module_) findings.push(finding("unresolved-command", raw));
        continue;
      }
      if (isGovernedEntry(token)) return findings;
      scriptSeen = true;
    }
    if (isUngoverned(token)) findings.push(finding(`ungoverned-command:${baseOf(token)}`, raw));
  }
  return findings;
}

/**
 * Analyse ONE command, given as tokens.
 *
 * Wrappers are peeled recursively rather than in a fixed order, because they nest: `xargs sh -c`
 * is an `xargs` whose command is a shell whose command is a string. Peeling once and falling
 * through — which is what the earlier straight-line version did — analysed `sh` as if it were
 * the command and never looked inside it.
 */
function analyseCommandTokens(
  initial: readonly string[],
  symbols: Map<string, string>,
  depth: number,
  raw: string,
): Finding[] {
  if (depth > 6) return [finding("unresolved-command", raw)];
  let tokens = [...initial];
  while (tokens[0] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    const equals = tokens[0].indexOf("=");
    symbols.set(tokens[0].slice(0, equals), unquote(tokens[0].slice(equals + 1)));
    tokens = tokens.slice(1);
  }
  // `env` additionally carries its own assignments and flags; the neutral words do not, so a
  // flag after one of them is an operand of the NEXT command, not something to skip past.
  for (;;) {
    const word = tokens[0];
    if (word === undefined) break;
    if (baseOf(word) === "env") {
      tokens = tokens.slice(1);
      while (tokens[0] !== undefined && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) || tokens[0].startsWith("-"))) tokens = tokens.slice(1);
      continue;
    }
    if (NEUTRAL_PREFIX.has(word)) { tokens = tokens.slice(1); continue; }
    break;
  }
  const head = tokens[0];
  if (head === undefined) return [];
  if (TERMINAL_WORD.has(head)) return [];

  // `sudo -u nobody pnpm run build`: the command is not the next token, it is the one after the
  // options and their values. Treating `sudo` as a plain pass-through read `-u` as the command.
  if (baseOf(head) === "sudo" || baseOf(head) === "doas") {
    return analyseCommandTokens(skipOptions(tokens.slice(1), SUDO_OPTION_WITH_VALUE), symbols, depth + 1, raw);
  }
  if (baseOf(head) === "xargs") {
    return analyseCommandTokens(skipOptions(tokens.slice(1), XARGS_OPTION_WITH_VALUE), symbols, depth + 1, raw);
  }
  if (SHELLS.includes(baseOf(head))) {
    const flag = tokens.findIndex((token, index) => index > 0 && SHELL_COMMAND_FLAG.test(token));
    const inner = flag >= 0 ? tokens[flag + 1] : undefined;
    if (inner !== undefined) return analyseShell(unquote(inner), symbols, depth + 1);
  }
  if (isGovernedEntry(head)) return [];
  if (NODE_COMMANDS.includes(baseOf(head))) return analyseNodeArguments(tokens.slice(1), raw, depth);

  let resolved: string = head;
  const seen = new Set<string>();
  for (;;) {
    const name = resolved.replace(/^\$\{?/, "").replace(/\}$/, "");
    const next = symbols.get(name);
    if (next === undefined || seen.has(name)) break;
    seen.add(name);
    resolved = next;
  }
  if (COMMAND_VARIABLE.test(resolved)) return [finding("unresolved-command", raw)];
  if (isUngoverned(resolved)) return [finding(`ungoverned-command:${baseOf(resolved)}`, raw)];
  // A command name ASSEMBLED from an expansion is a name this analysis cannot read, and skipping
  // it was fail-open. What is left once the expansions are removed decides which case it is: a
  // remaining PATH means a real command is being built out of a value, and its identity is
  // unknown, so it fails closed. A head that is nothing but an expansion names no command at all
  // -- it is a test expression's operand or a fragment -- and judging it would be noise.
  if (/[$`]/.test(resolved) && withoutExpansions(resolved).includes("/"))
    return [finding("unresolved-command", raw)];
  return [];
}

/**
 * Extract `$( … )` and backtick command substitutions. Their contents are commands too.
 *
 * `echo $(pnpm run build)` used to be caught only as a side effect of splitting on parentheses,
 * and the backtick spelling of the very same thing was caught by nothing at all. Both are
 * extracted here and analysed as commands in their own right, and a substitution that never
 * closes is reported rather than ignored.
 */
function extractSubstitutions(fragment: string): { stripped: string; inner: string[]; unterminated: boolean } {
  const inner: string[] = [];
  let stripped = "";
  let unterminated = false;
  let singleQuoted = false;
  for (let i = 0; i < fragment.length; i++) {
    const c = fragment[i] ?? "";
    if (c === "'") { singleQuoted = !singleQuoted; stripped += c; continue; }
    if (!singleQuoted && c === "`") {
      const end = fragment.indexOf("`", i + 1);
      if (end < 0) { unterminated = true; break; }
      inner.push(fragment.slice(i + 1, end));
      i = end;
      stripped += " ";
      continue;
    }
    if (!singleQuoted && c === "$" && fragment[i + 1] === "(") {
      const end = matchingIndex(fragment, i + 1);
      if (end < 0) { unterminated = true; break; }
      inner.push(fragment.slice(i + 2, end));
      i = end;
      stripped += " ";
      continue;
    }
    stripped += c;
  }
  return { stripped, inner, unterminated };
}

/**
 * Analyse a shell fragment IN ORDER, accumulating the symbols it defines as it goes, so that a
 * variable, an alias and a function body are each resolved to the command they actually run.
 */
function analyseShell(
  fragment: string,
  inherited: ReadonlyMap<string, string> = new Map(),
  depth = 0,
  substitutions = true,
): Finding[] {
  if (depth > 6) return [finding("unresolved-command", fragment)];
  // Substitution is SHELL syntax, and it is only read where the text is shell. A free-standing
  // string literal in a program is prose far more often than it is a command, and there a
  // backtick is markdown inline code -- `tsc -p …` inside an English sentence about a different
  // repository is documentation, not an execution path. Reading it as substitution there would
  // be exactly the indiscriminate rejection this analysis is supposed to avoid.
  const extracted = substitutions
    ? extractSubstitutions(fragment)
    : { stripped: fragment, inner: [] as string[], unterminated: false };
  const { stripped, inner, unterminated } = extracted;
  const findings: Finding[] = [];
  if (unterminated) findings.push(finding("unresolved-command", fragment));
  const symbols = new Map(inherited);
  for (const substitution of inner) findings.push(...analyseShell(substitution, symbols, depth + 1));
  for (const raw of splitCommands(stripped)) {
    const tokens = tokenise(raw);
    if (tokens[0] === "alias" && tokens[1]?.includes("=")) {
      const eq = tokens[1].indexOf("=");
      symbols.set(tokens[1].slice(0, eq), unquote([tokens[1].slice(eq + 1), ...tokens.slice(2)].join(" ")).split(/\s+/)[0] ?? "");
      continue;
    }
    findings.push(...analyseCommandTokens(tokens, symbols, depth, raw));
  }
  return findings;
}

/**
 * A `#!` line is an execution path: the file names its own interpreter, and `#!/usr/bin/env tsx`
 * starts a loader exactly as a command line would. Analysed for every scanned file rather than
 * only for the ones currently carrying the executable bit, because a mode is not a commitment.
 */
function analyseShebang(source: string): Finding[] {
  if (!source.startsWith("#!")) return [];
  const line = source.slice(2).split("\n")[0] ?? "";
  return analyseShell(line);
}

/** npm-family sub-commands that make the following word an invocation rather than prose. */
const MANAGER_VERBS = new Set(["run", "test", "start", "install", "ci", "exec", "add", "remove", "build",
  "dlx", "create", "init", "publish", "pack", "why", "link", "enable", "prepare", "up", "update"]);

/**
 * Does this text read as a command INVOCATION rather than prose that happens to open with a tool
 * name? Used only for free-standing string literals and documents; the manifest, descriptor and
 * spawn channels are unconditional.
 */
function looksLikeInvocation(text: string): boolean {
  const parts = text.trim().split(/\s+/);
  const head = baseOf(parts[0] ?? "");
  const next = parts[1];
  if (next === undefined) return false;
  if (["npm", "pnpm", "yarn"].includes(head)) return MANAGER_VERBS.has(next) || next.startsWith("-");
  if (["npx", "corepack"].includes(head)) return /^[\w@.-]+$/.test(next);
  if (["tsc", "tsx"].includes(head)) return next.startsWith("-") || next.includes("/") || /\.[cm]?[jt]sx?$/.test(next);
  return true;
}

// ─── Program analysis: constant folding, so construction cannot hide a name ───

const STRING_LITERAL = /^(?:'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`$\\]*(?:\\.[^`$\\]*)*)`)$/;

function matchingIndex(source: string, start: number): number {
  const open = source[start] ?? "";
  const close = { "(": ")", "[": "]", "{": "}" }[open] ?? "";
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i++) {
    const c = source[i] ?? "";
    if (quote !== null) { if (c === quote && source[i - 1] !== "\\") quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Split on a top-level operator, ignoring brackets and strings. */
function splitTop(text: string, op: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (quote !== null) { cur += c; if (c === quote && text[i - 1] !== "\\") quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; cur += c; continue; }
    if ("([{".includes(c)) { depth++; cur += c; continue; }
    if (")]}".includes(c)) { depth--; cur += c; continue; }
    if (depth === 0 && c === op) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Fold an expression to a literal string when that is statically decidable, else undefined. */
function fold(expression: string, consts: ReadonlyMap<string, string>, depth = 0): string | undefined {
  const text = expression.trim();
  if (depth > 8 || text.length === 0) return undefined;
  const literal = STRING_LITERAL.exec(text);
  if (literal) return (literal[1] ?? literal[2] ?? literal[3] ?? "").replace(/\\(.)/g, "$1");
  const join = /^\[([\s\S]*)\]\s*\.join\(([^)]*)\)$/.exec(text);
  if (join) {
    const separator = (join[2] ?? "").trim().length > 0 ? fold(join[2] ?? "", consts, depth + 1) : ",";
    if (separator === undefined) return undefined;
    const parts = splitTop(join[1] ?? "", ",").map((p) => fold(p, consts, depth + 1));
    return parts.some((p) => p === undefined) ? undefined : parts.join(separator);
  }
  const summands = splitTop(text, "+");
  if (summands.length > 1) {
    const parts = summands.map((p) => fold(p, consts, depth + 1));
    return parts.some((p) => p === undefined) ? undefined : parts.join("");
  }
  if (text.startsWith("(") && matchingIndex(text, 0) === text.length - 1) return fold(text.slice(1, -1), consts, depth + 1);
  const bound = /^[A-Za-z_$][\w$]*$/.test(text) ? consts.get(text) : undefined;
  return bound === undefined ? undefined : fold(bound, consts, depth + 1);
}

/**
 * Command expressions that name the running Node binary.
 *
 * These are not package managers, so the command itself is fine — but what Node is TOLD to run
 * is the whole question, and the earlier analysis accepted the executable and discarded the
 * argument list. `spawnSync(process.execPath, ["--import", "tsx", …])` is a `tsx` start-up
 * spelled without ever writing the word in command position.
 */
const NODE_COMMAND_EXPRESSION = [/^process\.execPath$/, /^process\.argv\[0\]$/, /^execPath$/, /^resolved\.node$/, /^runtime\.node$/];
/** A first argument that is a parameter declaration is a signature, not a call. */
const PARAMETER_DECLARATION = /^[A-Za-z_$][\w$]*\s*\??:/;

const SPAWN_APIS = ["spawn", "spawnSync", "execFile", "execFileSync", "fork"];
const SHELL_APIS = ["exec", "execSync"];

/**
 * The names this module binds `node:child_process` to.
 *
 * Qualified calls are recognised only through them. Matching any `x.exec(` would sweep in every
 * `RegExp.prototype.exec` in the tree and judge its subject as a command, which is noise, not
 * analysis; matching only the names that actually hold the child-process module catches
 * `cp.spawnSync(…)` and `cp.spawn?.(…)` without inventing findings out of unrelated source text.
 */
function childProcessNamespaces(code: string): string[] {
  const names = new Set<string>();
  for (const m of code.matchAll(/import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s*["'](?:node:)?child_process["']/g)) {
    if (m[1] !== undefined) names.add(m[1]);
  }
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:require|import)\s*\(\s*["'](?:node:)?child_process["']\s*\)/g)) {
    if (m[1] !== undefined) names.add(m[1]);
  }
  return [...names].sort();
}

/**
 * Fold a Node argv to the words it will really contain, or to nothing at all.
 *
 * The earlier fold kept the elements it could read and silently dropped the ones it could not, so
 * `["--import", loader, "src/server.ts"]` became `["--import", "src/server.ts"]` — an argv nobody
 * wrote, missing exactly the word that decided what Node loaded. And an argv that was not a
 * literal at all, `process.argv.slice(2)`, folded to the empty list, which read as "node with no
 * arguments" and passed.
 *
 * A hole is therefore FATAL while Node's own options are still being read, because a hole there
 * could be `--require`, or the module `--require` loads. Once the script word has been seen the
 * remaining words belong to the script rather than to Node, and a hole among them says nothing
 * about what Node was told to load.
 */
function foldNodeArgv(expression: string | undefined, consts: ReadonlyMap<string, string>): string[] | undefined {
  if (expression === undefined) return undefined;
  let text = expression.trim();
  for (let hops = 0; hops < 8 && /^[A-Za-z_$][\w$]*$/.test(text); hops++) {
    const bound = consts.get(text);
    if (bound === undefined) return undefined;
    text = bound.trim();
  }
  const array = /^\[([\s\S]*)\]$/.exec(text);
  if (array === null) return undefined;
  const out: string[] = [];
  let scriptSeen = false;
  for (const part of splitTop(array[1] ?? "", ",")) {
    const folded = fold(part, consts);
    if (folded === undefined) {
      if (!scriptSeen) return undefined;
      continue;
    }
    if (!folded.startsWith("-")) scriptSeen = true;
    out.push(folded);
  }
  return out;
}

function analyseProgram(source: string, depth = 0): Finding[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const findings: Finding[] = [];
  const consts = new Map<string, string>();
  for (const m of code.matchAll(/(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n;]+)[;\n]/g)) {
    if (m[1] !== undefined && m[2] !== undefined) consts.set(m[1], m[2].trim());
  }
  const namespaces = childProcessNamespaces(code);
  const qualifier = namespaces.length > 0 ? `(?:(?:${namespaces.join("|")})\\s*\\??\\.\\s*)?` : "";
  const callsTo = (name: string): { first: string; args: string[] }[] => {
    const out: { first: string; args: string[] }[] = [];
    // The trailing `(?:\?\.)?` is optional-call syntax: `cp.spawn?.("pnpm", [])` runs exactly
    // what `cp.spawn("pnpm", [])` runs, and reached the same child through a regex that did not.
    const re = new RegExp(`(?:^|[^\\w$.])${qualifier}${name}\\s*(?:\\?\\.)?\\s*\\(`, "g");
    for (let m = re.exec(code); m !== null; m = re.exec(code)) {
      const open = code.indexOf("(", m.index + m[0].length - 1);
      const close = matchingIndex(code, open);
      if (close < 0) continue;
      const args = splitTop(code.slice(open + 1, close), ",");
      const first = args[0];
      if (first !== undefined) out.push({ first, args });
      re.lastIndex = close;
    }
    return out;
  };
  for (const api of SPAWN_APIS) {
    for (const call of callsTo(api)) {
      if (PARAMETER_DECLARATION.test(call.first)) continue;
      const folded = fold(call.first, consts);
      const isNode = folded === undefined
        ? NODE_COMMAND_EXPRESSION.some((re) => re.test(call.first))
        : NODE_COMMANDS.includes(baseOf(folded));
      if (isNode) {
        const argv = foldNodeArgv(call.args[1], consts);
        if (argv === undefined) findings.push(finding("unresolved-command", call.first));
        else findings.push(...analyseNodeArguments(argv, call.first, depth));
        continue;
      }
      if (folded !== undefined) {
        if (isGovernedEntry(folded)) continue;
        if (isUngoverned(folded)) findings.push(finding(`ungoverned-command:${baseOf(folded)}`, call.first));
        continue;
      }
      findings.push(finding("unresolved-command", call.first));
    }
  }
  for (const api of SHELL_APIS) {
    for (const call of callsTo(api)) {
      if (PARAMETER_DECLARATION.test(call.first)) continue;
      const folded = fold(call.first, consts);
      if (folded === undefined) { findings.push(finding("unresolved-command", call.first)); continue; }
      findings.push(...analyseShell(folded));
    }
  }
  // Construction: a name assembled from pieces is the same name.
  for (const m of code.matchAll(/\[[^[\]\n]*\]\s*\.join\([^)]*\)/g)) {
    const folded = fold(m[0], consts);
    if (folded !== undefined && isUngoverned(folded)) findings.push(finding(`ungoverned-command:${baseOf(folded)}`, m[0]));
  }
  for (const m of code.matchAll(/(["'`][^"'`\n]*["'`](?:\s*\+\s*(?:["'`][^"'`\n]*["'`]|[A-Za-z_$][\w$]*))+)/g)) {
    const folded = fold(m[0], consts);
    if (folded !== undefined && isUngoverned(folded)) findings.push(finding(`ungoverned-command:${baseOf(folded)}`, m[0]));
  }
  // A command spelled out inside a literal is a call path too — help text teaches it to a human.
  for (const m of code.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
    const literal = m[2] ?? "";
    if (literal.length < 4 || literal.length > 400) continue;
    for (const f of analyseShell(literal, new Map(), depth, false)) {
      if (f.kind.startsWith("ungoverned-command:") && looksLikeInvocation(f.text)) {
        findings.push(finding(`literal-${f.kind}`, f.text));
      }
    }
  }
  return findings;
}

function analyseManifest(source: string): Finding[] {
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { return [finding("unresolved-command", "unparsable manifest")]; }
  const scripts = (parsed as { scripts?: Record<string, unknown> } | null)?.scripts;
  if (scripts === undefined || scripts === null || typeof scripts !== "object") return [];
  const findings: Finding[] = [];
  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value !== "string") { findings.push(finding("unresolved-command", `scripts.${name}`)); continue; }
    for (const f of analyseShell(value)) findings.push(finding(f.kind, `scripts.${name}: ${value}`));
  }
  return findings;
}

const UNIT_DIRECTIVE = /^\s*(?:ExecStart|ExecStartPre|ExecStartPost|ExecStop|ExecReload|ExecCondition)\s*=\s*[-@+!]*(.*)$/;
const DESCRIPTOR_COMMAND = /^\s*-?\s*(?:run|command|cmd|entrypoint|args)\s*:\s*(.*)$/;

/** `command: [pnpm, run, build]` — a descriptor's argv, written as a list. */
const INLINE_ARRAY = /^\[([\s\S]*)\]$/;

function analyseDescriptor(source: string): Finding[] {
  const findings: Finding[] = [];
  for (const line of source.split("\n")) {
    const matched = UNIT_DIRECTIVE.exec(line) ?? DESCRIPTOR_COMMAND.exec(line);
    const raw = (matched?.[1] ?? "").trim();
    if (raw.length === 0) continue;
    // An argv list is a structure, not a sentence. Stripping its brackets and handing the rest
    // to a shell tokeniser produced the token `pnpm,` — a name that matches nothing — so the
    // elements are split on the list's own separator and unquoted individually instead.
    const array = INLINE_ARRAY.exec(raw);
    if (array !== null) {
      const tokens = splitTop(array[1] ?? "", ",").map(unquote).filter((token) => token.length > 0);
      for (const f of analyseCommandTokens(tokens, new Map(), 0, raw)) findings.push(finding(f.kind, line));
      continue;
    }
    const command = raw.replace(/^["']|["']$/g, "");
    if (command.length === 0) continue;
    for (const f of analyseShell(command)) findings.push(finding(f.kind, line));
  }
  return findings;
}

/** Documents teach commands. Only fenced blocks and shell prompts are commands. */
function analyseDocument(source: string): Finding[] {
  const findings: Finding[] = [];
  const consider = (fragment: string): void => {
    for (const f of analyseShell(fragment)) {
      if (f.kind.startsWith("ungoverned-command:") && looksLikeInvocation(f.text)) findings.push(f);
    }
  };
  for (const m of source.matchAll(/```(?:[a-zA-Z]*)\n([\s\S]*?)```/g)) consider(m[1] ?? "");
  for (const m of source.matchAll(/^\s*>?\s*\$\s+(\S.*)$/gm)) consider(m[1] ?? "");
  return findings;
}

/** Every governed file type, and the analysis that is appropriate to it. */
const EXECUTION_ANALYSES: readonly (readonly [RegExp, (source: string) => Finding[]])[] = [
  [/(?:^|\/)package\.json$/, analyseManifest],
  [/\.(sh|bash)$/, (s) => analyseShell(s.replace(/(^|\s)#[^\n]*/g, "$1"))],
  [/\.(ts|tsx|mts|cts|mjs|cjs|js|py)$/, analyseProgram],
  [/\.(service|conf|ya?ml)$/, analyseDescriptor],
  [/\.md$/, analyseDocument],
];

function analyseExecution(file: string, source: string): Finding[] {
  const chosen = EXECUTION_ANALYSES.find(([pattern]) => pattern.test(file));
  const byType = chosen === undefined ? [] : chosen[1](source);
  return [...analyseShebang(source), ...byType];
}

/**
 * Declared ungoverned-execution findings, anchored by content.
 *
 * Each entry pins the SHA-256 of `${kind}\n${text}` for every finding the file is allowed to
 * produce. A new finding, a changed command, or a removed one fails this suite until the
 * declaration is updated deliberately. There is no pathname exemption: a declared file is
 * exempt for exactly the findings it declares and for nothing else.
 */
const UNGOVERNED_EXECUTION_DECLARATIONS: ReadonlyArray<readonly [string, DeclaredException]> = [
  ["docs/trio/TRIO-000-CONTAINMENT-REPORT.md", {
    reason: "an inert historical record; the quoted verification predates this boundary and is not a call path",
    lineDigests: [
      "5a38692230829beac4611434ebc187acee02174b548086ecc847c6cfc8ce1fde",
    ],
  }],
  ["interview-demo-" + "factory/demos/001-ikbi-osapa-proof/luna-smoke-test.md", {
    reason: "inert demo runbook for a separate project's repository (loony-luna-only)",
    lineDigests: [
      "6091fb53186c00f64a068e4d61a3190d7b3c2a95d3e24199ec98412c636ee88d",
    ],
  }],
  ["interview-demo-" + "factory/demos/001-ikbi-osapa-proof/receipts/commands-run.md", {
    reason: "an inert receipt recording what a demo run executed; a record, not a call path (loony-luna-only)",
    lineDigests: [
      "0ff84fc6af40576fc9e14f60f2f73f32f467d77b38af2812324087e242f20b4d",
    ],
  }],
  ["interview-demo-" + "factory/demos/001-ikbi-osapa-proof/terminal-runbook.md", {
    reason: "inert demo runbook for a separate project's repository (loony-luna-only)",
    lineDigests: [
      "31def17fd4cf4f0cbc64b50267bd3bc418148384524cdc5533bc74ee92997f9b",
      "40317744494214018575819180bcee96d3794d82e71ab33e2cdce7f209294564",
      "7b3a349e19c92c74e6a0137726666ce24d4dae2f8a8e8ce5bfb503173047be87",
      "efba5cb1f59b5d3e0e6991e728d48f8691122e78d9b7220cf235d98b431a099b",
    ],
  }],
  ["interview-demo-" + "factory/scripts/assemble-demo.sh", {
    reason: "owner-scoped demo tooling that builds command paths out of its own location; unresolvable here (loony-luna-only)",
    lineDigests: [
      "1856dda2e6a5898b4893a5a39014468cb908fb20808091cd9fae3ca23f04394c",
      "9a640f33e7f48c3b1f0282e907e75b0a0b80b9ebd18eb105c468858ac029b98a",
    ],
  }],
  ["runtime/server/truth-agent-adapter.ts", {
    reason: "the Truth adapter runs the verifier module Node-side through a path resolved at run time from the adapter's configuration; the script is a runtime value, not a committed spelling",
    lineDigests: [
      "e3621da1adaad0f98f143f8a4fc0f5ddcb954f7e2f259036f160e8e723abe28e",
    ],
  }],
  ["scripts/trio/governed-run.mjs", {
    reason: "THE governed spawn: the command is the caller's by design, and it is spawned only after the private run directory exists",
    lineDigests: [
      "9729feda099deecf88b58b550125148d442ad8f40b125fb3ace3c1bbe496ddf8",
    ],
  }],
  ["skills/ptah-occasio/SKILL.md", {
    reason: "skill prose describing a command in a DIFFERENT project's repository; inert here (mad-ptah-only)",
    lineDigests: [
      "b6b961332f6dd94668af297a311f838b8f814d247a4a17472ddb9b1ccb5efbee",
    ],
  }],
  ["src/core/agent-tools/delegate-tools.ts", {
    reason: "the agent's delegation surface spawns a caller-chosen executable; the command is runtime data, not a committed call path",
    lineDigests: [
      "8e6d52e9af5b26cbdb07afdb3c916501d49009ece4906f8b8bddb6d936fec7ad",
    ],
  }],
  ["src/core/ssh-broker-hostile.test.ts", {
    reason: "the SSH hostile suite spawns what wrap() returned, to prove the brokered policy denies a host unix socket",
    lineDigests: [
      "248c5594f3bbb955daa806b9fe24fe1fec209c21e362b071dfb1d68c673214f7",
    ],
  }],
  ["src/core/containment-wiring.test.ts", {
    reason: "the wiring proof spawns what wrap() returns, and once uncontained on purpose so the contained control has a positive control to be measured against",
    lineDigests: [
      "248c5594f3bbb955daa806b9fe24fe1fec209c21e362b071dfb1d68c673214f7",
      "ea9c5b552e38950a2d998026fc729d03492274ea553478a66de6a51ef0150dd9",
    ],
  }],
  ["src/core/containment/conformance.ts", {
    reason: "the live controls run a command under the boundary to prove the kernel enforced it; the binary is whatever wrap() returned",
    lineDigests: [
      "a0d4b98f95956f7d5810e333947df24a58d6c0decc7880510cc47bc876f71928",
      "ccc3e2b8a18ad638b681540db953e34f9c668693c7e9d2fa2822e761dd2a7061",
    ],
  }],
  ["src/core/agent-tools/execute-code-tools.ts", {
    reason: "the code-execution surface spawns what the containment authority returns -- bwrap, or the interpreter when the boundary is off; wrap() decides the binary, never the caller",
    lineDigests: [
      "248c5594f3bbb955daa806b9fe24fe1fec209c21e362b071dfb1d68c673214f7",
    ],
  }],
  ["src/core/agent-tools/ikbi-tools.test.ts", {
    reason: "inert fixture data describing a remote check command; never executed here",
    lineDigests: [
      "14ee6105f62cbba9ab5d6698c1e702064d3c31646cfeef233e4b5c607b30b5f2",
    ],
  }],
  ["src/core/agent-tools/lab-shell-tools.ts", {
    reason: "the lab read-seam spawns what the containment authority returns; the ssh argv is validated above and wrap() decides the binary, never the caller",
    lineDigests: [
      "248c5594f3bbb955daa806b9fe24fe1fec209c21e362b071dfb1d68c673214f7",
    ],
  }],
  ["src/core/agent-tools/phone-tools.ts", {
    reason: "the agent's phone-bridge surface spawns a caller-chosen executable",
    lineDigests: [
      "8e6d52e9af5b26cbdb07afdb3c916501d49009ece4906f8b8bddb6d936fec7ad",
    ],
  }],
  ["src/core/governed-launch-regression.test.ts", {
    reason: "the T21 plant matrix and the T6/T19 controls: every enumerated bypass class, spelled out so it can be planted and caught, plus the fixture paths it hands to Node at run time",
    lineDigests: [
      "0031ee996876befce433d9ab86746e24af7249e00ee055262670ff09fe675c63",
      "1cb01bff91c500af7f7ba9bc2011343dafa828330d2348316d8ce9f96b1d8c82",
      "20701de1c84f60cf37d2fe2f1862c46f99bfbf59cf029cd128fc65524b415863",
      "26f79f0f0ae20943b1d2093e799e3e44c6e0c93fc04c58fc209d3e61fc329dea",
      "38bc229744bcb9fd39946123d8ed40108f8f9549f1b3a40b4827d6683b39e533",
      "48df4b7336ab3c03d13aaa0fea214fd41a40670db5a8378488bbd53494dfe8a2",
      "6a047717abdeb39fca6d8c6222ba8b7e458fa7ab56fffe2ab75b54ddf626d2dc",
      "7e5e2f08b90648785c8b2e2048ac029204001cc2f1e0427f04f49093393c2b57",
      "879902e25fd9a6c2b50d501e56f8855041697f4978c2e1bc65ed2a4ddc248e14",
      "a3334cf18512ac130eb8467254a7b6836234df8faf7dfa3b5b54c8b2c5b46c09",
      "aa2d3476fba03ad401608760d1bf060ec1ad4b63e34b8efba6bd4baa9c1f9a49",
      "ac7919fa4af1d5a0a23000616c676056d2d8729a995e308269b4b3e51f69bfd9",
      "b93f145bc6d5a5807656f14b4df20552002cf250ebf009c3f84022dca490b82f",
      "bba6902a5aca04ceffe18e12d076a4937fa391eb1d9d26b2cf0d1934a5d75045",
      "c044625927256a4d14a9a7f8d364977570bc8fa7f52fdff68e14182d05d01a24",
    ],
  }],
  ["src/core/process-registry.ts", {
    reason: "the background-process registry spawns a caller-chosen executable and records it",
    lineDigests: [
      "9729feda099deecf88b58b550125148d442ad8f40b125fb3ace3c1bbe496ddf8",
    ],
  }],
  ["src/core/temp-authority.test.ts", {
    reason: "an adversarial fixture starts the loader on purpose, to prove the authority refuses ungoverned storage, and hands Node a fixture path built at run time",
    lineDigests: [
      "6a047717abdeb39fca6d8c6222ba8b7e458fa7ab56fffe2ab75b54ddf626d2dc",
      "a3334cf18512ac130eb8467254a7b6836234df8faf7dfa3b5b54c8b2c5b46c09",
    ],
  }],
  ["src/core/temp-policy.test.ts", {
    reason: "this analysis's own self-test: every construction it claims to resolve, and every hostile form it claims to catch, spelled out so neither claim is vacuous",
    lineDigests: [
      "08d60d6ad63d5a4f80cdb1eb65d1dc241744f27f8baf0ae65bc5ed6eda112c45",
      "1042a402798c8326fa1a1aad80690355f85bc3476d567993fe50021f329be83c",
      "10d867f35a556569e3eaf19d823d4b44aadd654c49a81889e72cc371118c91a0",
      "1b2266a448fdd87f944a81cfe1712253c239862c157dc2251c3f6c03ebfdbafc",
      "1cb01bff91c500af7f7ba9bc2011343dafa828330d2348316d8ce9f96b1d8c82",
      "2592001142945d2c0d83f911f7c51e65eee611e6a838121dc0d647089bd2efd2",
      "26f79f0f0ae20943b1d2093e799e3e44c6e0c93fc04c58fc209d3e61fc329dea",
      "31ae423386cbe084317633ae8ac9c6822c6c04fd1209cdaaa6a1d2c921bd7cb2",
      "38bc229744bcb9fd39946123d8ed40108f8f9549f1b3a40b4827d6683b39e533",
      "48df4b7336ab3c03d13aaa0fea214fd41a40670db5a8378488bbd53494dfe8a2",
      "568a35a73b1d822644387bcbf3d3d70320b8a2405a4d986350ef3b9c60a64a10",
      "5e6224ee2596f7a0d9ce951555d0cb5e46c68102ab4ff6b378a539f7da283f18",
      "6a047717abdeb39fca6d8c6222ba8b7e458fa7ab56fffe2ab75b54ddf626d2dc",
      "7e5e2f08b90648785c8b2e2048ac029204001cc2f1e0427f04f49093393c2b57",
      "879902e25fd9a6c2b50d501e56f8855041697f4978c2e1bc65ed2a4ddc248e14",
      "88342f540bcf3bb9c1dedddf7c6327c37cb7a549045eff5fe041c13d9b464f12",
      "8c850f6cf8d0006e2db3193462d8fe149f5b2d7f8e23437f01964d909827e4c2",
      "a3334cf18512ac130eb8467254a7b6836234df8faf7dfa3b5b54c8b2c5b46c09",
      "aa2d3476fba03ad401608760d1bf060ec1ad4b63e34b8efba6bd4baa9c1f9a49",
      "ac7919fa4af1d5a0a23000616c676056d2d8729a995e308269b4b3e51f69bfd9",
      "af620e6ca5c711e99556a15f0e21998467749e63fe134c66dd795e9a9f36f01a",
      "b581fa709425fec09985186ac4d37b729aaf4ed5c80cfde0c480607cd4ec8692",
      "b93f145bc6d5a5807656f14b4df20552002cf250ebf009c3f84022dca490b82f",
      "bba6902a5aca04ceffe18e12d076a4937fa391eb1d9d26b2cf0d1934a5d75045",
      "c402b24004332deacb2346c2d58e941695a008c70710474b0aaef09907392be2",
      "e24c41c7f688b91c3685b67acd2efc9875909e688c87c1ca9f3b792e45b9dae3",
      "f89aec536e0d8bd4f6dcb279bedfe3de48bf7dfae7c4c84be5270e63959be8a8",
    ],
  }],
  ["src/core/tools.ts", {
    reason:
      "the agent's shell tool surface spawns a caller-chosen executable — now only ever as the argv " +
      "`wrap` returns for a granted containment decision, so the command a provider chose runs inside " +
      "bwrap with the network unshared, unix sockets denied by seccomp, and nothing but the workspace " +
      "and the reviewed system directories visible",
    lineDigests: [
      "248c5594f3bbb955daa806b9fe24fe1fec209c21e362b071dfb1d68c673214f7",
    ],
  }],
  ["src/core/tui-build.test.ts", {
    reason: "an adversarial fixture starts the TUI build with no governed environment on purpose, to prove it refuses; the fixture's path is built at run time and is deliberately not a committed spelling",
    lineDigests: [
      "a3334cf18512ac130eb8467254a7b6836234df8faf7dfa3b5b54c8b2c5b46c09",
    ],
  }],
  ["tui/src/truth-conformance-harness.ts", {
    reason: "the conformance harness asks the Truth CLI for its protocol through a Node module path resolved at run time; the script is a runtime value, not a committed spelling",
    lineDigests: [
      "01d0c0edcf547f8c68e39cdd6036d160740720b7dfd0dacf9915dbff1b0009f9",
    ],
  }],
];

const TMP_TEXT_ALLOWED: ReadonlyMap<string, DeclaredException> = new Map(TMP_TEXT_DECLARATIONS);
const TMPDIR_CALL_ALLOWED: ReadonlyMap<string, DeclaredException> = new Map(TMPDIR_CALL_DECLARATIONS);
const MKDTEMP_CALL_ALLOWED: ReadonlyMap<string, DeclaredException> = new Map(MKDTEMP_CALL_DECLARATIONS);
const UNGOVERNED_EXECUTION_ALLOWED: ReadonlyMap<string, DeclaredException> = new Map(UNGOVERNED_EXECUTION_DECLARATIONS);

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
 * Every file an ungoverned execution could hide in: programs, shell scripts, the manifests that
 * name commands, deployment descriptors, service definitions, and the documents that teach a
 * human what to type. The lock file is data, not a call path.
 */
const EXECUTION_SCANNED = /(?:^|\/)package\.json$|\.(ts|tsx|mts|cts|mjs|cjs|js|sh|bash|py|service|conf|ya?ml|md)$/;

function trackedExecutionFiles(): readonly string[] {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter((f) => f.length > 0 && EXECUTION_SCANNED.test(f))
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

/**
 * ONE analysis, applied to every governed file type. A file with no finding is silent; a file
 * with an undeclared finding is an offender; a declared file must produce EXACTLY what it
 * declared. Unknown or dynamically unresolved execution is a finding, so it fails closed.
 */
test("no ungoverned package-manager or build-tool execution survives in committed files", () => {
  const offenders: string[] = [];
  const drifted: string[] = [];
  for (const file of trackedExecutionFiles()) {
    const findings = analyseExecution(file, readFileSync(file, "utf8"));
    if (findings.length === 0) continue;
    const declared = UNGOVERNED_EXECUTION_ALLOWED.get(file);
    if (declared === undefined) {
      offenders.push(`${file} (${[...new Set(findings.map((f) => f.kind))].sort().join(", ")})`);
      continue;
    }
    const actual = [...new Set(findings.map((f) => digestOf(`${f.kind}\n${f.text}`)))].sort();
    const expected = [...declared.lineDigests].sort();
    if (actual.length !== expected.length || actual.some((d, i) => d !== expected[i])) {
      drifted.push(`${file} (declared ${expected.length}, found ${actual.length})`);
    }
  }
  assert.deepEqual(offenders, [], `committed files with ungoverned execution: ${offenders.join(", ")}`);
  assert.deepEqual(drifted, [],
    `ungoverned-execution declarations changed, update them deliberately: ${drifted.join(", ")}`);
});

test("the ungoverned-execution analysis resolves every construction it claims to resolve", () => {
  // A self-test of the analysis itself: if these stop being findings the suite above would pass
  // vacuously, whatever the tree contained.
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["pnpm run build", "ungoverned-command:pnpm"],
    ["PM=pnpm; $PM run test", "ungoverned-command:pnpm"],
    ["alias pm=pnpm; pm run test", "ungoverned-command:pnpm"],
    ["corepack pnpm@9 run build", "ungoverned-command:corepack"],
    ["corepack enable", "ungoverned-command:corepack"],
    ["npx tsc -p tsconfig.json", "ungoverned-command:npx"],
    ["env FOO=1 pnpm install", "ungoverned-command:pnpm"],
    ['sh -c "pnpm run build"', "ungoverned-command:pnpm"],
    ['bash -c "PM=npm; $PM ci"', "ungoverned-command:npm"],
    ["tsc -p tsconfig.json", "ungoverned-command:tsc"],
    ["tsx src/server.ts", "ungoverned-command:tsx"],
    ["$UNKNOWN run build", "unresolved-command"],
  ];
  for (const [command, expected] of cases) {
    const kinds = analyseExecution("probe/package.json", JSON.stringify({ scripts: { probe: command } })).map((f) => f.kind);
    assert.ok(kinds.includes(expected), `${JSON.stringify(command)} produced ${JSON.stringify(kinds)}, not ${expected}`);
  }
  for (const governed of [
    "node scripts/trio/governed-launch.mjs trio-test -- tsc -p tsconfig.json",
    "node scripts/trio/governed-pnpm.mjs run test",
    "node ../scripts/trio/governed-launch.mjs trio-agent -- tsx src/entry.tsx",
  ]) {
    assert.deepEqual(analyseExecution("probe/package.json", JSON.stringify({ scripts: { probe: governed } })), [],
      `the governed form ${JSON.stringify(governed)} must not be a finding`);
  }
  // Construction cannot hide a name.
  for (const expression of ['spawnSync("pn" + "pm", [])', 'spawnSync(["p","n","p","m"].join(""), [])']) {
    assert.ok(analyseExecution("probe.ts", expression).some((f) => f.kind === "ungoverned-command:pnpm"),
      `${expression} was not folded to a package manager`);
  }
  // A command that cannot be resolved statically fails closed.
  assert.ok(analyseExecution("probe.ts", "spawnSync(chosenCommand, [])").some((f) => f.kind === "unresolved-command"),
    "an unresolvable command expression must fail closed");
});

/**
 * THE HOSTILE FORMS, AND THE HARMLESS ONES THAT LOOK LIKE THEM.
 *
 * An independent audit planted forty command-execution forms against this analysis and twelve
 * of them walked through: qualified and optional call syntax, `tsx` reached as a Node loader
 * rather than as a command, an executable shebang, backtick substitution, `xargs sh -c`,
 * combined shell flags, `sudo` options, a governed entry accepted on the strength of its
 * filename, a Node flag hiding the real script argument, and an argv written as a list.
 *
 * Each is committed here as a case rather than left to the external harness, because a control
 * that lives outside the repository proves nothing about the repository after it stops being
 * run. Each hostile case is paired with a HARMLESS one of the same shape — the same syntax
 * carrying `git` instead of a package manager, or the canonical governed entry instead of a
 * look-alike. Catching the first without catching the second is the whole requirement: an
 * analysis that flagged both would be noise wearing the costume of rigour.
 */
const HOSTILE_EXECUTION_CASES: ReadonlyArray<readonly [string, string, string, string]> = [
  ["qualified-spawn", "probe.ts",
    'import * as cp from "node:child_process";\ncp.spawnSync("pnpm", ["run", "build"]);\n', "ungoverned-command:pnpm"],
  ["optional-spawn", "probe.ts",
    'import * as cp from "node:child_process";\ncp.spawn?.("pnpm", []);\n', "ungoverned-command:pnpm"],
  ["node-import-tsx", "probe.sh",
    "node --import tsx src/server.ts\n", "ungoverned-command:tsx"],
  ["process-execpath-tsx", "probe.ts",
    'spawnSync(process.execPath, ["--import", "tsx", "src/server.ts"]);\n', "ungoverned-command:tsx"],
  ["tsx-shebang", "probe.ts",
    '#!/usr/bin/env tsx\nexport const value = 1;\n', "ungoverned-command:tsx"],
  ["backtick-substitution", "probe.sh",
    "echo `pnpm run build`\n", "ungoverned-command:pnpm"],
  ["xargs-shell", "probe.sh",
    'printf x | xargs sh -c "pnpm run build"\n', "ungoverned-command:pnpm"],
  ["bash-combined-flags", "probe.sh",
    'bash -ec "pnpm run build"\n', "ungoverned-command:pnpm"],
  ["sudo-options", "probe.sh",
    "sudo -u nobody pnpm run build\n", "ungoverned-command:pnpm"],
  ["fake-governed-path", "probe.sh",
    "node ./fake/governed-launch.mjs trio-test -- tsc -p tsconfig.json\n", "ungoverned-command:tsc"],
  ["loader-ahead-of-governed-entry", "probe.sh",
    "node --import tsx scripts/trio/governed-launch.mjs trio-test -- tsc -p tsconfig.json\n", "ungoverned-command:tsx"],
  ["descriptor-array", "probe.yaml",
    "command: [pnpm, run, build]\n", "ungoverned-command:pnpm"],
  ["unterminated-substitution", "probe.sh",
    "echo `pnpm run build\n", "unresolved-command"],
  ["expansion-built-command-path", "probe.sh",
    '"$TOOLCHAIN/bin/helper" --run\n', "unresolved-command"],
  ["expansion-built-manager-path", "probe.sh",
    "${TOOLCHAIN}/bin/pnpm run build\n", "ungoverned-command:pnpm"],

  // ── ORDER 18: the entry that was accepted from outside the repository, and the Node options
  //    that were stepped over on the way to it. Every one of these returned clean before.
  ["leading-traversal-entry", "probe.sh",
    "node ../../scripts/trio/governed-launch.mjs trio-test -- tsc -p tsconfig.json\n", "ungoverned-command:tsc"],
  ["cancelling-traversal-entry", "probe.sh",
    "node foo/../../scripts/trio/governed-launch.mjs trio-test -- tsc -p tsconfig.json\n", "ungoverned-command:tsc"],
  ["absolute-entry", "probe.sh",
    "node /opt/scripts/trio/governed-launch.mjs trio-test -- tsc -p tsconfig.json\n", "ungoverned-command:tsc"],
  ["eval-before-governed-entry", "probe.sh",
    "node --eval \"require('node:child_process').spawnSync('pnpm', ['run', 'build'])\" scripts/trio/governed-launch.mjs trio-test -- node src/server.mjs\n",
    "ungoverned-command:pnpm"],
  ["eval-equals-before-governed-entry", "probe.sh",
    "node --eval=require('node:child_process').spawnSync('pnpm',[]) scripts/trio/governed-launch.mjs trio-test -- node src/server.mjs\n",
    "ungoverned-command:pnpm"],
  ["require-before-governed-entry", "probe.sh",
    "node --require ./loader.cjs scripts/trio/governed-launch.mjs trio-test -- node src/server.mjs\n", "unresolved-command"],
  ["require-equals-before-governed-entry", "probe.sh",
    "node --require=./loader.cjs scripts/trio/governed-launch.mjs trio-test -- node src/server.mjs\n", "unresolved-command"],
  ["short-require-before-governed-entry", "probe.sh",
    "node -r ./loader.cjs --no-warnings scripts/trio/governed-launch.mjs trio-test -- node src/server.mjs\n", "unresolved-command"],
  ["loader-equals-before-governed-entry", "probe.sh",
    "node --loader=./loader.mjs scripts/trio/governed-launch.mjs trio-test -- node src/server.mjs\n", "unresolved-command"],
  ["import-equals-before-governed-entry", "probe.sh",
    "node --import=./loader.mjs scripts/trio/governed-launch.mjs trio-test -- node src/server.mjs\n", "unresolved-command"],
  // An env file can carry NODE_OPTIONS, which carries a loader: the value is not inert data.
  ["env-file-before-governed-entry", "probe.sh",
    "node --env-file=./ambient.env scripts/trio/governed-launch.mjs trio-test -- node src/server.mjs\n", "unresolved-command"],
  // An option whose arity this analysis does not know is an option that can hide the script.
  ["unknown-node-option", "probe.sh",
    "node --frobnicate value scripts/trio/governed-launch.mjs trio-test -- tsc -p tsconfig.json\n", "unresolved-command"],
  ["stdin-program", "probe.sh",
    "node - scripts/trio/governed-launch.mjs trio-test\n", "unresolved-command"],
  // ── The same forms written as a program's argv rather than as a command line.
  ["argv-is-not-a-list", "probe.ts",
    'spawnSync(process.execPath, process.argv.slice(2));\n', "unresolved-command"],
  ["argv-hole-before-script", "probe.ts",
    'const loader = chosenLoader;\nspawnSync(process.execPath, ["--import", loader, "scripts/trio/governed-launch.mjs"]);\n',
    "unresolved-command"],
  ["argv-require-equals", "probe.ts",
    'spawnSync(process.execPath, ["--require=./loader.cjs", "scripts/trio/governed-launch.mjs"]);\n', "unresolved-command"],
  ["argv-eval-code", "probe.ts",
    'spawnSync(process.execPath, ["--eval", "require(\'node:child_process\').spawnSync(\'pnpm\', [])"]);\n',
    "ungoverned-command:pnpm"],
  ["argv-eval-shell", "probe.ts",
    'spawnSync(process.execPath, ["--eval", "pnpm run build"]);\n', "ungoverned-command:pnpm"],
  ["argv-import-tool", "probe.ts",
    'const args = ["--import", "tsx", "src/server.ts"];\nspawnSync(process.execPath, args);\n', "ungoverned-command:tsx"],
  ["argv-computed-tool", "probe.ts",
    'const tool = "tsx";\nconst args = ["--import", tool, "src/server.ts"];\nspawnSync("node", args);\n', "ungoverned-command:tsx"],
];

/** The same shapes, carrying something harmless. Every one of these must stay silent. */
const HARMLESS_EXECUTION_CONTROLS: ReadonlyArray<readonly [string, string, string]> = [
  ["qualified-spawn", "probe.ts", 'import * as cp from "node:child_process";\ncp.spawnSync("git", ["status"]);\n'],
  ["optional-spawn", "probe.ts", 'import * as cp from "node:child_process";\ncp.spawn?.("git", []);\n'],
  ["node-script", "probe.sh", "node scripts/report.mjs --json\n"],
  ["process-execpath-script", "probe.ts", 'spawnSync(process.execPath, ["scripts/trio/build-provenance.mjs", "--check"]);\n'],
  ["node-shebang", "probe.ts", "#!/usr/bin/env node\nexport const value = 1;\n"],
  ["backtick-substitution", "probe.sh", "echo `git rev-parse HEAD`\n"],
  ["xargs-shell", "probe.sh", 'printf x | xargs sh -c "git status"\n'],
  ["bash-combined-flags", "probe.sh", 'bash -ec "git status"\n'],
  ["sudo-options", "probe.sh", "sudo -u nobody git status\n"],
  ["dot-relative-governed-entry", "probe.sh", "node ./scripts/trio/governed-launch.mjs trio-test -- tsc -p tsconfig.json\n"],
  ["flag-before-governed-entry", "probe.sh", "node --no-warnings scripts/trio/governed-launch.mjs trio-test -- tsc -p tsconfig.json\n"],
  ["descriptor-array", "probe.yaml", "command: [git, status]\n"],
  // An array assignment holds data, and a test expression's operands are not command names.
  // Splitting on their punctuation used to manufacture both into commands.
  ["array-assignment", "probe.sh", 'assets=("$DEMO"/media/*)\n'],
  ["test-expression-expansion", "probe.sh", 'if [[ ${#assets[@]} -eq 0 || ( ${#assets[@]} -eq 1 ) ]]; then\n  echo none\nfi\n'],
  // A regular expression's `exec` is not a shell. Recognising qualified calls through the names
  // a module actually binds `node:child_process` to is what keeps this from becoming a finding.
  ["regexp-exec", "probe.ts", 'import * as cp from "node:child_process";\nconst m = PATTERN.exec(text);\ncp.spawnSync("git", []);\n'],

  // ── The twins of the Order 18 forms. Each is the same syntax carrying something a governed
  //    tree really writes, and every one of them must stay silent.
  // The nested-manifest spelling: `tui/package.json` reaches the repository root with exactly one
  // `..`, and that is the only relative escape this analysis accepts.
  ["parent-relative-governed-entry", "probe.sh",
    "node ../scripts/trio/governed-launch.mjs trio-agent -- tsc -p tsconfig.json\n"],
  ["inert-value-option-before-entry", "probe.sh",
    "node --max-old-space-size=4096 scripts/trio/governed-launch.mjs trio-test -- tsc -p tsconfig.json\n"],
  ["inert-separated-value-before-entry", "probe.sh",
    "node --conditions development scripts/trio/governed-launch.mjs trio-test -- tsc -p tsconfig.json\n"],
  ["several-switches-before-entry", "probe.sh",
    "node --no-warnings --enable-source-maps scripts/trio/governed-launch.mjs trio-test -- tsc -p tsconfig.json\n"],
  // Past the entry, the entry's own contract governs: the loader here is the one the governed
  // test route really starts, and it starts inside the boundary.
  ["loader-after-governed-entry", "probe.sh",
    "node scripts/trio/governed-launch.mjs trio-test -- node --import tsx --test src/core/loop.test.ts\n"],
  // A `node -e` one-liner that spawns nothing is inert, and is read rather than assumed hostile.
  ["inert-eval-one-liner", "probe.ts",
    'spawnSync(process.execPath, ["-e", "process.stdout.write(String(1 + 1))"]);\n'],
  // A hole AFTER the script word is one of the script's own operands, and says nothing about
  // what Node was told to load.
  ["argv-hole-after-script", "probe.ts",
    'spawnSync(process.execPath, ["scripts/trio/build-provenance.mjs", target]);\n'],
];

test("every hostile execution form an independent audit planted is caught, and its harmless twin is not", () => {
  for (const [name, file, source, expected] of HOSTILE_EXECUTION_CASES) {
    const kinds = analyseExecution(file, source).map((f) => f.kind);
    assert.ok(kinds.includes(expected),
      `hostile form ${name} produced ${JSON.stringify(kinds)}, not ${expected}`);
  }
  for (const [name, file, source] of HARMLESS_EXECUTION_CONTROLS) {
    assert.deepEqual(analyseExecution(file, source), [],
      `harmless control ${name} must not be a finding`);
  }
  // Identity, not resemblance: only the canonical committed entries are the boundary. The
  // traversal spellings are the ones an independent audit walked in through -- both normalise
  // onto a canonical path, and neither is a call path this repository has.
  for (const impostor of [
    "fake/governed-launch.mjs",
    "./x/governed-npm.mjs",
    "/opt/scripts/trio/governed-pnpm.mjs",
    "../../scripts/trio/governed-launch.mjs",
    "../../../scripts/trio/governed-launch.mjs",
    "foo/../../scripts/trio/governed-launch.mjs",
    "scripts/trio/../trio/governed-launch.mjs",
    "scripts/trio/governed-launch.mjs.bak",
    "./scripts/trio/./governed-launch.mjs",
  ])
    assert.equal(isGovernedEntry(impostor), false, `${impostor} must not be accepted as the governed entry`);
  for (const canonical of ["scripts/trio/governed-launch.mjs", "./scripts/trio/governed-npm.mjs", "../scripts/trio/governed-pnpm.mjs"])
    assert.equal(isGovernedEntry(canonical), true, `${canonical} is a canonical governed entry`);
});

/**
 * THE BOUNDARY IS A FILE, AND THE PROOF IS TAKEN ON THE FILE.
 *
 * The spelling test above is a claim about text. Without this one it would be the whole story,
 * and a symlink committed at the canonical path — or a symlinked directory above it — would
 * satisfy every accepted spelling while running something else. The proof is exercised against a
 * private fixture rather than against this repository, because the cases that matter are the ones
 * a healthy repository cannot show: a substituted leaf, a substituted parent, a directory where
 * the entry belongs, and an entry that is not there at all.
 */
test("a governed entry is proved on disk: a symlink or a substituted component is not the boundary", () => {
  const governedRoot = process.env[GOVERNED_ROOT_ENV];
  assert.ok(governedRoot !== undefined && governedRoot.startsWith("/"),
    `this proof writes only under the governed root, and ${GOVERNED_ROOT_ENV} names none`);
  // One directory, removed whole: a nested fixture would leave its empty parent behind, and an
  // empty directory under the governed root is still residue.
  const root = join(governedRoot,
    `temp-policy-entry-proof-${process.pid}-${createHash("sha256").update(process.cwd()).digest("hex").slice(0, 8)}`);
  const entry = "scripts/trio/governed-launch.mjs";
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "scripts/trio"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "elsewhere"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "elsewhere/governed-launch.mjs"), "// somebody else's file\n");

  try {
    assert.equal(entryIsCanonicalOnDisk(root, entry), false, "an entry that does not exist is not the boundary");

    writeFileSync(join(root, entry), "// the canonical file\n");
    assert.equal(entryIsCanonicalOnDisk(root, entry), true, "the real committed file is the boundary");

    rmSync(join(root, entry));
    symlinkSync(join(root, "elsewhere/governed-launch.mjs"), join(root, entry));
    assert.equal(entryIsCanonicalOnDisk(root, entry), false, "a symlink at the canonical path is not the boundary");

    rmSync(join(root, entry));
    mkdirSync(join(root, entry), { recursive: true, mode: 0o700 });
    assert.equal(entryIsCanonicalOnDisk(root, entry), false, "a directory at the canonical path is not the boundary");

    rmSync(join(root, "scripts"), { recursive: true, force: true });
    mkdirSync(join(root, "elsewhere/trio"), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "elsewhere/trio/governed-launch.mjs"), "// the canonical file\n");
    mkdirSync(join(root, "scripts"), { recursive: true, mode: 0o700 });
    symlinkSync(join(root, "elsewhere/trio"), join(root, "scripts/trio"));
    assert.equal(entryIsCanonicalOnDisk(root, entry), false,
      "an entry reached through a symlinked directory is not the boundary");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  for (const map of [TMP_TEXT_ALLOWED, TMPDIR_CALL_ALLOWED, MKDTEMP_CALL_ALLOWED, UNGOVERNED_EXECUTION_ALLOWED]) {
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
