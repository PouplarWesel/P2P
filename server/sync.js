// Local-node support.
//
// When this server runs with UPSTREAM set (e.g. UPSTREAM=https://files.example.com),
// it becomes a LOCAL NODE on the site's LAN:
//
//   startSync              mirrors all files from the upstream VPS into the
//                          local files dir (hash-verified), so local clients
//                          download at LAN speed without touching Starlink.
//   startNodeRegistration  heartbeats this node's LAN URL to the VPS, so the
//                          VPS can point visitors from the same public IP at it.
//
// Synced files are tracked in .sync-manifest.json so manually added files are
// never deleted.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MANIFEST = '.sync-manifest.json';

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

async function downloadToTemp(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const tmp = `${dest}.part`;
  const out = fs.createWriteStream(tmp);
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.write(value);
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  return tmp;
}

export function startSync({ upstream, filesDir, intervalMs = 60_000, onChanged = () => {} }) {
  upstream = upstream.replace(/\/+$/, '');
  const manifestPath = path.join(filesDir, MANIFEST);
  let syncing = false;

  async function tick() {
    if (syncing) return;
    syncing = true;
    try {
      const res = await fetch(`${upstream}/api/files`);
      if (!res.ok) throw new Error(`upstream /api/files -> HTTP ${res.status}`);
      const remoteFiles = await res.json();
      const remoteByName = new Map(remoteFiles.map((f) => [f.name, f]));

      let manifest = {};
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch {
        /* no manifest yet */
      }

      let changed = false;

      // Download new or updated files (hash-verified before going live).
      for (const f of remoteFiles) {
        const dest = path.join(filesDir, f.name);
        if (manifest[f.name] === f.sha256 && fs.existsSync(dest)) continue;
        if (fs.existsSync(dest)) {
          try {
            if ((await sha256File(dest)) === f.sha256) {
              manifest[f.name] = f.sha256;
              continue;
            }
          } catch {
            /* unreadable — re-download */
          }
        }
        console.log(`[sync] downloading ${f.name} (${f.size} bytes) from upstream`);
        const tmp = await downloadToTemp(`${upstream}/files/${encodeURIComponent(f.name)}`, dest);
        const hash = await sha256File(tmp);
        if (hash !== f.sha256) {
          fs.rmSync(tmp, { force: true });
          console.error(`[sync] hash mismatch for ${f.name} — skipped`);
          continue;
        }
        fs.renameSync(tmp, dest);
        manifest[f.name] = f.sha256;
        changed = true;
        console.log(`[sync] cached ${f.name}`);
      }

      // Remove files that vanished upstream (only ones we synced).
      for (const name of Object.keys(manifest)) {
        if (!remoteByName.has(name)) {
          fs.rmSync(path.join(filesDir, name), { force: true });
          delete manifest[name];
          changed = true;
          console.log(`[sync] removed ${name} (gone upstream)`);
        }
      }

      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      if (changed) onChanged();
    } catch (err) {
      console.error(`[sync] ${err.message}`);
    } finally {
      syncing = false;
    }
  }

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return timer;
}

export function startNodeRegistration({ upstream, secret, publicUrl, intervalMs = 60_000 }) {
  upstream = upstream.replace(/\/+$/, '');

  async function beat() {
    try {
      const res = await fetch(`${upstream}/api/node-register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret, url: publicUrl }),
      });
      if (res.ok) console.log('[node] registered with upstream');
      else console.error(`[node] registration failed: HTTP ${res.status}`);
    } catch (err) {
      console.error(`[node] registration failed: ${err.message}`);
    }
  }

  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref();
  return timer;
}
