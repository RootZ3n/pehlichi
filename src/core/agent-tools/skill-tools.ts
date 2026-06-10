/**
 * SKILL TOOLS — Full Hermes-equivalent skill management.
 *
 * Progressive disclosure architecture (agentskills.io compatible):
 * - Tier 1: skills_list — metadata only (name, description, tags)
 * - Tier 2: skill_view — full SKILL.md content
 * - Tier 3: skill_view with file_path — linked files (references, templates, assets)
 *
 * Skill structure:
 *   skills/
 *   ├── my-skill/
 *   │   ├── SKILL.md           # Main instructions (required)
 *   │   ├── references/        # Supporting documentation
 *   │   ├── templates/         # Templates for output
 *   │   └── assets/            # Supplementary files
 *   └── category/
 *       └── another-skill/
 *           └── SKILL.md
 *
 * SKILL.md format (YAML frontmatter):
 *   ---
 *   name: skill-name
 *   description: Brief description
 *   version: 1.0.0
 *   tags: [tag1, tag2]
 *   ---
 *   # Skill Title
 *   Full instructions...
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname, relative, isAbsolute, resolve, sep } from 'node:path';
import type { ToolSpec, ToolHandler, ToolResult } from '../tools.js';

/**
 * Resolve `filePath` INSIDE `skillDir`, rejecting any escape (H5). `join(skillDir, ..)`
 * happily produces a path OUTSIDE the skill dir for inputs like `../../etc/passwd` or an
 * absolute path, which let skill_view / write_file / remove_file read or write anywhere on
 * disk. We resolve (collapsing `..`), then prefix-check, then follow symlinks via realpath
 * (a symlink inside the dir can still point out). Returns null on any escape.
 */
function confineToSkill(skillDir: string, filePath: string): string | null {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  const root = resolve(skillDir);
  const abs = resolve(root, filePath);
  const rel = relative(root, abs);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  // Symlink check: resolve the nearest existing ancestor and re-check the real path.
  let dir = abs;
  const tail: string[] = [];
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return abs;
    tail.unshift(dir.slice(parent.length + 1));
    dir = parent;
  }
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  const realAbs = tail.length === 0 ? realpathSync(dir) : resolve(realpathSync(dir), ...tail);
  const realRel = relative(realRoot, realAbs);
  if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) return null;
  return abs;
}

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });

const MAX_NAME_LENGTH = 64;

// Prompt injection detection
const INJECTION_PATTERNS = [
  'ignore previous instructions',
  'ignore all previous',
  'you are now',
  'disregard your',
  'forget your instructions',
  'new instructions:',
  'system prompt:',
  '<system>',
  ']]>',
];

export const skillToolSpecs: ToolSpec[] = [
  {
    name: 'skills_list',
    description: 'List available skills with metadata. Progressive disclosure tier 1.',
    parameters: obj(
      {
        category: { type: 'string', description: 'Filter by category (optional)' },
      },
      [],
    ),
  },
  {
    name: 'skill_view',
    description: 'Load a skill\'s content. Progressive disclosure tier 2-3.',
    parameters: obj(
      {
        name: { type: 'string', description: 'Skill name (slug)' },
        file_path: { type: 'string', description: 'Optional: linked file path (e.g. references/api.md)' },
      },
      ['name'],
    ),
  },
  {
    name: 'skill_manage',
    description: 'Manage skills: create, edit, patch, delete, write_file, remove_file.',
    parameters: obj(
      {
        action: { type: 'string', enum: ['create', 'edit', 'patch', 'delete', 'write_file', 'remove_file'], description: 'Action to perform' },
        name: { type: 'string', description: 'Skill name (slug)' },
        content: { type: 'string', description: 'SKILL.md content (for create/edit/patch)' },
        category: { type: 'string', description: 'Category folder (for create)' },
        file_path: { type: 'string', description: 'File path within skill (for write_file/remove_file)' },
        file_content: { type: 'string', description: 'File content (for write_file)' },
        old_string: { type: 'string', description: 'Text to find (for patch action)' },
        new_string: { type: 'string', description: 'Replacement text (for patch action)' },
        absorbed_into: { type: 'string', description: 'Target skill name (for delete — indicates consolidation)' },
      },
      ['action', 'name'],
    ),
  },
];

