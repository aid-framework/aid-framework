/**
 * The behaviour gate: loads the built site in a real browser.
 *
 * `check-a11y.mjs` reads the HTML a browser receives on the first byte. That cannot see
 * contrast, because the values come from CSS custom properties, and it cannot see
 * anything that only exists after hydration. This script fills both gaps:
 *
 *   1. axe-core on every built page in light and dark, failing on `serious` and
 *      `critical` violations of WCAG 2.0/2.1/2.2 A and AA.
 *   2. Keyboard checks for the things axe does not model: focus after the skip link,
 *      focus into and out of the search dialog, focus into and out of the mobile
 *      navigation, and the accessible name of the search control.
 *
 * Run `pnpm docs:build` first. `A11Y_BROWSER_CHANNEL=msedge` uses an installed browser
 * instead of Playwright's download; CI installs chromium and leaves it unset.
 */
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright';

const distRoot = fileURLToPath(new URL('../.vitepress/dist', import.meta.url));
const HOST = '127.0.0.1';
const BASE = '/aid-framework/';
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const SEARCH_SHORTCUT = process.platform === 'darwin' ? 'Meta+K' : 'Control+K';

const MIME = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

const failures = [];
const advisories = [];

/**
 * @param {boolean} condition
 * @param {string} label
 * @param {string} [detail]
 * @returns {boolean}
 */
function check(condition, label, detail) {
  if (condition) {
    console.log(`[browser-a11y] ok   ${label}`);
  } else {
    const line = detail === undefined ? label : `${label} (${detail})`;
    failures.push(line);
    console.error(`[browser-a11y] FAIL ${line}`);
  }
  return condition;
}

/**
 * @param {{ target: (string | string[])[]; any?: { data?: Record<string, unknown> }[] }} node
 * @returns {string} the selector, plus the measured colours when axe recorded them.
 */
function describeNode(node) {
  const target = node.target.map(String).join(' ');
  const data = node.any?.[0]?.data ?? {};
  const ratio = data.contrastRatio;
  if (typeof ratio !== 'number') return target;
  return `${target}: ${String(data.fgColor)} on ${String(data.bgColor)} = ${ratio.toFixed(2)}:1`;
}

/**
 * @param {string} dir
 * @returns {string[]} every `.html` file below `dir`, sorted.
 */
function htmlFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...htmlFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.html')) found.push(full);
  }
  return found.sort();
}

/**
 * @param {string} file
 * @returns {string} the route the file is served at, including the Pages base path.
 */
function routeOf(file) {
  const rel = relative(distRoot, file).split(sep).join('/');
  if (rel === 'index.html') return BASE;
  if (rel.endsWith('/index.html')) return `${BASE}${rel.slice(0, -'index.html'.length)}`;
  return `${BASE}${rel.slice(0, -'.html'.length)}`;
}

/**
 * @param {string} pathname
 * @returns {string | null} the file to send, or null when it does not exist.
 */
