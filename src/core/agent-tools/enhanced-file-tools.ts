/**
 * ENHANCED FILE TOOLS — patch, enhanced search_files, read_file, write_file.
 *
 * Tool names match Hermes: patch, read_file, write_file, search_files.
 * Supplements the core's basic read/write/search with Hermes-level features.
 */
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, relative, resolve, dirname, basename } from 'node:path';
import { execSync } from 'node:child_process';
import type { ToolSpec, ToolHandler, ToolResult } from '../core/tools.js';

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });

export const enhancedFileToolSpecs: ToolSpec[] = [
  {
    name: 'read_file',
    description: 'Read a text file with line numbers and pagination.',
    parameters: obj(
      {
        path: { type: 'string', description: 'File path (absolute or relative)' },
        offset: { type: 'number', description: 'Line number to start from (1-indexed, default 1)' },
        limit: { type: 'number', description: 'Max lines to read (default 500)' },
      },
      ['path'],
    ),
  },
  {
    name: 'write_file',
    description: 'Write content to a file (creates parent dirs, overwrites existing).',
    parameters: obj(
      {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'File content' },
      },
      ['path', 'content'],
    ),
  },
  {
    name: 'search_files',
    description: 'Search file contents (regex) or find files by name pattern.',
    parameters: obj(
      {
        pattern: { type: 'string', description: 'Regex pattern or glob' },
        target: { type: 'string', enum: ['content', 'files'], description: 'Search content or filenames' },
        path: { type: 'string', description: 'Directory to search in (default: cwd)' },
        file_glob: { type: 'string', description: 'Filter files by glob (e.g. *.py)' },
        limit: { type: 'number', description: 'Max results (default 50)' },
      },
      ['pattern'],
    ),
  },
  {
    name: 'patch',
    description: 'Targeted find-and-replace edit in a file. Uses fuzzy matching.',
    parameters: obj(
      {
        path: { type: 'string', description: 'File path' },
        old_string: { type: 'string', description: 'Text to find' },
        new_string: { type: 'string', description: 'Replacement text' },
      },
      ['path', 'old_string', 'new_string'],
    ),
  },
];

