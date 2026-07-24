import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// Fast path: a returning visitor whose browser already failed the P2P probe
// gets sent straight to the local node before the app even renders.
// (Freshness matches the server's 10-minute node-registration window, and the
// main site revalidates in the background on every load.)
let redirected = false;
try {
  const transferMode = localStorage.getItem('transferMode') || 'auto';
  const nodeRaw = localStorage.getItem('localNode');
  if (
    transferMode === 'auto' &&
    localStorage.getItem('p2pCapable') === '0' &&
    nodeRaw
  ) {
    const { url, ts } = JSON.parse(nodeRaw);
    if (url && Date.now() - ts < 10 * 60 * 1000 && url !== location.origin) {
      location.replace(url);
      redirected = true;
    }
  }
} catch {
  /* storage unavailable — render normally */
}

if (!redirected) {
  createRoot(document.getElementById('root')).render(<App />);
}
