// engine.mjs -- launch the REQUESTED browser engine for a witness, with the
// guards every browser witness shares: --engine never defaults; no fallback
// to another engine if the requested one will not launch; Playwright's
// launcher type must equal the request; and a page's own user-agent
// fingerprint (detectEngine, run inside the page) must equal it too.
// Requires playwright-core (or playwright) resolvable from the invoking
// directory and the browser installed (npx playwright install <engine>);
// CHROMIUM=/FIREFOX=/WEBKIT=<path> override the executable for their own
// engine only.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

export const ENGINES = ['chromium', 'firefox', 'webkit'];

/* the engine a page is running on, from its user agent -- a function body
   for page.evaluate; the launcher type is the authoritative guard, this is
   the in-page cross-check */
export function detectEngine() {
  const ua = navigator.userAgent;
  return /Firefox\//.test(ua) ? 'firefox'
       : /Chrome\//.test(ua) ? 'chromium'
       : /AppleWebKit\//.test(ua) ? 'webkit' : 'unknown';
}

/* returns the browser, or exits the process with the FATAL line */
export async function launch(engine, onFatal) {
  const require = createRequire(resolve(process.cwd(), 'noop.js'));
  let pw;
  try { pw = require('playwright-core'); } catch { pw = require('playwright'); }   // either package exports the browser types
  const browserType = pw[engine];
  const exeVar = { chromium: 'CHROMIUM', firefox: 'FIREFOX', webkit: 'WEBKIT' }[engine];
  const exePath = process.env[exeVar] && existsSync(process.env[exeVar]) ? process.env[exeVar] : undefined;
  let browser;
  try {
    browser = await browserType.launch(exePath ? { executablePath: exePath } : {});
  } catch (e) {
    console.error(`FATAL: could not launch ${engine} (no fallback to another engine): ${e.message}`);
    onFatal?.();
    process.exit(3);
  }
  const launched = browser.browserType().name();
  if (launched !== engine) {
    console.log(`ENGINE MISMATCH (launcher): requested ${engine}, launched ${launched}`);
    await browser.close();
    onFatal?.();
    process.exit(1);
  }
  return browser;
}