export function createSkillToolHandlers(skillsRoot: string): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  // Ensure skills directory exists
  if (!existsSync(skillsRoot)) {
    mkdirSync(skillsRoot, { recursive: true });
  }

  handlers.set('skills_list', async (args): Promise<ToolResult> => {
    const category = args.category as string | undefined;
    try {
      const skills = findAllSkills(skillsRoot, category);
      if (skills.length === 0) {
        return { ok: true, output: category ? `No skills in category "${category}"` : 'No skills found' };
      }

      const output = skills.map((s) => {
        const tags = s.tags.length > 0 ? ` [${s.tags.join(', ')}]` : '';
        const cat = s.category ? ` (${s.category})` : '';
        return `- **${s.name}**${cat}: ${s.description}${tags}`;
      }).join('\n');

      return { ok: true, output: `Found ${skills.length} skill(s):\n\n${output}` };
    } catch (err) {
      return { ok: false, output: '', error: `List failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  handlers.set('skill_view', async (args): Promise<ToolResult> => {
    const name = args.name as string;
    const filePath = args.file_path as string | undefined;

    try {
      const skillDir = findSkillDir(skillsRoot, name);
      if (!skillDir) {
        return { ok: false, output: '', error: `Skill "${name}" not found` };
      }

      if (filePath) {
        // Tier 3: load linked file — confined to the skill directory (H5).
        const fullPath = confineToSkill(skillDir, filePath);
        if (fullPath === null) {
          return { ok: false, output: '', error: `file_path "${filePath}" escapes the skill directory` };
        }
        if (!existsSync(fullPath)) {
          const available = listLinkedFiles(skillDir);
          return {
            ok: false,
            output: '',
            error: `File "${filePath}" not found in skill "${name}". Available: ${available.join(', ') || 'none'}`,
          };
        }
        const content = readFileSync(fullPath, 'utf8');
        return { ok: true, output: content };
      }

      // Tier 2: load SKILL.md
      const skillMd = join(skillDir, 'SKILL.md');
      if (!existsSync(skillMd)) {
        return { ok: false, output: '', error: `No SKILL.md found in "${name}"` };
      }

      const content = readFileSync(skillMd, 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);

      const header = [
        `# ${frontmatter.name || name}`,
        frontmatter.description ? `> ${frontmatter.description}` : '',
        frontmatter.version ? `Version: ${frontmatter.version}` : '',
        frontmatter.tags?.length ? `Tags: ${frontmatter.tags.join(', ')}` : '',
        '',
        '---',
        '',
      ].filter(Boolean).join('\n');

      const linkedFiles = listLinkedFiles(skillDir);
      const footer = linkedFiles.length > 0
        ? `\n\n---\n\n**Linked files:** ${linkedFiles.join(', ')}\nUse skill_view with file_path to load them.`
        : '';

      return { ok: true, output: `${header}${body}${footer}` };
    } catch (err) {
      return { ok: false, output: '', error: `View failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  handlers.set('skill_manage', async (args): Promise<ToolResult> => {
    const action = args.action as string;
    const name = args.name as string;

    try {
      switch (action) {
        case 'create':
          return createSkill(skillsRoot, name, args.content as string, args.category as string | undefined);
        case 'edit':
          return editSkill(skillsRoot, name, args.content as string);
        case 'patch':
          return patchSkill(skillsRoot, name, args.old_string as string, args.new_string as string);
        case 'delete':
          return deleteSkill(skillsRoot, name, args.absorbed_into as string | undefined);
        case 'write_file':
          return writeSkillFile(skillsRoot, name, args.file_path as string, args.file_content as string);
        case 'remove_file':
          return removeSkillFile(skillsRoot, name, args.file_path as string);
        default:
          return { ok: false, output: '', error: `Unknown action: ${action}` };
      }
    } catch (err) {
      return { ok: false, output: '', error: `Skill manage failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  return handlers;
}

// ── Skill discovery ──────────────────────────────────────────────────────

interface SkillInfo {
  name: string;
  description: string;
  category: string | null;
  tags: string[];
  version: string | null;
  path: string;
}

function findAllSkills(root: string, category?: string): SkillInfo[] {
  const skills: SkillInfo[] = [];

  function walk(dir: string, currentCategory: string | null) {
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const skillMd = join(dir, entry.name, 'SKILL.md');
      if (existsSync(skillMd)) {
        // This is a skill directory
        const content = readFileSync(skillMd, 'utf8');
        const { frontmatter } = parseFrontmatter(content);

        if (category && currentCategory !== category) continue;

        skills.push({
          name: frontmatter.name || entry.name,
          description: frontmatter.description || '(no description)',
          category: currentCategory,
          tags: frontmatter.tags || [],
          version: frontmatter.version || null,
          path: join(dir, entry.name),
        });
      } else {
        // Might be a category directory — recurse
        walk(join(dir, entry.name), entry.name);
      }
    }
  }

  walk(root, null);
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function findSkillDir(root: string, name: string): string | null {
  // Direct match
  const direct = join(root, name);
  if (existsSync(direct) && existsSync(join(direct, 'SKILL.md'))) {
    return direct;
  }

  // Search in categories
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, name);
    if (existsSync(candidate) && existsSync(join(candidate, 'SKILL.md'))) {
      return candidate;
    }
  }

  return null;
}

function listLinkedFiles(skillDir: string): string[] {
  const files: string[] = [];
  for (const subdir of ['references', 'templates', 'assets']) {
    const dir = join(skillDir, subdir);
    if (!existsSync(dir)) continue;

    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        files.push(`${subdir}/${entry.name}`);
      }
    }
  }
  return files;
}

// ── Frontmatter parsing ──────────────────────────────────────────────────

interface Frontmatter {
  name?: string;
  description?: string;
  version?: string;
  tags?: string[];
  [key: string]: unknown;
}

