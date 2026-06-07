/**
 * THE DISPOSABLE SHADOW WORKSPACE — the primary containment boundary.
 *
 * Before any real model drives the terminal, the agent must operate ONLY inside
 * a fresh throwaway directory. Containment is by construction: the workspace is
 * disposable, it starts empty, existing content is copied IN explicitly, and it
 * is discarded at run end. Nothing the agent does can reach a real repo.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class ShadowWorkspace {
  private constructor(public readonly root: string) {}

  /** mkdtemp a fresh disposable workspace under the OS tmp dir. Empty by default. */
  static create(): ShadowWorkspace {
    return new ShadowWorkspace(mkdtempSync(join(tmpdir(), "lab-shadow-")));
  }

  /**
   * Seed the workspace with existing content, COPIED IN explicitly. The source
   * is never operated on in place — the agent only ever touches the copy. Each
   * top-level entry of `srcDir` is copied into the shadow root.
   */
  seed(srcDir: string): void {
    for (const entry of readdirSync(srcDir)) {
      cpSync(join(srcDir, entry), join(this.root, entry), { recursive: true });
    }
  }

  /**
   * Recursively remove the workspace. Idempotent. Called at run end ALWAYS
   * (see runAgentInShadow) — the disposable dir never outlives the run.
   */
  discard(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  /** Whether the workspace dir still exists on disk. */
  exists(): boolean {
    return existsSync(this.root);
  }

  // ── PROMOTE SEAM — intentionally NOT implemented here ──────────────────────
  //
  // Promotion (copying results back into a real repo) is a SEPARATE, EXPLICIT,
  // operator-gated step. It is deliberately absent from this class, from the
  // tools, and from the core loop: there is NO code path by which the agent or
  // the loop can copy the shadow workspace back to a real repo automatically.
  // The model can never promote. When promotion is wired in a later step it
  // must sit behind an explicit human action, never inside an agent run.
}
