import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { startSync, startNodeRegistration } from './sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const FILES_DIR = process.env.FILES_DIR || path.join(__dirname, 'files');
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');

fs.mkdirSync(FILES_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// File catalog: scans FILES_DIR and keeps { name, size, sha256 } per file.
// The hash lets clients verify integrity after a P2P transfer.
// ---------------------------------------------------------------------------
const catalog = new Map(); // name -> { name, size, mtimeMs, sha256 }
let serverBytesServed = 0;
let p2pBytesServed = 0;

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

async function scanFiles() {
  let entries;
  try {
    entries = fs.readdirSync(FILES_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  const seen = new Set();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith('.') || entry.name.endsWith('.part')) continue; // sync internals
    seen.add(entry.name);
    const full = path.join(FILES_DIR, entry.name);
    const stat = fs.statSync(full);
    const cached = catalog.get(entry.name);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) continue;
    try {
      const sha256 = await hashFile(full);
      catalog.set(entry.name, { name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs, sha256 });
      console.log(`[catalog] indexed ${entry.name} (${stat.size} bytes)`);
    } catch (err) {
      console.error(`[catalog] failed to hash ${entry.name}:`, err.message);
    }
  }
  for (const name of [...catalog.keys()]) {
    if (!seen.has(name)) catalog.delete(name);
  }
}

await scanFiles();
setInterval(scanFiles, 10_000).unref();

// ---------------------------------------------------------------------------
// HTTP app: file API, optional TURN config, static client, SPA fallback.
// ---------------------------------------------------------------------------
const app = express();

// The production client is hosted separately from this API/WebSocket server
// (Vercel frontend + Railway backend). The app uses no cookie credentials, so
// a public read/write API origin is sufficient for browser requests.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------------------
// Local-node registry (used when this instance is the VPS).
// Local nodes heartbeat their LAN URL here; visitors from the same public IP
// are offered the node via /api/config -> localNode.
// ---------------------------------------------------------------------------
const NODE_SECRET = process.env.NODE_SECRET || '';
const nodes = new Map(); // url -> { url, ip, lastSeen }

function clientIp(req) {
  let ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip;
}

app.post('/api/node-register', express.json(), (req, res) => {
  const { secret, url } = req.body || {};
  if (!NODE_SECRET || secret !== NODE_SECRET || typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const cleanUrl = url.replace(/\/+$/, '');
  nodes.set(cleanUrl, { url: cleanUrl, ip: clientIp(req), lastSeen: Date.now() });
  res.json({ ok: true });
});

setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [url, node] of nodes) if (node.lastSeen < cutoff) nodes.delete(url);
}, 60_000).unref();

app.get('/api/files', (req, res) => {
  res.json([...catalog.values()].map(({ name, size, sha256 }) => ({ name, size, sha256 })));
});

app.get('/api/stats', (req, res) => {
  res.json({
    peers: peers.size,
    serverBytesServed,
    p2pBytesServed,
    totalBytesServed: serverBytesServed + p2pBytesServed,
  });
});

// ICE servers are served at runtime so TURN credentials can be set via env
// on the VPS without rebuilding the client. If a local node is registered
// from the requester's public IP, its LAN URL is included.
app.get('/api/config', (req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USER || undefined,
      credential: process.env.TURN_PASS || undefined,
    });
  }
  const ip = clientIp(req);
  let localNode;
  for (const node of nodes.values()) {
    if (node.ip === ip) {
      localNode = node.url;
      break;
    }
  }
  res.json({
    iceServers,
    access: process.env.UPSTREAM ? 'node' : 'server',
    ...(localNode ? { localNode } : {}),
  });
});

// Direct server download. Only the FIRST peer of each file uses this;
// afterwards the server redirects peers to a P2P host instead.
app.get('/files/:name', (req, res) => {
  const name = path.basename(req.params.name);
  if (!catalog.has(name)) return res.status(404).json({ error: 'unknown file' });
  const filePath = path.join(FILES_DIR, name);
  const stream = fs.createReadStream(filePath);
  stream.on('data', (chunk) => {
    serverBytesServed += chunk.length;
  });
  stream.on('error', () => {
    if (!res.headersSent) res.status(404).json({ error: 'file unavailable' });
    else res.destroy();
  });
  res.type(path.extname(name));
  stream.pipe(res);
});

if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
} else {
  app.get('/', (req, res) =>
    res.status(503).send('Client not built yet. Run "npm install && npm run build" in the client folder.')
  );
}

