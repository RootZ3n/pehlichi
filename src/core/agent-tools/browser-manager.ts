/**
 * BROWSER MANAGER — Playwright-based browser control.
 *
 * Manages a single browser instance with page lifecycle.
 * Used by browser_* tools for web interaction.
 */
import { chromium, type Browser, type BrowserContext, type Page, type ConsoleMessage } from 'playwright';

export interface BrowserState {
  browser: Browser | null;
  context: BrowserContext | null;
  page: Page | null;
  consoleLogs: ConsoleEntry[];
  networkErrors: string[];
}

export interface ConsoleEntry {
  type: string;
  text: string;
  timestamp: number;
}

const state: BrowserState = {
  browser: null,
  context: null,
  page: null,
  consoleLogs: [],
  networkErrors: [],
};

const MAX_CONSOLE_LOGS = 500;

export async function ensureBrowser(): Promise<Page> {
  if (state.page && !state.page.isClosed()) return state.page;

  state.browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  state.context = await state.browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  state.page = await state.context.newPage();
  state.consoleLogs = [];
  state.networkErrors = [];

  // Capture console
  state.page.on('console', (msg: ConsoleMessage) => {
    state.consoleLogs.push({
      type: msg.type(),
      text: msg.text(),
      timestamp: Date.now(),
    });
    if (state.consoleLogs.length > MAX_CONSOLE_LOGS) {
      state.consoleLogs.shift();
    }
  });

  // Capture network errors
  state.page.on('requestfailed', (req) => {
    state.networkErrors.push(`${req.failure()?.errorText || 'unknown'}: ${req.url()}`);
    if (state.networkErrors.length > 100) {
      state.networkErrors.shift();
    }
  });

  return state.page;
}

export async function closeBrowser(): Promise<void> {
  if (state.browser) {
    await state.browser.close().catch(() => {});
    state.browser = null;
    state.context = null;
    state.page = null;
    state.consoleLogs = [];
    state.networkErrors = [];
  }
}

export function getState(): BrowserState {
  return state;
}

export function getConsoleLogs(type?: string): ConsoleEntry[] {
  if (type) {
    return state.consoleLogs.filter((l) => l.type === type);
  }
  return [...state.consoleLogs];
}

export function clearConsoleLogs(): void {
  state.consoleLogs = [];
  state.networkErrors = [];
}

/**
 * Get accessibility snapshot of the current page.
 * Returns a tree of accessible elements with refs.
 */
export async function getSnapshot(page: Page, full = false): Promise<string> {
  // `page.accessibility` is a deprecated Playwright API no longer in the typings; access it
  // through a precise structural type so the runtime call is preserved where it still exists.
  const accessibility = (page as unknown as {
    accessibility: { snapshot(options: { interestingOnly: boolean }): Promise<unknown> };
  }).accessibility;
  const snapshot = await accessibility.snapshot({ interestingOnly: !full });
  if (!snapshot) return '(empty page)';

  const lines: string[] = [];
  let refCounter = 0;

  function walk(node: any, depth: number) {
    const indent = '  '.repeat(depth);
    const ref = `@e${refCounter++}`;
    const role = node.role || '';
    const name = node.name ? ` "${node.name}"` : '';
    const value = node.value ? ` value="${node.value}"` : '';
    const checked = node.checked !== undefined ? ` checked=${node.checked}` : '';
    const disabled = node.disabled ? ' [disabled]' : '';

    if (role && (role !== 'none' && role !== 'presentation' || depth === 0)) {
      const interactive = ['link', 'button', 'textbox', 'checkbox', 'radio', 'combobox', 'menuitem', 'tab', 'option'].includes(role);
      const refTag = interactive ? ` [${ref}]` : '';
      lines.push(`${indent}${role}${name}${value}${checked}${disabled}${refTag}`);
    }

    if (node.children) {
      for (const child of node.children) {
        walk(child, depth + 1);
      }
    }
  }

  walk(snapshot, 0);
  return lines.join('\n');
}
