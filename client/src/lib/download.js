// Direct HTTP download from the server (used for the first peer of a file
// and as a fallback if P2P fails), plus integrity hashing and file saving.
import { apiUrl } from './api';

export async function downloadViaHttp(file, onProgress) {
  const res = await fetch(apiUrl(`/files/${encodeURIComponent(file.name)}`));
  if (!res.ok) throw new Error(`Server download failed (HTTP ${res.status})`);
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress?.(received, file.size);
  }
  return new Blob(chunks);
}

export async function sha256Hex(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