// ---------------------------------------------------------------------------
// WebSocket signaling.
//
// Protocol (all JSON):
//   server -> client  { t:'welcome', id }
//   server -> client  { t:'stats', peers, seeders:{file:count} }
//   client -> server  { t:'hello', p2pCapable }       advertise peer capability
//   client -> server  { t:'have', file }              announce: I host this file
//   client -> server  { t:'want', file }              ask for a download source
//   server -> client  { t:'source', file, source:'http' }
//   server -> client  { t:'source', file, source:'p2p', seeder }
//   server -> client  { t:'source', file, source:'error', message }
//   client -> server  { t:'signal', to, data }        WebRTC offer/answer relay
//   server -> client  { t:'signal', from, data }
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const peers = new Map(); // id -> { ws, seeding:Set<string>, p2pCapable:boolean }

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcastStats() {
  const seeders = {};
  for (const p of peers.values()) {
    for (const file of p.seeding) seeders[file] = (seeders[file] || 0) + 1;
  }
  const msg = JSON.stringify({ t: 'stats', peers: peers.size, seeders });
  for (const p of peers.values()) if (p.ws.readyState === 1) p.ws.send(msg);
}

wss.on('connection', (ws) => {
  const id = crypto.randomUUID().slice(0, 8);
  // Peers are hidden from P2P source selection until they prove that their
  // browser can expose usable host ICE candidates.
  peers.set(id, { ws, seeding: new Set(), p2pCapable: false });
  send(ws, { t: 'welcome', id });
  broadcastStats();

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const me = peers.get(id);
    if (!me) return;

    switch (msg.t) {
      case 'hello': {
        me.p2pCapable = msg.p2pCapable === true;
        if (!me.p2pCapable) me.seeding.clear();
        broadcastStats();
        break;
      }
      case 'telemetry': {
        const uploaded = Number(msg.p2pUploadBytes);
        if (Number.isFinite(uploaded) && uploaded > 0) {
          p2pBytesServed += Math.min(uploaded, 1024 * 1024 * 1024);
        }
        break;
      }
      case 'have': {
        if (me.p2pCapable && catalog.has(msg.file)) {
          me.seeding.add(msg.file);
          broadcastStats();
        }
        break;
      }
      case 'want': {
        const file = msg.file;
        if (!catalog.has(file)) {
          return send(ws, { t: 'source', file, source: 'error', message: 'unknown file' });
        }
        // Pick a random host (seeder) other than the requester, skipping hosts
        // the requester already failed to download from (msg.exclude).
        // No host left -> the requester downloads from the server and becomes
        // a host automatically after announcing {t:'have'}.
        const exclude = new Set(Array.isArray(msg.exclude) ? msg.exclude : []);
        const seeders = [...peers.keys()].filter(
          (pid) =>
            pid !== id &&
            !exclude.has(pid) &&
            peers.get(pid).p2pCapable &&
            peers.get(pid).seeding.has(file)
        );
        if (seeders.length === 0) {
          send(ws, { t: 'source', file, source: 'http' });
        } else {
          const seeder = seeders[Math.floor(Math.random() * seeders.length)];
          send(ws, { t: 'source', file, source: 'p2p', seeder });
        }
        break;
      }
      case 'signal': {
        const target = peers.get(msg.to);
        if (target) send(target.ws, { t: 'signal', from: id, data: msg.data });
        break;
      }
    }
  });

  ws.on('close', () => {
    peers.delete(id);
    broadcastStats();
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — is another instance still running?`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`P2P file server listening on http://localhost:${PORT}`);
  console.log(`Distributing files from: ${FILES_DIR}`);
});

// ---------------------------------------------------------------------------
// Local-node mode: with UPSTREAM set, this instance mirrors the VPS's files
// and (optionally) announces itself so visitors get pointed to it.
//
//   UPSTREAM=https://vps.example.com PUBLIC_URL=http://192.168.1.50:3000 \
//   NODE_SECRET=shared-secret node index.js
// ---------------------------------------------------------------------------
if (process.env.UPSTREAM) {
  startSync({
    upstream: process.env.UPSTREAM,
    filesDir: FILES_DIR,
    onChanged: () => scanFiles(),
  });
  if (process.env.NODE_SECRET && process.env.PUBLIC_URL) {
    startNodeRegistration({
      upstream: process.env.UPSTREAM,
      secret: process.env.NODE_SECRET,
      publicUrl: process.env.PUBLIC_URL,
    });
  } else {
    console.log('[node] NODE_SECRET/PUBLIC_URL not set — running as unregistered local node');
  }
}