function resolve(pathname) {
  if (!pathname.startsWith(BASE)) return null;

  let rel;
  try {
    rel = decodeURIComponent(pathname.slice(BASE.length));
  } catch {
    return null;
  }
  if (rel.includes('..')) return null;

  const candidates =
    rel === '' || rel.endsWith('/')
      ? [`${rel}index.html`]
      : [rel, `${rel}.html`, `${rel}/index.html`];

  for (const candidate of candidates) {
    const file = join(distRoot, candidate);
    if (!file.startsWith(distRoot + sep)) continue;
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

if (!existsSync(distRoot)) {
  console.error(`[browser-a11y] no build at ${distRoot}; run "pnpm docs:build" first`);
  process.exit(1);
}

const pages = htmlFiles(distRoot).map((file) => ({
  label: relative(distRoot, file),
  route: routeOf(file),
}));

if (pages.length === 0) {
  console.error(`[browser-a11y] no pages found in ${distRoot}`);
  process.exit(1);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${HOST}`);
  const file = resolve(url.pathname);

  if (file === null) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
    return;
  }

  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': MIME.get(extname(file)) ?? 'application/octet-stream',
  });
  createReadStream(file).pipe(response);
});

/**
 * @param {string} origin
 * @param {import('playwright').Page} page
 * @param {string} route
 */
async function open(origin, page, route) {
  await page.goto(`${origin}${route}`, { waitUntil: 'load' });
  // The appearance switch starts with an empty `title` in SSR; the theme fills it in a
  // `watchPostEffect`. A non-empty title therefore means Vue has mounted and the
  // handlers this gate exercises are attached.
  await page.waitForFunction(
    () => {
      const toggle = document.querySelector('.VPSwitchAppearance');
      return toggle !== null && (toggle.getAttribute('title') ?? '') !== '';
    },
    undefined,
    { timeout: 20_000 },
  );
}

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<string>} a short description of the focused element.
 */
async function readFocus(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (element === null) return '<body>';
    const className = typeof element.className === 'string' ? element.className : '';
    return `${element.tagName.toLowerCase()}.${className} ${element.id}`.trim();
  });
}

/**
 * Drives the theme through its own control so `aria-checked` and the `dark` class stay
 * in sync; then waits for styles to settle before axe measures them.
 *
 * @param {import('playwright').Page} page
 * @param {'light' | 'dark'} theme
 */
async function setTheme(page, theme) {
  const wanted = theme === 'dark';
  const current = await page.evaluate(() => document.documentElement.classList.contains('dark'));

  if (current !== wanted) {
    await page.click('.VPSwitchAppearance');
    await page.waitForFunction(
      (dark) => document.documentElement.classList.contains('dark') === dark,
      wanted,
      { timeout: 5_000 },
    );
  }

  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(resolve);
        });
      }),
  );
}

/**
 * @param {string} origin
 * @param {import('playwright').Page} page
 */
async function keyboardChecks(origin, page) {
  await open(origin, page, BASE);

  await page.keyboard.press('Tab');
  const firstStop = await readFocus(page);
  check(firstStop.includes('VPSkipLink'), 'the first Tab stop is the skip link', firstStop);

  await page.keyboard.press('Enter');
  const afterSkip = await page.evaluate(() => document.activeElement?.id ?? '');
  check(afterSkip === 'VPContent', 'the skip link moves focus to the main content', afterSkip);

  const beforeToggle = await page.evaluate(() =>
    document.documentElement.classList.contains('dark'),
  );
  await page.click('.VPSwitchAppearance');
  await page.waitForFunction(
    (was) => document.documentElement.classList.contains('dark') !== was,
    beforeToggle,
    { timeout: 5_000 },
  );
  await page.click('.VPSwitchAppearance');
  await page.waitForFunction(
    (was) => document.documentElement.classList.contains('dark') === was,
    beforeToggle,
    { timeout: 5_000 },
  );
  check(true, 'the appearance switch toggles the theme in both directions');

  const searchChrome = await page.evaluate(() => {
    const button = document.querySelector('.DocSearch-Button');
    if (button === null) return null;
    return {
      keys: button.getAttribute('aria-keyshortcuts'),
      keysHidden: button.querySelector('.DocSearch-Button-Keys')?.getAttribute('aria-hidden'),
      label: button.getAttribute('aria-label'),
    };
  });
  check(searchChrome !== null, 'the search control is present');
  check(
    (searchChrome?.label ?? '').toLowerCase().startsWith('search'),
    'the search control name starts with its visible text',
    JSON.stringify(searchChrome?.label ?? null),
  );
  check(
    searchChrome?.keys === SEARCH_SHORTCUT,
    'the search control advertises its shortcut',
    JSON.stringify(searchChrome?.keys ?? null),
  );
  check(
    searchChrome?.keysHidden === 'true',
    'the shortcut keycaps are hidden from the accessible name',
    JSON.stringify(searchChrome?.keysHidden ?? null),
  );

  await page.click('.DocSearch-Button');
  await page.waitForSelector('.VPLocalSearchBox', { state: 'visible' });
  const inputFocused = await page.evaluate(() => {
    const element = document.activeElement;
    return element instanceof HTMLInputElement && element.type === 'search';
  });
  check(inputFocused, 'opening search moves focus into the dialog', await readFocus(page));

  await page.keyboard.type('retrieval');
  await page.waitForSelector('.VPLocalSearchBox .result', { state: 'visible', timeout: 20_000 });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.VPLocalSearchBox', { state: 'detached' });
  await page.waitForFunction(
    () => document.activeElement?.classList.contains('DocSearch-Button'),
    undefined,
    {
      timeout: 5_000,
    },
  );
  check(true, 'closing search returns focus to the search control', await readFocus(page));

  await page.setViewportSize({ width: 390, height: 844 });
  await open(origin, page, BASE);

  await page.click('.VPNavBarHamburger');
  await page.waitForSelector('.VPNavScreen', { state: 'visible' });
  await page.waitForFunction(
    () => document.querySelector('.VPNavBarHamburger')?.getAttribute('aria-expanded') === 'true',
  );
  const focusInside = await page.evaluate(() => {
    const screen = document.querySelector('.VPNavScreen');
    return (
      screen !== null && document.activeElement !== null && screen.contains(document.activeElement)
    );
  });
  check(focusInside, 'opening the mobile navigation moves focus into it', await readFocus(page));

  for (let index = 0; index < 40; index += 1) await page.keyboard.press('Tab');
  const stillInside = await page.evaluate(() => {
    const screen = document.querySelector('.VPNavScreen');
    const toggle = document.querySelector('.VPNavBarHamburger');
    return (
      screen !== null &&
      (screen.contains(document.activeElement) || document.activeElement === toggle)
    );
  });
  check(stillInside, 'Tab stays inside the mobile navigation', await readFocus(page));

  await page.keyboard.press('Escape');
  await page.waitForSelector('.VPNavScreen', { state: 'detached' });
  await page.waitForFunction(
    () => {
      const toggle = document.querySelector('.VPNavBarHamburger');
      return toggle?.getAttribute('aria-expanded') === 'false' && document.activeElement === toggle;
    },
    undefined,
    { timeout: 5_000 },
  );
  check(true, 'Escape closes the mobile navigation and returns focus to its toggle');

  await page.setViewportSize({ width: 1280, height: 900 });
}

let browser;

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');
  const origin = `http://${HOST}:${address.port}`;

  const channel = process.env.A11Y_BROWSER_CHANNEL;
  browser = await chromium.launch({
    headless: true,
    ...(channel === undefined || channel === '' ? {} : { channel }),
  });

  const context = await browser.newContext({
    colorScheme: 'light',
    reducedMotion: 'reduce',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  for (const { label, route } of pages) {
    await open(origin, page, route);

    for (const theme of ['light', 'dark']) {
      await setTheme(page, theme);
      const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();

      let blocking = 0;
      for (const violation of violations) {
        const nodes = violation.nodes
          .slice(0, 3)
          .map((node) => describeNode(node))
          .join(' | ');
        const line = `${label} [${theme}] ${violation.id} (${violation.impact}, ${violation.nodes.length}x): ${violation.help} — ${nodes}`;

        if (violation.impact === 'serious' || violation.impact === 'critical') {
          blocking += 1;
          failures.push(line);
          console.error(`[browser-a11y] FAIL ${line}`);
        } else {
          advisories.push(line);
        }
      }

      console.log(
        `[browser-a11y] ${label} [${theme}]: ${blocking} blocking, ${violations.length - blocking} advisory`,
      );
    }
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  await keyboardChecks(origin, page);

  await context.close();
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}

if (advisories.length > 0) {
  console.log(`[browser-a11y] ${advisories.length} advisory violation(s):`);
  for (const line of advisories) console.log(`  - ${line}`);
}

if (failures.length > 0) {
  console.error(`[browser-a11y] ${failures.length} failure(s) across ${pages.length} page(s)`);
  process.exitCode = 1;
} else {
  console.log(`[browser-a11y] ${pages.length} page(s) clean in light and dark`);
}
