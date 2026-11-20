// the webview blocks navigator.clipboard, so go through the native plugin when it's there
const clip = {
  async read() {
    const native = window.__TAURI__?.clipboardManager;
    if (native?.readText) return (await native.readText()) || "";
    return navigator.clipboard.readText();
  },
  async write(text) {
    const native = window.__TAURI__?.clipboardManager;
    if (native?.writeText) return native.writeText(text);
    return navigator.clipboard.writeText(text);
  },
};
