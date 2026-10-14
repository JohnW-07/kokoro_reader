// Shared plumbing for the e2e checks: the environment they read, Playwright, the pywebview CSS,
// the server API, and the PASS/FAIL bookkeeping. Each check runs as its own node process, so the
// `failures` list here belongs to that one run.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const BASE_URL = process.env.KOKORO_URL || 'http://127.0.0.1:8765/';
export const EMULATE_PYWEBVIEW = process.env.EMULATE_PYWEBVIEW !== '0';
export const SHOT_DIR = process.env.SHOT_DIR || join(tmpdir(), 'kokoro-e2e-shots');
export const ENGINE = process.env.BROWSER === 'webkit' ? 'webkit' : 'chromium';
export const VIEWPORT = { width: 1440, height: 900 };

/** An environment variable the check cannot run without: exit 2 with `hint` when it is unset. */
export function requireEnv(name, hint) {
  const value = process.env[name];
  if (value) return value;
  console.error(`${name} is not set. ${hint}`);
  process.exit(2);
}

const failures = [];
export const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${detail}`}`);
  if (!cond) failures.push(name);
};

/**
 * A precondition. Unlike `check` it stops the run: a case that could not reach the thing
 * it is meant to test must not report a pass with fewer checks in it.
 */
export const must = (name, cond, detail = '') => {
  check(name, cond, detail);
  if (!cond) throw new Error(`precondition failed: ${name}${detail ? `  ${detail}` : ''}`);
};

async function loadPlaywright() {
  const dir = process.env.PLAYWRIGHT_DIR;
  if (!dir) return import('playwright');
  const candidates = [join(dir, 'playwright', 'index.mjs'), join(dir, 'index.mjs')];
  const entry = candidates.find(existsSync);
  if (!entry) throw new Error(`PLAYWRIGHT_DIR=${dir} holds no playwright/index.mjs or index.mjs`);
  return import(pathToFileURL(entry).href);
}

/** The exact CSS pywebview injects when text_select is False, from the installed package. */
function pywebviewNoSelectCss() {
  const lib = join(ROOT, 'venv', 'lib');
  const python = existsSync(lib) ? readdirSync(lib).find((d) => d.startsWith('python')) : null;
  const file = python && join(lib, python, 'site-packages', 'webview', 'js', 'customize.js');
  if (!file || !existsSync(file)) throw new Error(`pywebview customize.js not found under ${lib}`);
  const css = /disableTextCss\s*=\s*'([^']+)'/.exec(readFileSync(file, 'utf8'));
  if (!css) throw new Error(`no disableTextCss in ${file}; pywebview changed how it disables selection`);
  return css[1];
}

export async function api(path, init) {
  const res = await fetch(new URL(path, BASE_URL), init);
  if (!res.ok) throw new Error(`${init?.method || 'GET'} ${path} → HTTP ${res.status}`);
  return res.json();
}

export const docIdOf = (path) => createHash('sha1').update(readFileSync(path)).digest('hex');

async function openPage(browser) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  if (EMULATE_PYWEBVIEW) {
    const css = pywebviewNoSelectCss();
    await context.addInitScript((rule) => addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = rule;
      document.head.appendChild(style);
    }), css);
  }
  return context.newPage();
}

/**
 * Launch the engine and open one page at VIEWPORT, with pywebview's CSS injected unless
 * EMULATE_PYWEBVIEW=0. Page errors and console errors (bar a missing favicon) go into `errors`.
 */
export async function launch(errors) {
  const { chromium, webkit } = await loadPlaywright();
  const engine = ENGINE === 'webkit' ? webkit : chromium;
  const browser = await engine.launch(process.env.CHROMIUM_PATH && engine === chromium
    ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await openPage(browser).catch(async (err) => {
    await browser.close();
    throw err;
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    const favicon = /\/favicon\.ico$/.test(msg.location().url || '');
    if (msg.type() === 'error' && !favicon) errors.push(`console: ${msg.text()}`);
  });
  console.log(`${ENGINE} · ${BASE_URL} · pywebview CSS ${EMULATE_PYWEBVIEW ? 'on' : 'off'}`);
  return { browser, page };
}

/** No check runs this long: past it the run fails instead of hanging (C1b: one hung for 3.5 h). */
export const RUN_DEADLINE_MS = 10 * 60 * 1000;

/**
 * Run the check, print the verdict and exit: 0 = pass, 1 = fail (a thrown error is a failure,
 * and so is overrunning `deadlineMs` — process.exit then takes the browser down with it).
 */
export async function finish(run, deadlineMs = RUN_DEADLINE_MS) {
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`run exceeded its ${deadlineMs} ms deadline`)), deadlineMs);
  });
  try {
    await Promise.race([run(), deadline]);
  } catch (err) {
    console.error(`ERROR  ${err.stack || err.message}`);
    failures.push(err.message);
  }
  clearTimeout(timer);
  console.log(`\n${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}
