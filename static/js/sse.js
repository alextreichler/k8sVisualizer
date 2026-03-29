// sse.js — SSEClient wraps EventSource with auto-reconnect and typed callbacks

export class SSEClient {
  constructor(url) {
    this.url = url;
    this._handlers = {};     // eventType → [handler, ...]
    this._es = null;
    this._retryDelay = 1000;
    this._maxDelay = 30000;
    this._stopped = false;
  }

  on(type, handler) {
    if (!this._handlers[type]) this._handlers[type] = [];
    this._handlers[type].push(handler);
    return this; // chainable
  }

  connect() {
    if (this._stopped) return;
    this._es = new EventSource(this.url);

    this._es.onopen = () => {
      this._retryDelay = 1000;
      this._dispatch('_connected', {});
    };

    this._es.onmessage = (e) => {
      let event;
      try { event = JSON.parse(e.data); } catch { return; }
      this._dispatch(event.type, event);
      this._dispatch('*', event); // wildcard
    };

    this._es.onerror = () => {
      this._es.close();
      this._dispatch('_error', {});
      if (!this._stopped) {
        setTimeout(() => this.connect(), this._retryDelay);
        this._retryDelay = Math.min(this._retryDelay * 2, this._maxDelay);
      }
    };
  }

  disconnect() {
    this._stopped = true;
    if (this._es) this._es.close();
  }

  _dispatch(type, payload) {
    const handlers = this._handlers[type] || [];
    for (const h of handlers) {
      try { h(payload); } catch (err) { console.error('SSE handler error:', err); }
    }
  }
}
