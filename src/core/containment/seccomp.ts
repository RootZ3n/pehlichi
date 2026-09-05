/**
 * A reviewed seccomp filter that denies the AF_UNIX address family.
 *
 * WHY THIS EXISTS. An unshared network namespace stops IP traffic and mount masking hides the
 * sockets you thought to mask. Neither stops a unix socket somewhere you did not think of: a unix
 * socket is a filesystem object, the namespace does not touch it, and an independent audit
 * demonstrated a contained program connecting to a host listener created outside every declared
 * workspace. Masking more paths is a race the maskers lose. Refusing the address family at the
 * syscall boundary is not.
 *
 * WHAT IT CAN AND CANNOT DO. seccomp classic BPF sees only the scalar arguments in `seccomp_data`;
 * it cannot dereference a pointer, so `connect()` cannot be filtered by the address family in the
 * `sockaddr` it points at. What it CAN see is the `domain` argument of `socket()` and
 * `socketpair()`, which are plain integers. Denying those denies the creation of every AF_UNIX
 * socket — pathname and abstract-namespace alike, since both require a socket first.
 *
 * THE RESIDUAL: an ALREADY-CONNECTED descriptor inherited across exec. seccomp cannot revoke one.
 * The mitigation is that no such descriptor is passed: the wrapper hands the child stdio plus the
 * single read-only descriptor carrying this program, and nothing else. `wrap()` is what enforces
 * that, and `conformance` proves an inherited descriptor is absent in the child.
 */

/** The syscall numbers this filter names, on the only architecture it accepts. */
const NR_SOCKET = 41;
const NR_SOCKETPAIR = 53;

/** `AUDIT_ARCH_X86_64`. A different architecture renumbers the syscalls, so the filter kills. */
const AUDIT_ARCH_X86_64 = 0xc000003e;

const AF_UNIX = 1; // AF_LOCAL is the same value, so both spellings are covered.
const EACCES = 13;

// classic BPF opcodes
const LD_W_ABS = 0x20;
const JMP_JEQ_K = 0x15;
const RET_K = 0x06;

// seccomp return actions
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO = 0x00050000;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;

// `struct seccomp_data` field offsets
const OFF_NR = 0;
const OFF_ARCH = 4;
const OFF_ARG0_LOW = 16; // little-endian low half of args[0]

interface Instruction {
  readonly code: number;
  readonly jt: number;
  readonly jf: number;
  readonly k: number;
}

/**
 * The program, as an explicit instruction list so the jumps can be read against it.
 *
 * Jump offsets are relative to the NEXT instruction, which is why each one is written as a
 * difference from a named index rather than as a bare number.
 */
function instructions(): Instruction[] {
  const I = {
    loadArch: 0, checkArch: 1, loadNr: 2, isSocket: 3, isSocketpair: 4,
    allowOther: 5, loadDomain: 6, isUnix: 7, deny: 8, allowDomain: 9, kill: 10,
  };
  const rel = (from: number, to: number): number => to - (from + 1);
  return [
    { code: LD_W_ABS, jt: 0, jf: 0, k: OFF_ARCH },
    { code: JMP_JEQ_K, jt: 0, jf: rel(I.checkArch, I.kill), k: AUDIT_ARCH_X86_64 >>> 0 },
    { code: LD_W_ABS, jt: 0, jf: 0, k: OFF_NR },
    { code: JMP_JEQ_K, jt: rel(I.isSocket, I.loadDomain), jf: 0, k: NR_SOCKET },
    { code: JMP_JEQ_K, jt: rel(I.isSocketpair, I.loadDomain), jf: 0, k: NR_SOCKETPAIR },
    { code: RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ALLOW },
    { code: LD_W_ABS, jt: 0, jf: 0, k: OFF_ARG0_LOW },
    { code: JMP_JEQ_K, jt: 0, jf: rel(I.isUnix, I.allowDomain), k: AF_UNIX },
    { code: RET_K, jt: 0, jf: 0, k: (SECCOMP_RET_ERRNO | EACCES) >>> 0 },
    { code: RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ALLOW },
    { code: RET_K, jt: 0, jf: 0, k: SECCOMP_RET_KILL_PROCESS >>> 0 },
  ];
}

/** The compiled cBPF program, in the layout `bwrap --seccomp` expects to read from a descriptor. */
export function afUnixDenyProgram(): Buffer {
  const list = instructions();
  const buffer = Buffer.alloc(list.length * 8);
  list.forEach((f, index) => {
    const at = index * 8;
    buffer.writeUInt16LE(f.code, at);
    buffer.writeUInt8(f.jt, at + 2);
    buffer.writeUInt8(f.jf, at + 3);
    buffer.writeUInt32LE(f.k, at + 4);
  });
  return buffer;
}

/** The filter's instruction count, so a test can pin the shape rather than only the behaviour. */
export const AF_UNIX_DENY_INSTRUCTIONS = instructions().length;

/**
 * The descriptor number the child sees the program on.
 *
 * The caller passes it as the fourth `stdio` entry, so it lands at 3. If the caller forgets,
 * `bwrap` cannot read the program and refuses to start — the failure is loud, and it is a failure
 * to RUN rather than a silent run without the filter.
 */
export const SECCOMP_CHILD_FD = 3;

/** The filename the program is written under, inside the run's own governed scratch. */
export const SECCOMP_PROGRAM_FILENAME = '.af-unix-deny.bpf';
