// WebRTC DataChannel file transfer (trickle ICE).
//
// SeederManager: runs in every tab that hosts files. Answers incoming WebRTC
// offers and streams the requested Blob over the DataChannel with
// backpressure control.
//
// downloadViaP2P: connects to a seeder, requests the file, and reassembles
// the received chunks into a Blob.
//
// Trickle ICE: offer/answer are sent immediately and candidates are relayed
// as they are discovered. On a LAN the host candidates connect in
// milliseconds even when STUN is slow or unreachable (common on satellite
// links). Progress callbacks are throttled so the UI is not re-rendered for
// every 64 KB chunk.

// 128 KB chunks: measured fastest in Chromium loopback benchmarks
// (64 KB ≈ 14 MB/s, 128 KB ≈ 16 MB/s, 256 KB no better and risks the
// internal send-queue limit). Practical browser DataChannel throughput
// tops out around 15-25 MB/s — still far above typical satellite links.
const CHUNK_SIZE = 128 * 1024;
const MAX_BUFFERED = 8 * 1024 * 1024; // pause sending above this
const BUFFERED_LOW = 1 * 1024 * 1024; // resume once drained to this
const HANDSHAKE_TIMEOUT = 15_000; // max time to establish the DataChannel
const INACTIVITY_TIMEOUT = 30_000; // max gap between chunks mid-transfer
const PROGRESS_INTERVAL = 150; // ms between UI progress updates

// crypto.randomUUID is only available in secure contexts (HTTPS/localhost).
// Fall back so P2P also works when testing over plain http://<lan-ip>.
export function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function throttleProgress(cb, interval = PROGRESS_INTERVAL) {
  if (!cb) return () => {};
  let lastT = 0;
  return (done, total) => {
    const now = Date.now();
    if (now - lastT >= interval || done >= total) {
      lastT = now;
      cb(done, total);
    }
  };
}

function waitBufferDrain(dc) {
  if (dc.bufferedAmount <= MAX_BUFFERED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onLow = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('DataChannel closed')); };
    const cleanup = () => {
      dc.removeEventListener('bufferedamountlow', onLow);
      dc.removeEventListener('close', onClose);
    };
    dc.addEventListener('bufferedamountlow', onLow);
    dc.addEventListener('close', onClose);
  });
}

async function streamBlob(dc, blob, onProgress) {
  dc.bufferedAmountLowThreshold = BUFFERED_LOW;
  // Read once, then pump synchronously. Awaiting a slice-read per chunk would
  // serialize the pipeline on event-loop turns and cap throughput.
  const buf = await blob.arrayBuffer();
  let offset = 0;
  while (offset < buf.byteLength) {
    if (dc.readyState !== 'open') throw new Error('DataChannel closed');
    if (dc.bufferedAmount > MAX_BUFFERED) {
      await waitBufferDrain(dc);
      continue;
    }
    const end = Math.min(offset + CHUNK_SIZE, buf.byteLength);
    try {
      dc.send(new Uint8Array(buf, offset, end - offset));
    } catch {
      // Browser send queue is full — wait for the drain and retry this chunk.
      await waitBufferDrain(dc);
      continue;
    }
    offset = end;
    onProgress(end, buf.byteLength);
  }
  // Reliable channels are ordered: the receiver gets all chunks before 'done'.
  dc.send(JSON.stringify({ t: 'done' }));
}

// Wires trickle-ICE candidate exchange onto a peer connection.
// Candidates that arrive before the remote description is set are queued.
// Also tracks candidate types so failures can explain themselves.
function candidateType(candidate) {
  if (!candidate || !candidate.candidate) return null;
  const m = / typ (\w+)/.exec(candidate.candidate);
  return m ? m[1] : 'unknown';
}

function summarize(types) {
  if (!types.length) return 'none';
  const counts = {};
  for (const t of types) counts[t] = (counts[t] || 0) + 1;
  return Object.entries(counts)
    .map(([k, v]) => `${k}:${v}`)
    .join(', ');
}

