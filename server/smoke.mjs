// Smoke test: boots the server on a test port and verifies the REST API,
// static client serving, and the full signaling flow with fake peers.
// Run with: npm run smoke
import { spawn } from 'node:child_process';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3100;
const BASE = `http://localhost:${PORT}`;

const server = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function wsClient() {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const stash = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else stash.push(msg);
  });
  const waitFor = (pred, ms = 5000, label = 'message') => {
    const hit = stash.findIndex(pred);
    if (hit >= 0) return Promise.resolve(stash.splice(hit, 1)[0]);
    return new Promise((resolve, reject) => {
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
    });
  };
  return new Promise((res) =>
    ws.on('open', () => res({ ws, waitFor, send: (o) => ws.send(JSON.stringify(o)) }))
  );
}

try {
  await wait(1500); // boot + hash files

  // --- REST API ---
  const files = await (await fetch(`${BASE}/api/files`)).json();
  assert(files.length > 0, 'no files listed by /api/files');
  const f0 = files[0];
  assert(/^[0-9a-f]{64}$/.test(f0.sha256), 'bad sha256 in file listing');

  const dl = await fetch(`${BASE}/files/${encodeURIComponent(f0.name)}`);
  assert(dl.ok, 'direct file download failed');
  const buf = Buffer.from(await dl.arrayBuffer());
  assert.equal(buf.length, f0.size, 'downloaded size mismatch');

  const cfg = await (await fetch(`${BASE}/api/config`)).json();
  assert(Array.isArray(cfg.iceServers) && cfg.iceServers.length > 0, 'no ICE servers in config');

  // --- static client ---
  const html = await (await fetch(`${BASE}/`)).text();
  assert(html.includes('id="root"'), 'index.html not served');
  const assetMatch = html.match(/src="(\/assets\/[^"]+)"/);
  if (assetMatch) {
    const asset = await fetch(`${BASE}${assetMatch[1]}`);
    assert(asset.ok, 'built JS asset not served');
  }

  // --- signaling: no host yet -> http ---
  const x = await wsClient();
  await x.waitFor((m) => m.t === 'welcome', 5000, 'welcome');
  x.send({ t: 'want', file: f0.name });
  const srcX = await x.waitFor((m) => m.t === 'source' && m.file === f0.name, 5000, 'source');
  assert.equal(srcX.source, 'http', 'first peer should get http source');
  x.ws.close();

  // --- signaling: peer A hosts -> peer B gets p2p source = A ---
  const a = await wsClient();
  const aw = await a.waitFor((m) => m.t === 'welcome', 5000, 'welcome');
  a.send({ t: 'have', file: f0.name });

  const b = await wsClient();
  const bw = await b.waitFor((m) => m.t === 'welcome', 5000, 'welcome');
  b.send({ t: 'want', file: f0.name });
  const srcB = await b.waitFor((m) => m.t === 'source' && m.file === f0.name, 5000, 'source');
  assert.equal(srcB.source, 'p2p', 'second peer should get p2p source');
  assert.equal(srcB.seeder, aw.id, 'seeder should be peer A');

  // excluding the only host -> fall back to http
  b.send({ t: 'want', file: f0.name, exclude: [aw.id] });
  const srcB2 = await b.waitFor((m) => m.t === 'source' && m.file === f0.name, 5000, 'source');
  assert.equal(srcB2.source, 'http', 'excluding all hosts should yield http source');

  // stats broadcast should report 1 seeder for the file
  const stats = await b.waitFor((m) => m.t === 'stats' && (m.seeders[f0.name] || 0) >= 1, 5000, 'stats');

  // --- signaling: offer relay B -> A ---
  b.send({ t: 'signal', to: aw.id, data: { conn: 'c1', file: f0.name, kind: 'offer', sdp: 'fake-sdp' } });
  const relayed = await a.waitFor((m) => m.t === 'signal', 5000, 'signal relay');
  assert.equal(relayed.from, bw.id, 'relay should carry sender id');
  assert.equal(relayed.data.kind, 'offer');

  // --- unknown file -> error ---
  const c = await wsClient();
  await c.waitFor((m) => m.t === 'welcome', 5000, 'welcome');
  c.send({ t: 'want', file: 'does-not-exist.bin' });
  const srcC = await c.waitFor((m) => m.t === 'source', 5000, 'source');
  assert.equal(srcC.source, 'error', 'unknown file should yield error source');

  a.ws.close();
  b.ws.close();
  c.ws.close();

  console.log('\nSMOKE TEST: all checks passed');
  process.exitCode = 0;
} catch (err) {
  console.error('\nSMOKE TEST FAILED:', err);
  process.exitCode = 1;
} finally {
  server.kill();
}
