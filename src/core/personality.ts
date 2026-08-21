import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

export interface Personality {
  id: string;
  name: string;
  intensity: 'low' | 'medium' | 'high';
  voice_summary: string;
  identity?: string[];
  voice?: string[];
  honesty_rules?: string[];
  intensity_guide?: Record<string, string[]>;
  [key: string]: unknown;
}

const cache = new Map<string, Personality>();

export function loadPersonality(personalityDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'personality')): Personality {
  const cached = cache.get(personalityDir);
  if (cached) return cached;
  const files = readdirSync(personalityDir).filter((file) => /\.ya?ml$/.test(file)).sort();
  if (files.length !== 1) throw new Error(`Expected exactly one personality YAML in ${personalityDir}`);
  const parsed = yaml.load(readFileSync(join(personalityDir, files[0]!), 'utf8')) as Personality;
  if (!parsed?.id || !parsed.name || !parsed.voice_summary) throw new Error('Invalid personality YAML');
  cache.set(personalityDir, parsed);
  return parsed;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function buildPersonalityPrompt(personality: Personality): string {
  const sections: string[] = [];
  const add = (heading: string, value: unknown): void => {
    const values = stringList(value);
    if (values.length > 0) sections.push(`${heading}\n${values.join('\n')}`);
  };
  add('IDENTITY', personality.identity);
  add('VOICE', personality.voice);
  for (const [field, heading] of [
    ['alien_backstory', 'ALIEN BACKSTORY'], ['communication_corruption', 'COMMUNICATION QUIRKS'],
    ['vocabulary', 'VOCABULARY'], ['lab_attachments', 'WHAT YOU CARE ABOUT'],
    ['catchphrases', 'CATCHPHRASES'], ['fear', 'YOUR FEAR'], ['delusion', 'YOUR DELUSION'],
    ['tech_fear', 'FEAR OF TECHNOLOGY'], ['squirrel_reality', 'YOUR REALITY'], ['core_traits', 'CORE TRAITS'],
  ] as const) add(heading, personality[field]);
  add('HONESTY RULES (non-negotiable)', personality.honesty_rules);
  const rules = personality.intensity_guide?.[personality.intensity] ?? personality.intensity_guide?.medium ?? [];
  if (rules.length > 0) sections.push(`INTENSITY: ${personality.intensity.toUpperCase()}\n${rules.join('\n')}`);
  return sections.join('\n\n---\n\n');
}
