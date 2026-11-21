// the webview blocks navigator.clipboard, so go through the native plugin when it's there
const clip = {
  async read() {
    // plugin first, then the Linux CLI fallback (GNOME/Wayland), then the webview API
    const native = window.__TAURI__?.clipboardManager;
    if (native?.readText) {
      try { return (await native.readText()) || ""; } catch {}
    }
    const invoke = window.__TAURI__?.core?.invoke;
    if (invoke) {
      try { return (await invoke("read_clipboard_fallback")) || ""; } catch {}
    }
    return navigator.clipboard.readText();
  },
  async write(text) {
    const native = window.__TAURI__?.clipboardManager;
    if (native?.writeText) return native.writeText(text);
    return navigator.clipboard.writeText(text);
  },
};
