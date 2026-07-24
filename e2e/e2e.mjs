// End-to-end test with real browser pages and a 32 MB file:
//   client 1 downloads -> must come from the SERVER (becomes host)
//   client 2 downloads -> must come over P2P, throughput measured and asserted
//   client 3 downloads -> must come over P2P (two hosts now exist)
// Hash integrity is verified implicitly (client only marks "Done" after the
// SHA-256 matches the server's hash). Run with: npm test
import { spawn } from 'node:child_process';
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(__dirname, '..', 'server');
const FILES_DIR = path.join(SERVER_DIR, 'files');
const PORT = 3200;
const BASE = `http://localhost:${PORT}`;
const PERF_FILE = 'perf-32mb.bin';
const PERF_SIZE = 32 * 1024 * 1024;

const BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const executablePath = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));
if (!executablePath) {
  console.error('No Edge/Chrome executable found for e2e test.');
  process.exit(1);
}

// fresh test file so the server hashes it at boot
fs.writeFileSync(path.join(FILES_DIR, PERF_FILE), crypto.randomBytes(PERF_SIZE));

const server = spawn(process.execPath, [path.join(SERVER_DIR, 'index.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-e2e-dl-'));

async function openClient(name) {
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.error(`[${name} pageerror]`, err.message));
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() !== 'debug' || text.includes('[p2p')) console.log(`[${name} ${msg.type()}]`, text);
  });
  try {
    const cdp = await page.createCDPSession();
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
  } catch {
    /* older protocol — downloads still work */
  }
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForFunction(
    (fname) => [...document.querySelectorAll('.files .file strong')].some((el) => el.textContent === fname),
    { timeout: 15000, polling: 'mutation' },
    PERF_FILE
  );
  return page;
}

async function downloadFile(page, fileName) {
  const t0 = Date.now();
  await page.evaluate((fname) => {
    const rows = [...document.querySelectorAll('.files .file')];
    const row = rows.find((r) => r.querySelector('strong')?.textContent === fname);
    row.querySelector('button').click();
  }, fileName);
  await page.waitForFunction(
    (fname) => {
      const rows = [...document.querySelectorAll('.files .file')];
      const row = rows.find((r) => r.querySelector('strong')?.textContent === fname);
      return row && row.innerText.includes('DONE! saved via');
    },
    { timeout: 120000, polling: 'mutation' },
    fileName
  );
  const seconds = (Date.now() - t0) / 1000;
  const source = await page.evaluate((fname) => {
    const rows = [...document.querySelectorAll('.files .file')];
    const row = rows.find((r) => r.querySelector('strong')?.textContent === fname);
    const m = row.innerText.match(/DONE! saved via ([^.\n]+)/);
    return m ? m[1] : '';
  }, fileName);
  return { source, seconds };
}

try {
  await wait(2000);
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });

  // --- client 1: from the server, becomes the host ---
  const p1 = await openClient('p1');
  const r1 = await downloadFile(p1, PERF_FILE);
  console.log(`client 1: ${r1.source} (${r1.seconds.toFixed(1)}s)`);
  assert(r1.source.includes('server'), `client 1 should use server, got: ${r1.source}`);

  // --- client 2: P2P from client 1, with throughput assertion ---
  const p2 = await openClient('p2');
  const r2 = await downloadFile(p2, PERF_FILE);
  const mbps2 = PERF_SIZE / 1024 / 1024 / r2.seconds;
  console.log(`client 2: ${r2.source} (${r2.seconds.toFixed(1)}s, ${mbps2.toFixed(1)} MB/s)`);
  assert(r2.source.includes('P2P'), `client 2 should use P2P, got: ${r2.source}`);
  // Headless cross-renderer DataChannels manage ~7-8 MB/s here (~16 MB/s
  // same-page loopback). 6 MB/s catches pipeline regressions without flaking.
  assert(mbps2 > 6, `P2P throughput too low: ${mbps2.toFixed(1)} MB/s`);

  // --- client 3: P2P with two hosts available ---
  const p3 = await openClient('p3');
  const r3 = await downloadFile(p3, PERF_FILE);
  const mbps3 = PERF_SIZE / 1024 / 1024 / r3.seconds;
  console.log(`client 3: ${r3.source} (${r3.seconds.toFixed(1)}s, ${mbps3.toFixed(1)} MB/s)`);
  assert(r3.source.includes('P2P'), `client 3 should use P2P, got: ${r3.source}`);

  console.log('\nE2E TEST PASSED: server seeded once; clients redistributed via fast WebRTC P2P.');
  process.exitCode = 0;
} catch (err) {
  console.error('\nE2E TEST FAILED:', err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.kill();
  try {
    fs.rmSync(path.join(FILES_DIR, PERF_FILE), { force: true });
    fs.rmSync(downloadDir, { recursive: true, force: true });
  } catch {
    /* cleanup best-effort */
  }
}