function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const yamlStr = match[1]!; // both capture groups are present when the regex matched
  const body = match[2]!.trim();
  const frontmatter: Frontmatter = {};

  // Simple YAML parser (handles key: value and key: [array])
  for (const line of yamlStr.split('\n')) {
    const kvMatch = line.match(/^(\w+):\s*(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1]!; // group 1 (\w+) and group 2 (.*) present when this matched
    let value: unknown = kvMatch[2]!.trim();

    // Parse arrays: [item1, item2]
    if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
    }
    // Parse strings: remove quotes
    else if (typeof value === 'string') {
      value = value.replace(/^["']|["']$/g, '');
    }

    frontmatter[key] = value;
  }

  return { frontmatter, body };
}

// ── Security ─────────────────────────────────────────────────────────────

function scanForInjection(content: string): string | null {
  const lower = content.toLowerCase();
  for (const pattern of INJECTION_PATTERNS) {
    if (lower.includes(pattern)) {
      return `Potential prompt injection detected: "${pattern}"`;
    }
  }
  return null;
}

// ── Skill CRUD ───────────────────────────────────────────────────────────

function createSkill(root: string, name: string, content: string, category?: string): ToolResult {
  // Validate name
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, output: '', error: `Name too long (max ${MAX_NAME_LENGTH} chars)` };
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    return { ok: false, output: '', error: 'Name must be lowercase with hyphens only' };
  }

  // Security scan
  const injection = scanForInjection(content);
  if (injection) {
    return { ok: false, output: '', error: injection };
  }

  // Determine path
  const skillDir = category ? join(root, category, name) : join(root, name);
  if (existsSync(skillDir)) {
    return { ok: false, output: '', error: `Skill "${name}" already exists` };
  }

  // Create directory and write SKILL.md
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf8');

  return { ok: true, output: `Created skill "${name}" at ${skillDir}` };
}

function editSkill(root: string, name: string, content: string): ToolResult {
  const skillDir = findSkillDir(root, name);
  if (!skillDir) {
    return { ok: false, output: '', error: `Skill "${name}" not found` };
  }

  // Security scan
  const injection = scanForInjection(content);
  if (injection) {
    return { ok: false, output: '', error: injection };
  }

  writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf8');
  return { ok: true, output: `Edited skill "${name}"` };
}

function patchSkill(root: string, name: string, oldString: string, newString: string): ToolResult {
  const skillDir = findSkillDir(root, name);
  if (!skillDir) {
    return { ok: false, output: '', error: `Skill "${name}" not found` };
  }

  const skillMd = join(skillDir, 'SKILL.md');
  const content = readFileSync(skillMd, 'utf8');

  if (!content.includes(oldString)) {
    return { ok: false, output: '', error: 'old_string not found in SKILL.md' };
  }

  const count = content.split(oldString).length - 1;
  if (count > 1) {
    return { ok: false, output: '', error: `Found ${count} matches — provide more context` };
  }

  const newContent = content.replace(oldString, newString);

  // Security scan on new content
  const injection = scanForInjection(newContent);
  if (injection) {
    return { ok: false, output: '', error: injection };
  }

  writeFileSync(skillMd, newContent, 'utf8');
  return { ok: true, output: `Patched skill "${name}"` };
}

function deleteSkill(root: string, name: string, absorbedInto?: string): ToolResult {
  const skillDir = findSkillDir(root, name);
  if (!skillDir) {
    return { ok: false, output: '', error: `Skill "${name}" not found` };
  }

  rmSync(skillDir, { recursive: true, force: true });

  const suffix = absorbedInto ? ` (absorbed into "${absorbedInto}")` : '';
  return { ok: true, output: `Deleted skill "${name}"${suffix}` };
}

function writeSkillFile(root: string, name: string, filePath: string, content: string): ToolResult {
  const skillDir = findSkillDir(root, name);
  if (!skillDir) {
    return { ok: false, output: '', error: `Skill "${name}" not found` };
  }

  // Validate file path is within skill directory (H5: resolve + symlink check, not a
  // weak prefix test that `../sibling` or an absolute path can defeat).
  const fullPath = confineToSkill(skillDir, filePath);
  if (fullPath === null) {
    return { ok: false, output: '', error: 'File path must be within the skill directory' };
  }

  // Security scan
  const injection = scanForInjection(content);
  if (injection) {
    return { ok: false, output: '', error: injection };
  }

  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');

  return { ok: true, output: `Wrote ${filePath} to skill "${name}"` };
}

function removeSkillFile(root: string, name: string, filePath: string): ToolResult {
  const skillDir = findSkillDir(root, name);
  if (!skillDir) {
    return { ok: false, output: '', error: `Skill "${name}" not found` };
  }

  const fullPath = confineToSkill(skillDir, filePath);
  if (fullPath === null) {
    return { ok: false, output: '', error: 'File path must be within the skill directory' };
  }

  if (!existsSync(fullPath)) {
    return { ok: false, output: '', error: `File "${filePath}" not found` };
  }

  unlinkSync(fullPath);
  return { ok: true, output: `Removed ${filePath} from skill "${name}"` };
}
