// Local-node test: boots a "VPS" instance and a local-node instance, then
// verifies the node mirrors the files (hash-verified), registers itself, and
// that clients from the same public IP get offered the node via /api/config.
// Run with: npm run test:node
import { spawn } from 'node:child_process';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VPS_PORT = 3151;
const NODE_PORT = 3152;
const VPS = `http://localhost:${VPS_PORT}`;
const NODE = `http://localhost:${NODE_PORT}`;
const SECRET = 'test-secret';

const nodeFilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-node-files-'));

function startServer(env, label) {
  const proc = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  proc.stdout.on('data', (d) => process.stdout.write(`[${label}] ${d}`));
  return proc;
}

const vps = startServer({ PORT: String(VPS_PORT), NODE_SECRET: SECRET }, 'vps');
const node = startServer(
  {
    PORT: String(NODE_PORT),
    FILES_DIR: nodeFilesDir,
    UPSTREAM: VPS,
    PUBLIC_URL: NODE,
    NODE_SECRET: SECRET,
  },
  'node'
);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(fn, { timeout = 20000, interval = 500 } = {}) {
  const deadline = Date.now() + timeout;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await wait(interval);
    }
  }
  throw lastErr;
}

try {
  // 1. node mirrors the VPS's files into its empty FILES_DIR (hash-verified)
  const upstreamFiles = await poll(async () => {
    const r = await fetch(`${VPS}/api/files`);
    const list = await r.json();
    assert(list.length > 0, 'VPS has no files');
    return list;
  });

  const nodeFiles = await poll(async () => {
    const r = await fetch(`${NODE}/api/files`);
    const list = await r.json();
    assert.equal(list.length, upstreamFiles.length, 'node file count mismatch');
    return list;
  });

  for (const f of upstreamFiles) {
    const onNode = nodeFiles.find((n) => n.name === f.name);
    assert(onNode, `node missing ${f.name}`);
    assert.equal(onNode.sha256, f.sha256, `hash mismatch for ${f.name}`);
    assert(fs.existsSync(path.join(nodeFilesDir, f.name)), `${f.name} not on node disk`);
  }
  console.log('node sync: all files mirrored with matching hashes');

  // 2. node serves a mirrored file
  const dl = await fetch(`${NODE}/files/${encodeURIComponent(upstreamFiles[0].name)}`);
  assert(dl.ok, 'node file download failed');
  assert.equal(Number(dl.headers.get('content-length')), upstreamFiles[0].size, 'node download size mismatch');

  // 3. node registered itself; same-IP client gets localNode in /api/config
  await poll(async () => {
    const r = await fetch(`${VPS}/api/config`);
    const cfg = await r.json();
    assert.equal(cfg.localNode, NODE, `expected localNode=${NODE}, got ${cfg.localNode}`);
  });
  console.log('node registration: /api/config offers the local node to same-IP clients');

  // 4. registration requires the secret
  const bad = await fetch(`${VPS}/api/node-register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: 'wrong', url: 'http://evil.example' }),
  });
  assert.equal(bad.status, 403, 'bad secret should be rejected');

  // 5. manifest internals are not exposed as downloadable files
  const names = nodeFiles.map((f) => f.name);
  assert(!names.some((n) => n.startsWith('.')), 'dotfiles leaked into catalog');

  console.log('\nNODE TEST: all checks passed');
  process.exitCode = 0;
} catch (err) {
  console.error('\nNODE TEST FAILED:', err);
  process.exitCode = 1;
} finally {
  vps.kill();
  node.kill();
  try {
    fs.rmSync(nodeFilesDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