function wireTrickle(pc, sendIce) {
  const pending = [];
  const localTypes = [];
  const remoteTypes = [];
  let remoteSet = false;
  pc.onicecandidate = (e) => {
    if (e.candidate) localTypes.push(candidateType(e.candidate));
    sendIce(e.candidate ? e.candidate.toJSON() : null);
  };
  return {
    async setRemote(sdp) {
      await pc.setRemoteDescription(sdp);
      remoteSet = true;
      while (pending.length) {
        try {
          await pc.addIceCandidate(pending.shift());
        } catch {
          /* stale candidate — ignore */
        }
      }
    },
    async addRemoteCandidate(candidate) {
      if (candidate) remoteTypes.push(candidateType(candidate));
      if (!remoteSet) {
        pending.push(candidate);
        return;
      }
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        /* ignore */
      }
    },
    diagnostics() {
      return (
        `ice=${pc.iceConnectionState} conn=${pc.connectionState} gathering=${pc.iceGatheringState} ` +
        `local=[${summarize(localTypes)}] remote=[${summarize(remoteTypes)}]`
      );
    },
  };
}

async function connectionRoute(pc) {
  try {
    const stats = await pc.getStats();
    let pair;
    stats.forEach((report) => {
      if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.nominated || !pair)) {
        pair = report;
      }
    });
    if (!pair) return 'p2p';
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    const types = [local?.candidateType, remote?.candidateType].filter(Boolean);
    if (types.includes('relay')) return 'p2p (TURN relay)';
    if (types.length === 2 && types.every((type) => type === 'host')) return 'p2p (LAN)';
    return 'p2p (internet direct)';
  } catch {
    return 'p2p';
  }
}

function logState(tag, pc) {
  pc.onconnectionstatechange = () => console.log(`[p2p ${tag}] connectionState:`, pc.connectionState);
}

// Probes whether this browser exposes LAN (host) ICE candidates — i.e. whether
// P2P to nearby peers can work at all. Privacy-hardened browsers (Helium,
// Brave, LibreWolf, Tor, uBlock's WebRTC leak protection) suppress host
// candidates, which makes same-LAN P2P impossible; in that case we skip
// futile connection attempts and prefer direct/node downloads.
export function detectHostCandidates(iceServers, timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (typeof RTCPeerConnection === 'undefined') return resolve(false);
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers });
    } catch {
      return resolve(false);
    }
    let found = false;
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        pc.close();
      } catch {
        /* ignore */
      }
      resolve(val);
    };
    const timer = setTimeout(() => finish(found), timeoutMs);
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        if (/ typ host /.test(e.candidate.candidate)) finish(true);
      } else {
        finish(found); // end of candidates
      }
    };
    try {
      pc.createDataChannel('probe'); // a channel is required to trigger gathering
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => finish(found));
    } catch {
      finish(found);
    }
  });
}

export class SeederManager {
  /**
   * @param signaling  Signaling instance (route {t:'signal'} messages to handleSignal)
   * @param getBlob    (fileName) => Blob | undefined
   * @param getIceServers () => RTCIceServer[]
   * @param callbacks  { onUploadStart, onUploadProgress, onUploadEnd }
   */
  constructor(signaling, getBlob, getIceServers, callbacks = {}) {
    this.sig = signaling;
    this.getBlob = getBlob;
    this.getIceServers = getIceServers;
    this.cb = callbacks;
    this.peers = new Map(); // `${from}:${conn}` -> { pc, trickle }
  }

  async handleSignal({ from, data }) {
    if (!data) return;
    const key = `${from}:${data.conn}`;

    if (data.kind === 'ice') {
      this.peers.get(key)?.trickle.addRemoteCandidate(data.candidate);
      return;
    }
    if (data.kind !== 'offer') return;

    const blob = this.getBlob(data.file);
    if (!blob) return; // we don't host that file

    const pc = new RTCPeerConnection({ iceServers: this.getIceServers() });
    const trickle = wireTrickle(pc, (candidate) =>
      this.sig.send({ t: 'signal', to: from, data: { conn: data.conn, file: data.file, kind: 'ice', candidate } })
    );
    this.peers.set(key, { pc, trickle });
    logState('seeder', pc);

    pc.ondatachannel = (e) => {
      const dc = e.channel;
      dc.binaryType = 'arraybuffer';
      dc.onopen = () => console.log(`[p2p seeder] channel open to ${from} for ${data.file}`);
      dc.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.t === 'send') {
          console.log(`[p2p seeder] streaming ${data.file} to ${from}`);
          this.cb.onUploadStart?.(from, data.file);
          streamBlob(
            dc,
            blob,
            throttleProgress((sent, total) => this.cb.onUploadProgress?.(from, data.file, sent, total))
          )
            .catch((err) => console.log(`[p2p seeder] upload to ${from} ended: ${err.message}`))
            .finally(() => this.cb.onUploadEnd?.(from, data.file));
        }
      };
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.drop(key);
    };

    try {
      await trickle.setRemote(data.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.sig.send({
        t: 'signal',
        to: from,
        data: { conn: data.conn, file: data.file, kind: 'answer', sdp: pc.localDescription },
      });
    } catch {
      this.drop(key);
    }
  }

  drop(key) {
    const entry = this.peers.get(key);
    if (entry) {
      try {
        entry.pc.close();
      } catch {
        /* ignore */
      }
      this.peers.delete(key);
    }
  }

  destroy() {
    for (const key of [...this.peers.keys()]) this.drop(key);
  }
}