export function createEnhancedFileToolHandlers(workspaceRoot: string): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  handlers.set('read_file', async (args): Promise<ToolResult> => {
    const filePath = resolvePath(workspaceRoot, args.path as string);
    const offset = (args.offset as number) ?? 1;
    const limit = (args.limit as number) ?? 500;

    if (!existsSync(filePath)) {
      // Try to suggest similar files
      const dir = dirname(filePath);
      const target = basename(filePath);
      if (existsSync(dir)) {
        const files = readdirSync(dir).filter((f) => f.includes(target.slice(0, 3)));
        return { ok: false, output: '', error: `File not found: ${filePath}${files.length > 0 ? `. Similar: ${files.join(', ')}` : ''}` };
      }
      return { ok: false, output: '', error: `File not found: ${filePath}` };
    }

    try {
      const content = readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      const totalLines = lines.length;
      const start = Math.max(0, offset - 1);
      const end = Math.min(totalLines, start + limit);
      const selected = lines.slice(start, end);

      const output = selected
        .map((line, i) => `${start + i + 1}|${line}`)
        .join('\n');

      return {
        ok: true,
        output: `${output}${end < totalLines ? `\n[showing lines ${offset}-${end} of ${totalLines}]` : ''}`,
      };
    } catch (err) {
      return { ok: false, output: '', error: `Read failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  handlers.set('write_file', async (args): Promise<ToolResult> => {
    const filePath = resolvePath(workspaceRoot, args.path as string);
    const content = args.content as string;

    try {
      const dir = dirname(filePath);
      writeFileSync(filePath, content, 'utf8');
      const bytes = Buffer.byteLength(content, 'utf8');
      return { ok: true, output: `Wrote ${bytes} bytes to ${filePath}` };
    } catch (err) {
      return { ok: false, output: '', error: `Write failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  handlers.set('search_files', async (args): Promise<ToolResult> => {
    const pattern = args.pattern as string;
    const target = (args.target as string) ?? 'content';
    const searchPath = args.path ? resolvePath(workspaceRoot, args.path as string) : workspaceRoot;
    const fileGlob = args.file_glob as string | undefined;
    const limit = (args.limit as number) ?? 50;

    try {
      if (target === 'files') {
        // Find files by name pattern (glob)
        const results = findFilesByGlob(searchPath, pattern, limit);
        return {
          ok: true,
          output: results.length > 0 ? results.join('\n') : `No files matching "${pattern}"`,
        };
      } else {
        // Search file contents with ripgrep
        const rgArgs = ['--no-heading', '--line-number', '--max-count', String(limit)];
        if (fileGlob) {
          rgArgs.push('--glob', fileGlob);
        }
        rgArgs.push(pattern, searchPath);

        try {
          const output = execSync(`rg ${rgArgs.map((a) => JSON.stringify(a)).join(' ')}`, {
            encoding: 'utf8',
            timeout: 10_000,
            maxBuffer: 512 * 1024,
          });
          return { ok: true, output: output.trim() || `No matches for "${pattern}"` };
        } catch {
          // Fallback to grep if rg not available
          const grepArgs = ['-rn', '--include', fileGlob || '*', pattern, searchPath];
          try {
            const output = execSync(`grep ${grepArgs.map((a) => JSON.stringify(a)).join(' ')}`, {
              encoding: 'utf8',
              timeout: 10_000,
              maxBuffer: 512 * 1024,
            });
            return { ok: true, output: output.trim() || `No matches for "${pattern}"` };
          } catch {
            return { ok: true, output: `No matches for "${pattern}"` };
          }
        }
      }
    } catch (err) {
      return { ok: false, output: '', error: `Search failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  handlers.set('patch', async (args): Promise<ToolResult> => {
    const filePath = resolvePath(workspaceRoot, args.path as string);
    const oldString = args.old_string as string;
    const newString = args.new_string as string;

    if (!existsSync(filePath)) {
      return { ok: false, output: '', error: `File not found: ${filePath}` };
    }

    try {
      const content = readFileSync(filePath, 'utf8');

      // Exact match
      if (content.includes(oldString)) {
        const count = content.split(oldString).length - 1;
        if (count > 1) {
          return {
            ok: false,
            output: '',
            error: `Found ${count} matches. Provide more context to make the match unique.`,
          };
        }
        const newContent = content.replace(oldString, newString);
        writeFileSync(filePath, newContent, 'utf8');
        return {
          ok: true,
          output: `Patched ${filePath} (${oldString.length} chars → ${newString.length} chars)`,
        };
      }

      // Fuzzy match — try normalizing whitespace
      const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
      if (normalize(content).includes(normalize(oldString))) {
        // Find the actual match with surrounding context
        const normalized = normalize(oldString);
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (normalize(lines[i]).includes(normalized.slice(0, 30))) {
            // Found approximate location — do line-level replacement
            const before = lines.slice(0, i).join('\n');
            const after = lines.slice(i + 1).join('\n');
            const newContent = `${before}\n${newString}\n${after}`;
            writeFileSync(filePath, newContent, 'utf8');
            return {
              ok: true,
              output: `Patched ${filePath} (fuzzy match at line ${i + 1})`,
            };
          }
        }
      }

      return {
        ok: false,
        output: '',
        error: `No match found. The old_string was not found in the file.`,
      };
    } catch (err) {
      return { ok: false, output: '', error: `Patch failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  return handlers;
}

/** Resolve a path relative to workspace root. */
function resolvePath(workspaceRoot: string, path: string): string {
  if (path.startsWith('/') || path.startsWith('~')) {
    return path.replace(/^~/, process.env.HOME || '/home/zen');
  }
  return resolve(workspaceRoot, path);
}

/** Find files matching a glob pattern. */
function findFilesByGlob(dir: string, pattern: string, limit: number): string[] {
  const results: string[] = [];
  const regex = new RegExp(
    pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.'),
    'i'
  );

  function walk(currentDir: string, depth: number) {
    if (depth > 10 || results.length >= limit) return;
    try {
      const entries = readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= limit) break;
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

        const fullPath = join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (regex.test(entry.name) || regex.test(fullPath)) {
          results.push(relative(dir, fullPath));
        }
      }
    } catch {
      // Permission denied or other error
    }
  }

  walk(dir, 0);
  return results.sort();
}
