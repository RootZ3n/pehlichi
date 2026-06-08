/**
 * BROWSER TOOLS — Playwright-based web interaction tools.
 *
 * Tool names match Hermes: browser_navigate, browser_click, browser_type,
 * browser_press, browser_scroll, browser_snapshot, browser_vision,
 * browser_console, browser_back, browser_get_images.
 */
import type { ToolSpec, ToolHandler, ToolResult } from '../tools.js';
import {
  ensureBrowser,
  getSnapshot,
  getConsoleLogs,
  clearConsoleLogs,
} from './browser-manager.js';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });

/** Browser tool specs — advertised to the model. */
export const browserToolSpecs: ToolSpec[] = [
  {
    name: 'browser_navigate',
    description: 'Navigate to a URL. Initializes browser session if needed.',
    parameters: obj(
      { url: { type: 'string', description: 'URL to navigate to' } },
      ['url'],
    ),
  },
  {
    name: 'browser_click',
    description: 'Click an element by ref ID (e.g. @e5) from snapshot.',
    parameters: obj(
      { ref: { type: 'string', description: 'Element ref (e.g. @e5)' } },
      ['ref'],
    ),
  },
  {
    name: 'browser_type',
    description: 'Type text into an input field by ref ID.',
    parameters: obj(
      {
        ref: { type: 'string', description: 'Element ref (e.g. @e3)' },
        text: { type: 'string', description: 'Text to type' },
      },
      ['ref', 'text'],
    ),
  },
  {
    name: 'browser_press',
    description: 'Press a keyboard key (Enter, Tab, Escape, ArrowDown, etc).',
    parameters: obj(
      { key: { type: 'string', description: 'Key to press' } },
      ['key'],
    ),
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page up or down.',
    parameters: obj(
      { direction: { type: 'string', enum: ['up', 'down'], description: 'Direction to scroll' } },
      ['direction'],
    ),
  },
  {
    name: 'browser_snapshot',
    description: 'Get accessibility tree snapshot of current page.',
    parameters: obj(
      { full: { type: 'boolean', description: 'If true, return full page content' } },
      [],
    ),
  },
  {
    name: 'browser_vision',
    description: 'Take a screenshot and analyze it visually.',
    parameters: obj(
      { question: { type: 'string', description: 'What to look for in the screenshot' } },
      ['question'],
    ),
  },
  {
    name: 'browser_console',
    description: 'Get browser console output. Optionally evaluate JS expression.',
    parameters: obj(
      {
        expression: { type: 'string', description: 'JS expression to evaluate in page context' },
        clear: { type: 'boolean', description: 'Clear console buffer after reading' },
      },
      [],
    ),
  },
  {
    name: 'browser_back',
    description: 'Navigate back in browser history.',
    parameters: obj({}, []),
  },
  {
    name: 'browser_get_images',
    description: 'Get all images on the current page with URLs and alt text.',
    parameters: obj({}, []),
  },
];