export async function downloadViaP2P({ signaling, seederId, file, getIceServers, onProgress, onConnectionType }) {
  const conn = uuid();
  const pc = new RTCPeerConnection({ iceServers: getIceServers() });
  const chunks = [];
  let received = 0;
  let watchdog;
  const unsubs = [];

  const trickle = wireTrickle(pc, (candidate) =>
    signaling.send({ t: 'signal', to: seederId, data: { conn, file: file.name, kind: 'ice', candidate } })
  );

  const result = new Promise((resolve, reject) => {
    let settled = false;
    let handshakeTimer;
    const cleanup = () => {
      clearTimeout(watchdog);
      clearTimeout(handshakeTimer);
      unsubs.forEach((fn) => fn());
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      pc.close();
      reject(err);
    };
    const succeed = (blob) => {
      if (settled) return;
      settled = true;
      cleanup();
      pc.close();
      resolve(blob);
    };
    const poke = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(
        () => fail(new Error(`transfer stalled (${trickle.diagnostics()})`)),
        INACTIVITY_TIMEOUT
      );
    };

    unsubs.push(
      signaling.on('signal', (msg) => {
        if (msg.from !== seederId || msg.data?.conn !== conn) return;
        if (msg.data.kind === 'answer') {
          trickle.setRemote(msg.data.sdp).catch((err) => fail(new Error(`bad answer: ${err.message}`)));
        } else if (msg.data.kind === 'ice') {
          trickle.addRemoteCandidate(msg.data.candidate);
        }
      })
    );

    const progress = throttleProgress(onProgress);
    const tStart = performance.now();
    const dc = pc.createDataChannel('file');
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      console.log(`[p2p downloader] channel open after ${(performance.now() - tStart).toFixed(0)}ms`);
      clearTimeout(handshakeTimer);
      poke();
      connectionRoute(pc).then((route) => onConnectionType?.(route));
      dc.send(JSON.stringify({ t: 'send' }));
    };
    dc.onmessage = (ev) => {
      poke();
      if (typeof ev.data === 'string') {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.t === 'done') {
          const secs = (performance.now() - tStart) / 1000;
          console.log(`[p2p downloader] ${(received / 1048576).toFixed(1)} MB in ${secs.toFixed(2)}s (${(received / 1048576 / secs).toFixed(1)} MB/s)`);
          succeed(new Blob(chunks));
        }
      } else {
        chunks.push(ev.data);
        received += ev.data.byteLength;
        progress(received, file.size);
      }
    };
    dc.onerror = () => fail(new Error('DataChannel error'));
    logState('downloader', pc);
    pc.oniceconnectionstatechange = () => {
      console.log('[p2p downloader] iceConnectionState:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        fail(
          new Error(
            `could not connect to host — NAT traversal failed (${trickle.diagnostics()}). ` +
              'If local=[none] or shows no "host" entries, the browser is blocking WebRTC local candidates (check its WebRTC/IP-leak settings); otherwise a TURN server may be needed.'
          )
        );
      }
    };
    handshakeTimer = setTimeout(
      () => fail(new Error(`handshake timed out (${trickle.diagnostics()})`)),
      HANDSHAKE_TIMEOUT
    );
    poke();
  });

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signaling.send({
      t: 'signal',
      to: seederId,
      data: { conn, file: file.name, kind: 'offer', sdp: pc.localDescription },
    });
  } catch (err) {
    pc.close();
    throw err;
  }

  return result;
}
