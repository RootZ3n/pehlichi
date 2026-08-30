/** Byte-identical compatibility export. The implementation lives in governed src/. */
/**
 * Named forwarding only.
 *
 * This was `export * from '../../src/core/personality.js'`. A star re-export cannot be audited by reading it: it
 * exports whatever the target exports, including whatever the target starts exporting tomorrow.
 * That is how `runtime/core/loop.ts` came to re-export both below-admission executors into a
 * second namespace, where the same computed-property bypass would have reached them.
 *
 * The names are written out so this file's surface is a decision somebody made, not a
 * consequence of one made elsewhere.
 */
export {
  buildPersonalityPrompt,
  loadPersonality,
  type Personality
} from '../../src/core/personality.js';