/** Create browser tool handlers. */
export function createBrowserToolHandlers(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  handlers.set('browser_navigate', async (args): Promise<ToolResult> => {
    const url = args.url as string;
    try {
      const page = await ensureBrowser();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT });
      const snapshot = await getSnapshot(page);
      return { ok: true, output: `Navigated to ${url}\n\n${snapshot}` };
    } catch (err) {
      return { ok: false, output: '', error: `Navigation failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  handlers.set('browser_click', async (args): Promise<ToolResult> => {
    const ref = args.ref as string;
    try {
      const page = await ensureBrowser();
      const element = await findElementByRef(page, ref);
      if (!element) {
        return { ok: false, output: '', error: `Element ${ref} not found` };
      }
      await element.click({ timeout: DEFAULT_TIMEOUT });
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      const snapshot = await getSnapshot(page);
      return { ok: true, output: `Clicked ${ref}\n\n${snapshot}` };
    } catch (err) {
      return { ok: false, output: '', error: `Click failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  handlers.set('browser_type', async (args): Promise<ToolResult> => {
    const ref = args.ref as string;
    const text = args.text as string;
    try {
      const page = await ensureBrowser();
      const element = await findElementByRef(page, ref);
      if (!element) {
        return { ok: false, output: '', error: `Element ${ref} not found` };
      }
      await element.fill(text, { timeout: DEFAULT_TIMEOUT });
      return { ok: true, output: `Typed "${text}" into ${ref}` };
    } catch (err) {
      return { ok: false, output: '', error: `Type failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  handlers.set('browser_press', async (args): Promise<ToolResult> => {
    const key = args.key as string;
    try {
      const page = await ensureBrowser();
      await page.keyboard.press(key);
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      const snapshot = await getSnapshot(page);
      return { ok: true, output: `Pressed ${key}\n\n${snapshot}` };
    } catch (err) {
      return { ok: false, output: '', error: `Press failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  handlers.set('browser_scroll', async (args): Promise<ToolResult> => {
    const direction = args.direction as string;
    try {
      const page = await ensureBrowser();
      const delta = direction === 'up' ? -500 : 500;
      await page.mouse.wheel(0, delta);
      await new Promise((r) => setTimeout(r, 500));
      return { ok: true, output: `Scrolled ${direction}` };
    } catch (err) {
      return { ok: false, output: '', error: `Scroll failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  handlers.set('browser_snapshot', async (args): Promise<ToolResult> => {
    const full = (args.full as boolean) ?? false;
    try {
      const page = await ensureBrowser();
      const snapshot = await getSnapshot(page, full);
      return { ok: true, output: snapshot };
    } catch (err) {
      return { ok: false, output: '', error: `Snapshot failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  handlers.set('browser_vision', async (args): Promise<ToolResult> => {
    const question = args.question as string;
    try {
      const page = await ensureBrowser();
      const screenshotPath = join(tmpdir(), `browser-screenshot-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      mkdirSync(dirname(screenshotPath), { recursive: true });
      return {
        ok: true,
        output: `Screenshot saved to ${screenshotPath}\nQuestion: ${question}\nUse vision_analyze to analyze this image.`,
      };
    } catch (err) {
      return { ok: false, output: '', error: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  handlers.set('browser_console', async (args): Promise<ToolResult> => {
    const expression = args.expression as string | undefined;
    const clear = (args.clear as boolean) ?? false;
    try {
      const page = await ensureBrowser();
      let output = '';

      if (expression) {
        const result = await page.evaluate(expression);
        output = `Expression result: ${JSON.stringify(result, null, 2)}`;
      } else {
        const logs = getConsoleLogs();
        output = logs.length > 0
          ? logs.map((l) => `[${l.type}] ${l.text}`).join('\n')
          : '(no console output)';
      }

      if (clear) clearConsoleLogs();
      return { ok: true, output };
    } catch (err) {
      return { ok: false, output: '', error: `Console failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  handlers.set('browser_back', async (): Promise<ToolResult> => {
    try {
      const page = await ensureBrowser();
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT });
      const snapshot = await getSnapshot(page);
      return { ok: true, output: `Navigated back\n\n${snapshot}` };
    } catch (err) {
      return { ok: false, output: '', error: `Back failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  handlers.set('browser_get_images', async (): Promise<ToolResult> => {
    try {
      const page = await ensureBrowser();
      const images = await page.evaluate(() => {
        // This callback runs IN THE BROWSER CONTEXT (Playwright serializes it), where
        // `document` exists. Type the DOM access through globalThis so it compiles under
        // the Node tsconfig (no DOM lib) without changing runtime behavior.
        interface BrowserImage { src: string; alt: string; naturalWidth: number; naturalHeight: number }
        const doc = (globalThis as unknown as {
          document: { querySelectorAll(selector: string): Iterable<BrowserImage> };
        }).document;
        return Array.from(doc.querySelectorAll('img')).map((img) => ({
          url: img.src,
          alt: img.alt || '',
          width: img.naturalWidth,
          height: img.naturalHeight,
        }));
      });
      return {
        ok: true,
        output: images.length > 0
          ? JSON.stringify(images, null, 2)
          : '(no images on page)',
      };
    } catch (err) {
      return { ok: false, output: '', error: `Get images failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  return handlers;
}

const DEFAULT_TIMEOUT = 30_000;

/**
 * Find an interactive element by its ref ID from the accessibility snapshot.
 * Refs are assigned in order: @e0, @e1, @e2, etc.
 */
async function findElementByRef(page: import('playwright').Page, ref: string) {
  const index = parseInt(ref.replace('@e', ''), 10);
  if (isNaN(index)) return null;

  // Get all interactive elements in DOM order
  const elements = await page.$$(
    'a, button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"], [role="menuitem"], [role="tab"], [role="option"], [tabindex]'
  );

  return elements[index] ?? null;
}
