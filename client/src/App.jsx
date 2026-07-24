import { useCallback, useEffect, useRef, useState } from 'react';
import { Signaling } from './lib/signaling';
import { SeederManager, downloadViaP2P, detectHostCandidates } from './lib/p2p';
import { downloadViaHttp, sha256Hex, saveBlob } from './lib/download';
import { apiUrl } from './lib/api';
import { cacheFile, loadCachedFiles } from './lib/cache';

const DEFAULT_ICE = [{ urls: ['stun:stun.l.google.com:19302'] }];
const TRANSFER_MODES = [
  ['auto', 'AUTO'],
  ['p2p', 'FORCE P2P'],
  ['node', 'FORCE NODE'],
  ['server', 'FORCE SERVER'],
];

function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return `${v.toFixed(1)} ${units[u]}`;
}

export default function App() {
  const [connected, setConnected] = useState(false);
  const [files, setFiles] = useState([]);
  const [stats, setStats] = useState({ peers: 0, seeders: {} });
  const [downloads, setDownloads] = useState({}); // name -> {status, received, total, source, speed, error}
  const [uploads, setUploads] = useState({}); // "peer:file" -> {peer, file, sent, total}
  const [seeding, setSeeding] = useState([]); // file names this tab hosts
  const [localNode, setLocalNode] = useState(null); // LAN node URL offered by the server
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [p2pCapable, setP2pCapable] = useState(null); // null = probing, true/false
  const [transferMode, setTransferMode] = useState(() => localStorage.getItem('transferMode') || 'auto');
  const [accessMode, setAccessMode] = useState('server');
  const [sessionTraffic, setSessionTraffic] = useState({ server: 0, p2pDown: 0, p2pUp: 0 });
  const [networkTraffic, setNetworkTraffic] = useState({ serverBytesServed: 0, p2pBytesServed: 0, totalBytesServed: 0 });

  const p2pCapableRef = useRef(null);
  const probePromiseRef = useRef(null);

  const sigRef = useRef(null);
  const blobStore = useRef(new Map()); // name -> Blob
  const cacheReadyRef = useRef(Promise.resolve());
  const iceRef = useRef(DEFAULT_ICE);
  const transferModeRef = useRef(transferMode);
  const accessModeRef = useRef(accessMode);
  transferModeRef.current = transferMode;
  accessModeRef.current = accessMode;

  const changeTransferMode = (mode) => {
    localStorage.setItem('transferMode', mode);
    setTransferMode(mode);
    if (mode !== 'server' && p2pCapableRef.current === true && sigRef.current) {
      sigRef.current.send({ t: 'hello', p2pCapable: true });
      for (const name of blobStore.current.keys()) sigRef.current.send({ t: 'have', file: name });
    }
    if (mode === 'node' && localNode && localNode !== location.origin) location.replace(localNode);
  };

  const refreshFiles = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/files'));
      if (res.ok) setFiles(await res.json());
    } catch {
      /* server unreachable */
    }
  }, []);

  useEffect(() => {
    // Start the capability probe IMMEDIATELY (cached verdict when available)
    // and fetch config in parallel — the redirect decision happens as soon
    // as both resolve, with no artificial delay.
    const cachedVerdict = localStorage.getItem('p2pCapable');
    const probePromise =
      cachedVerdict != null
        ? Promise.resolve(cachedVerdict === '1')
        : detectHostCandidates(iceRef.current).then((capable) => {
            localStorage.setItem('p2pCapable', capable ? '1' : '0');
            return capable;
          });
    probePromiseRef.current = probePromise;
    probePromise.then((capable) => {
      p2pCapableRef.current = capable;
      setP2pCapable(capable);
      sigRef.current?.send({ t: 'hello', p2pCapable: capable });
      if (capable && transferModeRef.current !== 'server' && sigRef.current) {
        for (const name of blobStore.current.keys()) sigRef.current.send({ t: 'have', file: name });
      }
      console.log(
        `[p2p] host-candidate probe: ${capable ? 'P2P available' : 'P2P unavailable (browser hides local IPs)'}`
      );
    });

    fetch(apiUrl('/api/config'))
      .then((r) => (r.ok ? r.json() : null))
      .then(async (c) => {
        if (!c) return;
        if (c.access === 'node' || c.access === 'server') {
          accessModeRef.current = c.access;
          setAccessMode(c.access);
        }
        if (c.iceServers?.length) iceRef.current = c.iceServers;
        if (c.localNode) localStorage.setItem('localNode', JSON.stringify({ url: c.localNode, ts: Date.now() }));
        else localStorage.removeItem('localNode');
        if (transferModeRef.current === 'node' && c.localNode && c.localNode !== location.origin) {
          location.replace(c.localNode);
          return;
        }
        if (transferModeRef.current !== 'auto' || !c.localNode || c.localNode === location.origin) return;
        const capable = await probePromise;
        if (!capable) {
          location.replace(c.localNode); // instant default to the local node
          return;
        }
        setLocalNode(c.localNode);
      })
      .catch(() => {});

    const refreshTraffic = () => {
      fetch(apiUrl('/api/stats'))
        .then((r) => (r.ok ? r.json() : null))
        .then((value) => value && setNetworkTraffic(value))
        .catch(() => {});
    };
    refreshTraffic();
    const trafficInterval = setInterval(refreshTraffic, 5_000);

    // Keep re-probing in the background: if the browser/network changes,
    // future downloads adapt automatically.
    const probeInterval = setInterval(async () => {
      const capable = await detectHostCandidates(iceRef.current);
      localStorage.setItem('p2pCapable', capable ? '1' : '0');
      p2pCapableRef.current = capable;
      setP2pCapable(capable);
      sigRef.current?.send({ t: 'hello', p2pCapable: capable });
      if (capable && transferModeRef.current !== 'server' && sigRef.current) {
        for (const name of blobStore.current.keys()) sigRef.current.send({ t: 'have', file: name });
      }
    }, 60_000);

    const sig = new Signaling();
    sigRef.current = sig;

    // Restore downloaded blobs from IndexedDB so a reload can immediately
    // rejoin the swarm without downloading the files again.
    cacheReadyRef.current = loadCachedFiles().then((cached) => {
      for (const entry of cached) {
        if (entry.blob instanceof Blob) blobStore.current.set(entry.name, entry.blob);
      }
      const names = cached.filter((entry) => entry.blob instanceof Blob).map((entry) => entry.name);
      if (names.length) setSeeding((current) => [...new Set([...current, ...names])]);
      if (p2pCapableRef.current === true && transferModeRef.current !== 'server') {
        for (const name of names) sig.send({ t: 'have', file: name });
      }
    });

    const seeder = new SeederManager(
      sig,
      (name) => blobStore.current.get(name),
      () => iceRef.current,
      {
        onUploadStart: (peer, file) =>
          setUploads((u) => ({
            ...u,
            [`${peer}:${file}`]: { peer, file, sent: 0, total: blobStore.current.get(file)?.size ?? 0 },
          })),
        onUploadProgress: (peer, file, sent, total) =>
          setUploads((u) => ({ ...u, [`${peer}:${file}`]: { peer, file, sent, total } })),
        onUploadEnd: (peer, file) => {
          const uploaded = blobStore.current.get(file)?.size ?? 0;
          setSessionTraffic((current) => ({ ...current, p2pUp: current.p2pUp + uploaded }));
          sigRef.current?.send({ t: 'telemetry', p2pUploadBytes: uploaded });
          setUploads((u) => {
            const next = { ...u };
            delete next[`${peer}:${file}`];
            return next;
          });
        },
      }
    );

    sig.on('welcome', (msg) => {
      setConnected(true);
      if (p2pCapableRef.current !== null) sig.send({ t: 'hello', p2pCapable: p2pCapableRef.current });
      // (Re-)announce everything we host — also covers reconnects.
      if (transferModeRef.current !== 'server' && p2pCapableRef.current === true) {
        for (const name of blobStore.current.keys()) sig.send({ t: 'have', file: name });
      }
    });
    sig.on('stats', (msg) => setStats({ peers: msg.peers, seeders: msg.seeders || {} }));
    sig.on('signal', (msg) => seeder.handleSignal(msg));
    sig.on('close', () => {
      setConnected(false);
    });

    sig.connect();
    refreshFiles();
    const interval = setInterval(refreshFiles, 15_000);
    return () => {
      clearInterval(interval);
      clearInterval(trafficInterval);
      clearInterval(probeInterval);
      seeder.destroy();
      sig.close();
    };
  }, [refreshFiles]);

  const requestSource = (file, exclude = []) =>
    new Promise((resolve, reject) => {
      const sig = sigRef.current;
      const timer = setTimeout(() => {
        off();
        reject(new Error('Server did not respond'));
      }, 10_000);
      const off = sig.on('source', (msg) => {
        if (msg.file !== file) return;
        clearTimeout(timer);
        off();
        resolve(msg);
      });
      sig.send({ t: 'want', file, exclude });
    });

  const handleDownload = async (file) => {
    const current = downloads[file.name];
    if (current && ['locating', 'downloading', 'verifying'].includes(current.status)) return;

    const setDl = (patch) => setDownloads((d) => ({ ...d, [file.name]: { ...d[file.name], ...patch } }));
    setDl({ status: 'locating', received: 0, total: file.size, source: '', speed: null, error: null });

    // IndexedDB restoration may still be finishing when the user clicks.
    await cacheReadyRef.current;
    const cachedBlob = blobStore.current.get(file.name);
    if (cachedBlob) {
      setDl({ status: 'downloading', received: 0, total: file.size, source: 'local cache' });
      try {
        if (crypto.subtle) {
          const hash = await sha256Hex(cachedBlob);
          if (hash !== file.sha256) throw new Error('Cached copy failed integrity check');
        }
        setDl({ status: 'verifying', received: file.size, total: file.size, source: 'local cache' });
        setSeeding((current) => (current.includes(file.name) ? current : [...current, file.name]));
        setDl({ status: 'done', received: file.size, total: file.size, source: 'local cache' });
        saveBlob(cachedBlob, file.name);
      } catch (err) {
        setDl({ status: 'error', error: err.message, speed: null });
      }
      return;
    }

    // If the user clicked before the probe finished, wait for it (max ~1.5s)
    // so we don't attempt a P2P handshake this browser can't complete.
    if (p2pCapableRef.current === null && probePromiseRef.current) {
      try {
        await probePromiseRef.current;
      } catch {
        /* probe failure is non-fatal */
      }
    }

    let last = { received: 0, time: performance.now() };
    const onProgress = (received, total) => {
      const now = performance.now();
      const dt = (now - last.time) / 1000;
      if (dt >= 0.5) {
        const speed = (received - last.received) / dt;
        last = { received, time: now };
        setDl({ received, total, speed });
      } else {
        setDl({ received, total });
      }
    };

    try {
      let blob = null;

      if (transferModeRef.current === 'p2p' && p2pCapableRef.current === false) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        throw new Error('This browser blocks host candidates, so forced P2P is unavailable');
      }

      if (
        transferModeRef.current === 'server' ||
        (p2pCapableRef.current === false && transferModeRef.current !== 'p2p')
      ) {
        // Browser can't do local P2P (hides LAN candidates) — don't waste
        // 15s on a handshake that will never connect. Go straight to the
        // server/local node.
        setDl({ status: 'downloading', source: accessModeRef.current });
        blob = await downloadViaHttp(file, onProgress);
        setSessionTraffic((current) => ({ ...current, server: current.server + file.size }));
      }

      const excludedHosts = [];
      let lastP2pError = null;

      // Try P2P hosts until one works; only then fall back to the server.
      for (let attempt = 0; !blob && attempt < 5; attempt++) {
        const source = await requestSource(file.name, excludedHosts);

        if (source.source === 'p2p') {
          setDl({ status: 'downloading', received: 0, source: 'p2p' });
          try {
            blob = await downloadViaP2P({
              signaling: sigRef.current,
              seederId: source.seeder,
              file,
              getIceServers: () => iceRef.current,
              onProgress,
              onConnectionType: (source) => setDl({ source }),
            });
            setSessionTraffic((current) => ({ ...current, p2pDown: current.p2pDown + file.size }));
          } catch (err) {
            console.warn(`[p2p] download from host ${source.seeder} failed:`, err);
            lastP2pError = err;
            excludedHosts.push(source.seeder);
          }
        } else if (source.source === 'http') {
          if (transferModeRef.current === 'p2p') {
            throw new Error('No P2P host is available; forced P2P will not use server fallback');
          }
          setDl({
            status: 'downloading',
            source: accessModeRef.current,
          });
          blob = await downloadViaHttp(file, onProgress);
          setSessionTraffic((current) => ({ ...current, server: current.server + file.size }));
        } else {
          throw new Error(source.message || 'No source available');
        }
      }
      if (!blob) throw lastP2pError || new Error('No source available');

      setDl({ status: 'verifying', speed: null });
      if (crypto.subtle) {
        const hash = await sha256Hex(blob);
        if (hash !== file.sha256) throw new Error('Integrity check failed');
      }

      blobStore.current.set(file.name, blob);
      await cacheFile(file.name, blob, file.sha256);
      if (transferModeRef.current !== 'server' && p2pCapableRef.current === true) {
        sigRef.current.send({ t: 'have', file: file.name });
      }
      setSeeding((s) => (s.includes(file.name) ? s : [...s, file.name]));
      setDl({ status: 'done', received: file.size, total: file.size });
      saveBlob(blob, file.name);
    } catch (err) {
      setDl({ status: 'error', error: err.message, speed: null });
    }
  };

  const busy = (d) => d && ['locating', 'downloading', 'verifying'].includes(d.status);
  const uploadList = Object.values(uploads);

  return (
    <div className="homepage">
      <div className="tiny-toolbar">pls work crying out loud i hate privacy browsers that block this</div>

      <div className="mode-toolbar">
        <b>ROUTE:</b>
        {TRANSFER_MODES.map(([mode, label]) => (
          <button key={mode} className={transferMode === mode ? 'mode-active' : ''} onClick={() => changeTransferMode(mode)}>
            {label}
          </button>
        ))}
      </div>

      <main className="site-table">
        <div className="site-columns">
          <div className="main-column">
            <header className="rose-header">
              <div className="dripping-title">P2P<br /><span>FILE SHARE</span></div>
              <small>wannacry please release tommorow</small>
            </header>

            {localNode && !bannerDismissed && (
              <div className="local-ribbon">
                <span><b>local node found!</b><br />use the nearby node to save bandwidth</span>
                <a href={localNode}>GO THERE!!!</a>
                <button onClick={() => setBannerDismissed(true)} title="Dismiss">x</button>
              </div>
            )}

            {p2pCapable === false && !localNode && (
              <div className="old-alert">this browser hides local network addresses // direct download mode enabled</div>
            )}

            <section id="about" className="welcome-panel">
              <div className="welcome-line">
                <strong>vroom vroom me good programmer</strong>
              </div>
              <div className="retro-note">
                <b>NETWORK</b>
                <div className={connected ? 'status-good online-pulse' : 'status-bad'}>
                  {connected ? 'ONLINE' : 'CONNECTING'}<span className="rolling-dots" aria-hidden="true" />
                </div>
                <div>{stats.peers} peers currently online</div>
                <div>{transferMode === 'server' ? 'server only' : p2pCapable === false ? 'privacy mode: no peers' : `${transferMode} mode ready`}</div>
              </div>
            </section>

            <section className="traffic-panel">
              <div className="section-title"><span>BANDWIDTH MONITOR</span><small>since this tab opened // network totals since server boot</small></div>
              <div className="traffic-grid">
                <div><b>YOUR SESSION</b><br />server/node download: {formatBytes(sessionTraffic.server)}<br />P2P download: {formatBytes(sessionTraffic.p2pDown)}<br />P2P upload: {formatBytes(sessionTraffic.p2pUp)}</div>
                <div><b>NETWORK TOTALS</b><br />server/node served: {formatBytes(networkTraffic.serverBytesServed)}<br />P2P uploaded: {formatBytes(networkTraffic.p2pBytesServed)}<br />total served: {formatBytes(networkTraffic.totalBytesServed)}</div>
              </div>
            </section>

            <section id="files" className="file-panel">
              <div className="section-title"><span>DOWNLOADS</span><small>grab a file from the network</small></div>
              {files.length === 0 && <p className="empty-copy">No files published yet. Drop files into the server's files folder.</p>}
              <ul className="files">
                {files.map((f) => {
                  const d = downloads[f.name];
                  const hosts = stats.seeders[f.name] || 0;
                  return (
                    <li key={f.name} className="file">
                      <div className="file-row">
                        <span className="file-star">*</span>
                        <div className="meta">
                          <strong>{f.name}{' '}</strong>
                          <span>{formatBytes(f.size)} // {hosts} host{hosts === 1 ? '' : 's'}{seeding.includes(f.name) ? ' // YOU HOST THIS' : ''}</span>
                        </div>
                        <button onClick={() => handleDownload(f)} disabled={busy(d)}>
                          {d?.status === 'done' ? 'again!' : 'download!'}
                        </button>
                      </div>
                      {d && (
                        <div className="download-status">
                          {(d.status === 'downloading' || d.status === 'verifying') && <progress value={d.received} max={d.total} />}
                          {d.status === 'locating' && <span>locating a host...</span>}
                          {d.status === 'downloading' && <span>{formatBytes(d.received)} / {formatBytes(d.total)}{d.speed ? ` // ${formatBytes(d.speed)}/s` : ''} // via {d.source}</span>}
                          {d.status === 'verifying' && <span>checking the magic hash...</span>}
                          {d.status === 'done' && <span className="ok">DONE! saved via {d.source || accessMode}. you are now a host :)</span>}
                          {d.status === 'error' && <span className="err">OH NO: {d.error}</span>}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>

            {seeding.length > 0 && (
              <section id="hosting" className="hosting-panel">
                <div className="section-title"><span>YOUR HOSTED FILES</span><small>keep this tab open!</small></div>
                <ul className="files">
                  {seeding.map((name) => (
                    <li key={name} className="file-row hosted-row">
                      <span className="file-star">*</span>
                      <strong>{name}</strong>
                      <button onClick={() => saveBlob(blobStore.current.get(name), name)}>save copy</button>
                    </li>
                  ))}
                </ul>
                {uploadList.length > 0 && (
                  <div className="uploads">
                    <b>ACTIVE UPLOADS:</b>
                    {uploadList.map((u) => (
                      <div key={`${u.peer}:${u.file}`}>
                        {u.file} =&gt; peer {u.peer} ({formatBytes(u.sent)} / {formatBytes(u.total)})
                        <progress value={u.sent} max={u.total} />
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

          </div>
        </div>
      </main>
    </div>
  );
}
