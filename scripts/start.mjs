// One-command bootstrap: `npm start` from the repo root.
//
//   1. installs server + client dependencies (in parallel) if missing
//   2. builds the client if dist/ is missing or sources are newer
//   3. starts the server (which serves the built client, API, and signaling)
//
// Flags:
//   --setup-only   do steps 1-2, don't start the server
//   --server-only  skip steps 1-2, just start the server (used by `npm run dev`)
//
// This script intentionally uses no npm dependencies so the very first
// `npm start` works before anything is installed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const SETUP_ONLY = args.includes('--setup-only');
const SERVER_ONLY = args.includes('--server-only');
const NODE_MODE = args.includes('--node');
const DEV = args.includes('--dev');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(cmd, cmdArgs, cwd, label) {
  return new Promise((resolve, reject) => {
    // On Windows, npm is exposed as npm.cmd. Node must use a shell to spawn
    // .cmd shims; otherwise child_process reports `spawn EINVAL`.
    const child = spawn(cmd, cmdArgs, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${label} failed (exit code ${code})`))
    );
  });
}

function newestMtime(dir) {
  let newest = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        const m = fs.statSync(full).mtimeMs;
        if (m > newest) newest = m;
      }
    }
  }
  return newest;
}

async function ensureDeps(dir, label) {
  if (fs.existsSync(path.join(dir, 'node_modules'))) return;
  console.log(`[setup] installing ${label} dependencies...`);
  await run(npm, ['install', '--no-audit', '--no-fund'], dir, `npm install (${label})`);
}

function clientNeedsBuild() {
  const distIndex = path.join(root, 'client', 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) return true;
  const distMtime = fs.statSync(distIndex).mtimeMs;
  const srcMtime = Math.max(
    newestMtime(path.join(root, 'client', 'src')),
    fs.statSync(path.join(root, 'client', 'index.html')).mtimeMs,
    fs.statSync(path.join(root, 'client', 'vite.config.js')).mtimeMs
  );
  return srcMtime > distMtime;
}

try {
  if (!SERVER_ONLY) {
    await Promise.all([
      ensureDeps(path.join(root, 'server'), 'server'),
      ensureDeps(path.join(root, 'client'), 'client'),
    ]);
    if (clientNeedsBuild()) {
      console.log('[setup] building client...');
      await run(npm, ['run', 'build'], path.join(root, 'client'), 'client build');
    } else {
      console.log('[setup] client build is up to date');
    }
    console.log('[setup] done');
  }

  if (!SETUP_ONLY) {
    const env = { ...process.env };
    if (NODE_MODE) {
      // Local-node mode with local dev defaults (env vars still win).
      env.PORT = env.PORT || '3001';
      env.UPSTREAM = env.UPSTREAM || 'http://localhost:3000';
      env.PUBLIC_URL = env.PUBLIC_URL || `http://localhost:${env.PORT}`;
      env.FILES_DIR = env.FILES_DIR || path.join(root, 'server', 'files-node');
      console.log(`[start] starting LOCAL NODE on port ${env.PORT} (upstream: ${env.UPSTREAM})`);
    } else {
      console.log('[start] starting server...');
    }
    if (DEV && !env.NODE_SECRET) {
      env.NODE_SECRET = 'dev-only-secret';
      console.warn('[start] WARNING: using built-in dev NODE_SECRET — set your own in production');
    }
    const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
      stdio: 'inherit',
      env,
    });
    const shutdown = () => server.kill();
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    server.on('exit', (code) => process.exit(code ?? 0));
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
