// the webview blocks navigator.clipboard, so go through the native plugin when it's there
const clip = {
  async read() {
    const native = window.__TAURI__?.clipboardManager;
    if (native?.readText) {
      try { const t = await native.readText(); if (t) return t; } catch {}
    }
    const invoke = window.__TAURI__?.core?.invoke;
    if (invoke) {
      try { const t = await invoke("read_clipboard_fallback"); if (t) return t; } catch {}
    }
    return navigator.clipboard.readText();
  },
  async write(text) {
    const native = window.__TAURI__?.clipboardManager;
    if (native?.writeText) return native.writeText(text);
    return navigator.clipboard.writeText(text);
  },
};
