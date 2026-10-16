const tauriLog = window.__TAURI__.log;

function send(level, message) {
  if (tauriLog) tauriLog[level](String(message)).catch(() => {});
  else console[level === "debug" ? "log" : level](message);
}

const log = {
  error: (message) => send("error", message),
  warn: (message) => send("warn", message),
  info: (message) => send("info", message),
  debug: (message) => send("debug", message),
};

window.addEventListener("error", (e) => log.error(`uncaught: ${e.message} (${e.filename}:${e.lineno})`));
window.addEventListener("unhandledrejection", (e) => log.error(`unhandled rejection: ${e.reason}`));
