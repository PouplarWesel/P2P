// Micro-benchmark: raw WebRTC DataChannel loopback throughput in one page,
// across chunk sizes and bufferedAmount windows. Used to tune p2p.js.
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const executablePath = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));

const PAGE = `<!doctype html><html><body><script>
async function makePair() {
  const pc1 = new RTCPeerConnection();
  const pc2 = new RTCPeerConnection();
  pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
  pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate);
  const dc = pc1.createDataChannel('x');
  dc.binaryType = 'arraybuffer';
  const rxP = new Promise((res) => (pc2.ondatachannel = (e) => { e.channel.binaryType = 'arraybuffer'; res(e.channel); }));
  await pc1.setLocalDescription(await pc1.createOffer());
  await pc2.setRemoteDescription(pc1.localDescription);
  await pc2.setLocalDescription(await pc2.createAnswer());
  await pc1.setRemoteDescription(pc2.localDescription);
  await new Promise((res) => { if (dc.readyState === 'open') res(); else dc.onopen = res; });
  const rx = await rxP;
  return { dc, rx, pc1, pc2 };
}

window.bench = async (CHUNK, MAXB, LOW, CHANNELS, totalMB) => {
  const total = totalMB * 1024 * 1024;
  const pairs = [];
  for (let i = 0; i < CHANNELS; i++) pairs.push(await makePair());
  const perChannel = Math.ceil(total / CHANNELS);
  const buf = new Uint8Array(CHUNK);
  let received = 0, t0 = 0, tEnd = 0;
  let remaining = CHANNELS;
  const doneP = new Promise((res) => {
    for (const { rx } of pairs) {
      rx.onmessage = (ev) => {
        if (typeof ev.data === 'string') { if (--remaining === 0) { tEnd = performance.now(); res(); } return; }
        received += ev.data.byteLength;
      };
    }
  });
  const drain = (dc) => new Promise((r) => { const h = () => { dc.removeEventListener('bufferedamountlow', h); r(); }; dc.addEventListener('bufferedamountlow', h); });
  t0 = performance.now();
  await Promise.all(pairs.map(async ({ dc }) => {
    dc.bufferedAmountLowThreshold = LOW;
    let sent = 0;
    while (sent < perChannel) {
      if (dc.bufferedAmount > MAXB) { await drain(dc); continue; }
      try {
        dc.send(buf);
        sent += CHUNK;
      } catch {
        await drain(dc); // send queue full — wait and retry
      }
    }
    dc.send('done');
  }));
  await doneP;
  const secs = (tEnd - t0) / 1000;
  for (const { pc1, pc2 } of pairs) { pc1.close(); pc2.close(); }
  return { receivedMB: received / 1048576, secs, mbps: total / 1048576 / secs };
};
</script></body></html>`;

const browser = await puppeteer.launch({
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
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.setContent(PAGE);
await page.waitForFunction(() => typeof window.bench === 'function');

const configs = [
  ['1ch 64KB / 8MB window (current)', 64 * 1024, 8 * 1024 * 1024, 1024 * 1024, 1],
  ['1ch 128KB / 8MB window', 128 * 1024, 8 * 1024 * 1024, 1024 * 1024, 1],
  ['1ch 256KB / 8MB window', 256 * 1024, 8 * 1024 * 1024, 1024 * 1024, 1],
  ['2ch 64KB / 8MB window', 64 * 1024, 8 * 1024 * 1024, 1024 * 1024, 2],
  ['2ch 128KB / 8MB window', 128 * 1024, 8 * 1024 * 1024, 1024 * 1024, 2],
];

for (const [label, chunk, maxb, low, channels] of configs) {
  const r = await page.evaluate((c, m, l, ch) => window.bench(c, m, l, ch, 128), chunk, maxb, low, channels);
  console.log(`${label.padEnd(32)} ${r.mbps.toFixed(1)} MB/s (${r.receivedMB.toFixed(0)} MB in ${r.secs.toFixed(2)}s)`);
}

await browser.close();
