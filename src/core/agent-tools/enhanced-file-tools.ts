/**
 * ENHANCED FILE TOOLS — patch, enhanced search_files, read_file, write_file.
 *
 * Tool names match Hermes: patch, read_file, write_file, search_files.
 * Supplements the core's basic read/write/search with Hermes-level features.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ToolSpec, ToolHandler, ToolResult } from '../tools.js';
import { resolveInWorkspace } from '../workspace.js';

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
        // Search file contents with ripgrep. CRITICAL (H4): a search command exit
        // code of 1 means "ran fine, found nothing" — a real result. ANY OTHER
        // failure (bad regex, ENOENT, timeout, permission) means the search never
        // produced an answer, and must surface as ok:false. Reporting "No matches"
        // for a search that failed makes a model believe the pattern is absent.
        const noMatch = `No matches for "${pattern}"`;
        const ranEmpty = (err: unknown): boolean => (err as { status?: number })?.status === 1;

        // C2 (RCE): NEVER build a shell command string from user input. `execSync`
        // runs through /bin/sh, and JSON.stringify-quoting is NOT shell-safe — inside
        // double quotes a pattern like `$(touch pwned)` or a backtick still executes.
        // `execFileSync` spawns the binary directly with an argv array: the search
        // pattern is passed as a literal argument, never parsed by a shell. The `--`
        // separator additionally stops a pattern starting with `-` being read as a flag.
        const rgArgs = ['--no-heading', '--line-number', '--max-count', String(limit)];
        if (fileGlob) {
          rgArgs.push('--glob', fileGlob);
        }
        rgArgs.push('--', pattern, searchPath);

        try {
          const output = execFileSync('rg', rgArgs, {
            encoding: 'utf8',
            timeout: 10_000,
            maxBuffer: 512 * 1024,
          });
          return { ok: true, output: output.trim() || noMatch };
        } catch (rgErr) {
          if (ranEmpty(rgErr)) return { ok: true, output: noMatch };
          // rg was unavailable or errored — fall back to grep (also shell-free).
          const grepArgs = ['-rn', '--include', fileGlob || '*', '--', pattern, searchPath];
          try {
            const output = execFileSync('grep', grepArgs, {
              encoding: 'utf8',
              timeout: 10_000,
              maxBuffer: 512 * 1024,
            });
            return { ok: true, output: output.trim() || noMatch };
          } catch (grepErr) {
            if (ranEmpty(grepErr)) return { ok: true, output: noMatch };
            // Neither searcher ran successfully — this is a FAILURE, not "no matches".
            return {
              ok: false,
              output: '',
              error: `search failed for "${pattern}": ${grepErr instanceof Error ? grepErr.message : String(grepErr)}`,
            };
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

      // NO FUZZY APPLICATION (H3). The old fuzzy mode replaced the first line whose
      // normalized text merely CONTAINED the first 30 chars of old_string — which can
      // hit the wrong line and corrupt the file while still reporting ok:true. When the
      // exact match fails we make NO change and ask the caller for an exact old_string.
      return {
        ok: false,
        output: '',
        error:
          `exact match failed — no changes made. old_string was not found verbatim in ${filePath}. ` +
          `Provide the exact text to replace (including whitespace and indentation).`,
      };
    } catch (err) {
      return { ok: false, output: '', error: `Patch failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  return handlers;
}

/**
 * Resolve a path INSIDE the workspace, rejecting any escape (absolute path, `~`,
 * or `..` traversal). Confinement is the same discipline the kernel uses for every
 * file/exec tool — previously this passed absolute/`~` paths through verbatim, which
 * let a tool read or write anywhere on disk (H2). A violation throws ToolError, which
 * the loop surfaces as a clean ok:false tool failure.
 */
function resolvePath(workspaceRoot: string, path: string): string {
  return resolveInWorkspace(workspaceRoot, path);
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
