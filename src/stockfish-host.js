// Runs the bundled stockfish-web build in this webview; Rust drives it over events like a UCI pipe.
(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  const DIR = new URL("vendor/stockfish/", document.baseURI).href;
  const ENTRY = DIR + "sf_19_smallnet.js";
  const FALLBACK_NNUE = "nn-61e7af4bb97d.nnue";

  const host = (window.stockfishHost = { error: null });

  async function boot() {
    const { default: makeModule } = await import(ENTRY);
    // initial/maximum are a guess at what the build needs; raise them if instantiation fails
    const wasmMemory = new WebAssembly.Memory({ shared: true, initial: 2560, maximum: 4096 });
    const sf = await makeModule({
      wasmMemory,
      locateFile: (name) => DIR + name,
      onError: (msg) => console.error("[stockfish]", msg),
    });
    sf.onError = (msg) => console.error("[stockfish]", msg);
    sf.listen = emit;

    const nnue = sf.getRecommendedNnue() || FALLBACK_NNUE;
    const res = await fetch(DIR + nnue);
    if (!res.ok) throw new Error(`${nnue} is missing from the bundle (HTTP ${res.status})`);
    sf.setNnueBuffer(new Uint8Array(await res.arrayBuffer()));
    return sf;
  }

  let outbox = [];
  function emit(line) {
    if (!outbox.length) {
      queueMicrotask(() => {
        const lines = outbox;
        outbox = [];
        invoke("stockfish_out", { lines });
      });
    }
    outbox.push(line);
  }

  let engine = null;
  let chain = Promise.resolve();

  listen("stockfish-in", (e) => {
    chain = chain
      .then(async () => {
        engine ??= await boot();
        engine.uci(e.payload);
      })
      .catch((err) => {
        const isolated = self.crossOriginIsolated ? "" : " (the page is not cross-origin isolated, so wasm threads are off)";
        host.error = `${err?.message || err}${isolated}`;
        console.error("[stockfish] failed to start:", err);
      });
  });
})();
