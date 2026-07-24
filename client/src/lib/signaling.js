// Thin WebSocket wrapper with auto-reconnect and typed event handlers.
import { websocketUrl } from './api';

export class Signaling {
  constructor() {
    this.handlers = new Map(); // type -> Set<cb>
    this.closed = false;
    this.ws = null;
  }

  // Returns an unsubscribe function.
  on(type, cb) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    const set = this.handlers.get(type);
    set.add(cb);
    return () => set.delete(cb);
  }

  emit(type, msg) {
    const set = this.handlers.get(type);
    if (set) for (const cb of [...set]) cb(msg);
  }

  connect() {
    if (this.closed) return;
    this.ws = new WebSocket(websocketUrl('/ws'));
    this.ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.emit(msg.t, msg);
    };
    this.ws.onclose = () => {
      this.emit('close', {});
      if (!this.closed) setTimeout(() => this.connect(), 2000);
    };
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  close() {
    this.closed = true;
    if (this.ws) this.ws.close();
  }
}
