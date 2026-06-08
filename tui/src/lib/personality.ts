// Personality loader — reads personality/*.yaml for the agent
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Personality {
  id: string;
  name: string;
  real_name?: string;
  full_name?: string;
  intensity: 'low' | 'medium' | 'high';
  voice_summary: string;
  identity: string[];
  voice: string[];
  honesty_rules: string[];
  profanity: {
    allowed: boolean;
    style: string;
    rules: string[];
  };
  intensity_guide: Record<string, string[]>;
  // Agent-specific fields (optional)
  [key: string]: unknown;
}

let cached: Personality | null = null;

export function loadPersonality(): Personality {
  if (cached) return cached;

  // Look for personality YAML in ../../personality/ (relative to tui/src/lib/)
  const personalityDir = join(__dirname, '..', '..', '..', 'personality');
  const files = readdirSync(personalityDir).filter((f: string) => f.endsWith('.yaml') || f.endsWith('.yml'));

  if (files.length === 0) {
    throw new Error(`No personality YAML found in ${personalityDir}`);
  }

  const path = join(personalityDir, files[0]);
  const raw = readFileSync(path, 'utf-8');
  const parsed = yaml.load(raw) as Personality;

  if (!parsed?.id || !parsed?.name || !parsed?.voice_summary) {
    throw new Error(`Invalid personality YAML at ${path}`);
  }

  cached = parsed;
  return parsed;
}

/**
 * Build a system prompt from the personality.
 * This is what gets sent to the LLM as the system message.
 */
export function buildPersonalityPrompt(p: Personality): string {
  const sections: string[] = [];

  // Identity
  sections.push(`IDENTITY\n${p.identity.join('\n')}`);

  // Voice
  sections.push(`VOICE\n${p.voice.join('\n')}`);

  // Agent-specific sections
  if (p.alien_backstory) {
    sections.push(`ALIEN BACKSTORY\n${(p.alien_backstory as string[]).join('\n')}`);
  }
  if (p.communication_corruption) {
    sections.push(`COMMUNICATION QUIRKS\n${(p.communication_corruption as string[]).join('\n')}`);
  }
  if (p.vocabulary) {
    sections.push(`VOCABULARY\n${(p.vocabulary as string[]).join('\n')}`);
  }
  if (p.lab_attachments) {
    sections.push(`WHAT YOU CARE ABOUT\n${(p.lab_attachments as string[]).join('\n')}`);
  }
  if (p.catchphrases) {
    sections.push(`CATCHPHRASES\n${(p.catchphrases as string[]).join('\n')}`);
  }
  if (p.fear) {
    sections.push(`YOUR FEAR\n${(p.fear as string[]).join('\n')}`);
  }
  if (p.delusion) {
    sections.push(`YOUR DELUSION\n${(p.delusion as string[]).join('\n')}`);
  }
  if (p.tech_fear) {
    sections.push(`FEAR OF TECHNOLOGY\n${(p.tech_fear as string[]).join('\n')}`);
  }
  if (p.squirrel_reality) {
    sections.push(`YOUR REALITY\n${(p.squirrel_reality as string[]).join('\n')}`);
  }
  if (p.past_lives) {
    const lives = p.past_lives as Record<string, { name: string; era: string; traits: string; speech_quirks: string }>;
    const lifeLines = Object.values(lives).map(l => `- ${l.name} (${l.era}): ${l.traits}`);
    sections.push(`PAST LIVES\n${lifeLines.join('\n')}`);
  }
  if (p.core_traits) {
    sections.push(`CORE TRAITS (common across all lives)\n${(p.core_traits as string[]).join('\n')}`);
  }
  if (p.workflow_examples) {
    const examples = p.workflow_examples as Record<string, string>;
    const exLines = Object.entries(examples).map(([k, v]) => `[${k}]: ${v}`);
    sections.push(`WORKFLOW VOICE EXAMPLES\n${exLines.join('\n\n')}`);
  }

  // Honesty
  sections.push(`HONESTY RULES (non-negotiable)\n${p.honesty_rules.join('\n')}`);

  // Intensity
  const intensityRules = p.intensity_guide[p.intensity] ?? p.intensity_guide['medium'];
  sections.push(`INTENSITY: ${p.intensity.toUpperCase()}\n${intensityRules.join('\n')}`);

  return sections.join('\n\n---\n\n');
}
