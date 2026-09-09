/**
 * PREFIX IDENTITY — a hash of the part of a request that is supposed to hold still.
 *
 * A provider prefix cache is only reused while the leading bytes of a request are unchanged.
 * We had no way to tell whether ours were: the request was assembled, sent, and forgotten, so
 * "the prefix is stable" was an argument about source code rather than an observation.
 *
 * This turns it into an observation, and does so WITHOUT keeping the prompt. The digest is
 * one-way: two receipts can be compared to each other, and nothing can be read back out. That
 * is the whole design constraint — a diagnostic that made system-prompt and skill text
 * readable in the audit log would be a worse problem than the one it solves.
 *
 * It is also inert with respect to the model: nothing here is sent anywhere, and computing a
 * digest cannot change what the model sees.
 *
 * @module core/prefix-identity
 */
import { createHash } from 'node:crypto';

import type { Message, ToolSpec } from './driver.js';

/**
 * The scheme this module computes, recorded alongside every digest.
 *
 * BUMP THIS whenever the DEFINITION of the stable prefix changes — a different message range,
 * a different tool projection, a different separator. Two digests computed under different
 * schemes say nothing about each other, and a reader comparing them must be able to see that
 * rather than conclude the prefix moved.
 */
export const PREFIX_SCHEME = 'sha256/1';

/** A versioned digest of one request's stable prefix. */
export interface PrefixIdentity {
  readonly scheme: string;
  readonly digest: string;
}

/**
 * Hash the stable prefix of an assembled request.
 *
 * WHAT COUNTS AS THE PREFIX: every leading `system` message, plus the model-facing tool
 * surface (name and description, in the order they will be sent). Both are prompt-prefix
 * material in an OpenAI-compatible chat template, and both are supposed to be constant for the
 * life of a run — so both belong to the thing being checked. Conversation turns are excluded
 * deliberately: history is SUPPOSED to grow, and including it would make every request differ
 * and measure nothing.
 *
 * Tool `parameters` are excluded: they are large, and a schema change already shows up as a
 * change to the tool set this digest does cover.
 *
 * @param messages the assembled transcript, in send order.
 * @param tools the model-facing tool surface, in send order.
 * @returns a versioned digest; never any part of the prompt itself.
 */
export function prefixIdentity(
  messages: readonly Message[],
  tools: readonly ToolSpec[],
): PrefixIdentity {
  const hash = createHash('sha256');
  // A length-prefixed encoding, so no combination of contents can be re-cut into a different
  // one that hashes the same (`["ab","c"]` and `["a","bc"]` must not collide).
  const feed = (label: string, value: string): void => {
    hash.update(`${label}:${Buffer.byteLength(value, 'utf8')}:`);
    hash.update(value, 'utf8');
  };

  let leading = 0;
  while (leading < messages.length && messages[leading]?.role === 'system') leading += 1;
  feed('systemCount', String(leading));
  for (let i = 0; i < leading; i += 1) {
    feed('system', messages[i]?.content ?? '');
  }

  feed('toolCount', String(tools.length));
  for (const tool of tools) {
    feed('toolName', tool.name);
    feed('toolDescription', tool.description);
  }

  return { scheme: PREFIX_SCHEME, digest: hash.digest('hex') };
}
