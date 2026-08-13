// Build-time PDF generator for the CV.
//
// Renders index.html in headless Chromium (the same engine the browser uses),
// waits for the client-side runtime to mount, toggles each language, and prints
// the page to PDF with the print CSS applied. Produces two files at the repo
// root:  Michele-Panarotto-CV-EN.pdf  and  Michele-Panarotto-CV-IT.pdf
//
// Usage:
//   npm install            # installs playwright-core (see tools/package.json)
//   npm run pdf            # or: node tools/generate-pdfs.mjs
//
// The Chromium executable is auto-detected from a Playwright browser install
// (PLAYWRIGHT_BROWSERS_PATH) or can be forced with CHROME_PATH=/path/to/chrome.

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The page boots a client-side runtime that pulls React / ReactDOM / Babel from
// unpkg, and the stylesheet pulls the Barlow fonts from Google Fonts. Rather
// than depend on Chromium reaching those hosts (blocked or reset in some
// CI/sandbox networks), we pre-fetch them and fulfill via request interception,
// so the render is fully self-contained and pixel-identical to the browser.
const CDN = [
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone@7.29.0/babel.min.js',
];
// Must match the @import URL in styles.css exactly (Chromium requests it verbatim).
const FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;700&family=Barlow+Condensed:wght@400;600&display=swap';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

function ctypeFor(url) {
  if (url.endsWith('.css') || url.includes('/css2?')) return 'text/css; charset=utf-8';
  if (url.endsWith('.woff2')) return 'font/woff2';
  if (url.endsWith('.woff')) return 'font/woff';
  return 'text/javascript; charset=utf-8';
}

function fetchBuffer(url) {
  // curl honours the environment's proxy + CA bundle and is available in the
  // sandbox, on macOS and on Linux CI images alike.
  const ca = process.env.NODE_EXTRA_CA_CERTS || '/root/.ccr/ca-bundle.crt';
  const args = ['-sSL', '--fail', '-A', UA];
  if (existsSync(ca)) args.push('--cacert', ca);
  args.push(url);
  return execFileSync('curl', args, { maxBuffer: 64 * 1024 * 1024 });
}

// Returns Map<url, {body, type}> of every asset to fulfill offline.
function prefetchAssets() {
  const map = new Map();
  const add = (url, body) => { map.set(url, { body, type: ctypeFor(url) }); };

  for (const url of CDN) {
    add(url, fetchBuffer(url));
    console.log(`  ↓ ${url.replace('https://unpkg.com/', 'unpkg:')}`);
  }

  // Fonts CSS, then every font file it references.
  const css = fetchBuffer(FONTS_CSS);
  add(FONTS_CSS, css);
  const fontUrls = [...css.toString('utf8').matchAll(/url\((https:\/\/[^)]+)\)/g)].map((m) => m[1]);
  for (const url of [...new Set(fontUrls)]) {
    add(url, fetchBuffer(url));
  }
  console.log(`  ↓ Barlow fonts (${new Set(fontUrls).size} files)`);
  return map;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.pdf': 'application/pdf',
};

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (existsSync(base)) {
    for (const dir of readdirSync(base)) {
      if (!dir.startsWith('chromium-')) continue;
      const p = join(base, dir, 'chrome-linux', 'chrome');
      if (existsSync(p)) return p;
    }
  }
  return undefined; // let playwright-core resolve its own default
}

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (path === '/') path = '/index.html';
      const file = join(ROOT, path);
      if (!file.startsWith(ROOT) || !existsSync(file) || (await stat(file)).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(await readFile(file));
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server)));
}

async function renderLang(browser, base, lang, assets) {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.warn(`  [page:${lang}]`, m.text()); });

  // Serve cached CDN scripts + fonts offline; let localhost requests proceed.
  await page.route('**/*', (route) => {
    const hit = assets.get(route.request().url());
    if (hit) return route.fulfill({ status: 200, contentType: hit.type, body: hit.body });
    return route.continue();
  });

  await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait for the runtime to mount actual CV content, not just the shell
  // (the experience bullets are rendered inside the mounted stage).
  await page.waitForFunction(
    () => document.querySelectorAll('.cv-bullets li').length >= 5 &&
          document.querySelector('.cv-stage[data-lang]'),
    { timeout: 60000 },
  );

  // Click the toggle for the target language rather than assuming a default —
  // the page loads English-first, so both renders switch explicitly.
  await page.getByRole('button', { name: lang.toUpperCase(), exact: true }).click();
  await page.waitForFunction(
    (l) => document.querySelector('.cv-stage')?.getAttribute('data-lang') === l,
    lang,
    { timeout: 15000 },
  );

  await page.evaluate(() => document.fonts.ready);
  await page.emulateMedia({ media: 'print' });

  const out = join(ROOT, `Michele-Panarotto-CV-${lang.toUpperCase()}.pdf`);
  await page.pdf({ path: out, printBackground: true, preferCSSPageSize: true });
  await page.close();
  console.log(`  ✓ ${out.replace(ROOT + '/', '')}`);
  return out;
}

(async () => {
  const server = await startServer();
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const executablePath = findChrome();
  console.log(`Serving ${ROOT} at ${base}`);
  console.log(`Chromium: ${executablePath || '(playwright default)'}`);

  // All external assets are fulfilled from cache via request interception, so
  // Chromium itself needs no outbound network and no proxy configuration.
  const args = ['--no-sandbox'];
  console.log('Prefetching runtime scripts + fonts:');
  const assets = prefetchAssets();

  const browser = await chromium.launch({ headless: true, executablePath, args });
  try {
    for (const lang of ['en', 'it']) await renderLang(browser, base, lang, assets);
  } finally {
    await browser.close();
    server.close();
  }
  console.log('Done.');
})().catch((e) => { console.error(e); process.exit(1); });
