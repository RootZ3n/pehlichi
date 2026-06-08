/**
 * WEB TOOLS — web search and content extraction.
 *
 * Tool names match Hermes: web_search, web_extract.
 */
import type { ToolSpec, ToolHandler, ToolResult } from '../tools.js';

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });

export const webToolSpecs: ToolSpec[] = [
  {
    name: 'web_search',
    description: 'Search the web. Returns titles, URLs, and descriptions.',
    parameters: obj(
      {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 5)' },
      },
      ['query'],
    ),
  },
  {
    name: 'web_extract',
    description: 'Extract content from web page URLs. Returns markdown.',
    parameters: obj(
      { urls: { type: 'array', items: { type: 'string' }, description: 'URLs to extract (max 5)' } },
      ['urls'],
    ),
  },
];

/** Search provider — uses DuckDuckGo HTML (no API key needed). */
async function ddgSearch(query: string, limit: number): Promise<Array<{ url: string; title: string; description: string }>> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
  });
  const html = await response.text();

  // Parse results from DDG HTML
  const results: Array<{ url: string; title: string; description: string }> = [];
  const resultRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/gi;

  let match;
  while ((match = resultRegex.exec(html)) !== null && results.length < limit) {
    const href = match[1]!; // groups 1-3 are present when the regex matched
    const title = match[2]!.replace(/<[^>]+>/g, '').trim();
    const desc = match[3]!.replace(/<[^>]+>/g, '').trim();

    // DDG redirects through //duckduckgo.com/l/?uddg=...
    let finalUrl = href;
    const uddgMatch = href.match(/uddg=([^&]+)/);
    if (uddgMatch) {
      finalUrl = decodeURIComponent(uddgMatch[1]!);
    }

    if (title && finalUrl.startsWith('http')) {
      results.push({ url: finalUrl, title, description: desc });
    }
  }

  return results;
}

/** Extract readable content from a URL using basic HTML parsing. */
async function extractContent(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
    });
    const contentType = response.headers.get('content-type') || '';

    // Handle plain text
    if (contentType.includes('text/plain')) {
      return await response.text();
    }

    // Handle JSON
    if (contentType.includes('application/json')) {
      const data = await response.json();
      return JSON.stringify(data, null, 2);
    }

    // Handle HTML — extract readable text
    const html = await response.text();
    return htmlToMarkdown(html, url);
  } catch (err) {
    return `Failed to extract ${url}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Basic HTML to markdown conversion. */
function htmlToMarkdown(html: string, _baseUrl: string): string {
  let text = html;

  // Remove scripts, styles, nav, footer, header
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, '');

  // Convert headings
  text = text.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n');
  text = text.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n');
  text = text.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n');
  text = text.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n\n');

  // Convert links
  text = text.replace(/<a[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');

  // Convert paragraphs and breaks
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<p[^>]*>/gi, '\n\n');
  text = text.replace(/<\/p>/gi, '');

  // Convert lists
  text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n');

  // Remove all remaining tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');

  // Clean up whitespace
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  // Truncate if too long
  if (text.length > 50_000) {
    text = text.slice(0, 50_000) + '\n\n[truncated]';
  }

  return text;
}

export function createWebToolHandlers(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  handlers.set('web_search', async (args): Promise<ToolResult> => {
    const query = args.query as string;
    const limit = (args.limit as number) ?? 5;
    try {
      const results = await ddgSearch(query, limit);
      if (results.length === 0) {
        return { ok: true, output: `No results for "${query}"` };
      }
      const output = results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description}`).join('\n\n');
      return { ok: true, output };
    } catch (err) {
      return { ok: false, output: '', error: `Search failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  handlers.set('web_extract', async (args): Promise<ToolResult> => {
    const urls = args.urls as string[];
    if (!urls || urls.length === 0) {
      return { ok: false, output: '', error: 'urls is required' };
    }
    if (urls.length > 5) {
      return { ok: false, output: '', error: 'Max 5 URLs per call' };
    }
    try {
      const results = await Promise.all(urls.map(async (url) => {
        const content = await extractContent(url);
        return `## ${url}\n\n${content}`;
      }));
      return { ok: true, output: results.join('\n\n---\n\n') };
    } catch (err) {
      return { ok: false, output: '', error: `Extract failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  return handlers;
}
