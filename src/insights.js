// Adapted from CSSLab/maia-platform-frontend (GPL-3.0).
const HI_CHART_RATINGS = Array.from({ length: 11 }, (_, i) => 600 + i * 200);
const HI_LINE_COLORS = ["#4caf6b", "#3b6ef2", "#e68f00", "#c06be0", "#26c2c2"];
const HI_CLASS_COLORS = { good: "#4caf6b", ok: "#e3c96b", blunder: "#e05555" };
const HI_CLASS_LABELS = { good: "Good", ok: "Okay", blunder: "Blunder" };
const HI_PENDING_COLOR = "#5a86f5";
const HI_SCORE_DEPTH = 10;

const hi = {
  panel: document.getElementById("humanPanel"),
  enable: document.getElementById("hiEnable"),
  rating: document.getElementById("hiRating"),
  status: document.getElementById("hiStatus"),
  body: document.getElementById("hiBody"),
  summary: document.getElementById("hiSummary"),
  meter: document.getElementById("hiMeter"),
  meterLegend: document.getElementById("hiMeterLegend"),
  moves: document.getElementById("hiMoves"),
  chart: document.getElementById("hiChart"),
  chartLegend: document.getElementById("hiChartLegend"),
  arrows: document.getElementById("hiArrows"),
  chartBox: document.getElementById("hiChartBox"),
};

const hiPromises = new Map();
const hiData = new Map();
let hiToken = 0;
let hiEnginesReady = false;
let hiRedrawing = false;

for (let r = 600; r <= 2600; r += 100) {
  const opt = document.createElement("option");
  opt.value = String(r);
  opt.textContent = `Maia ${r}`;
  if (r === 1500) opt.selected = true;
  hi.rating.appendChild(opt);
}

function hiRating() { return parseInt(hi.rating.value, 10); }
function hiPct(p) { return `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`; }

function hiOnce(key, load) {
  if (!hiPromises.has(key)) {
    const started = performance.now();
    const p = load().then((value) => {
      hiData.set(key, value);
      console.debug(`[insights] ${key} ${Math.round(performance.now() - started)}ms`);
      return value;
    }, (err) => {
      hiPromises.delete(key);
      throw err;
    });
    hiPromises.set(key, p);
  }
  return hiPromises.get(key);
}

async function hiContext(ply) {
  const ucis = await hiUcis();
  return { startFen: loadedGame.startFen, ucis: ucis.slice(0, ply), played: ucis[ply] || null };
}

function hiFetchMoves(ply, rating) {
  return hiOnce(`moves:${ply}:${rating}`, async () =>
    invoke("human_moves", { ...(await hiContext(ply)), ratings: [rating], rating }));
}

function hiFetchChart(ply) {
  return hiOnce(`chart:${ply}`, async () =>
    invoke("human_moves", { ...(await hiContext(ply)), ratings: HI_CHART_RATINGS, rating: HI_CHART_RATINGS[0] }));
}

function hiFetchScores(ply, rating, moves) {
  return hiOnce(`scores:${ply}:${rating}`, async () => {
    const ctx = await hiContext(ply);
    return invoke("score_human_moves", {
      startFen: ctx.startFen,
      ucis: ctx.ucis,
      moves: moves.moves.map((m) => m.uci),
      depth: HI_SCORE_DEPTH,
    });
  });
}

function hiResetForGame() {
  hiPromises.clear();
  hiData.clear();
  hiToken++;
  hi.panel.style.display = "block";
  hi.body.style.display = "none";
  hi.status.textContent = "";
}

let hiMaiaStart = null;

function hiEnsureMaia() {
  if (!hiMaiaStart) {
    hiMaiaStart = invoke("start_insights_engine", { command: getActiveModel() }).catch((err) => {
      hiMaiaStart = null;
      throw err;
    });
  }
  return hiMaiaStart;
}

async function hiEnsureEngines() {
  if (hiEnginesReady) return true;
  hi.status.textContent = "Starting engines…";
  const [sfOk, maiaErr] = await Promise.all([
    ensureStockfish(),
    hiEnsureMaia().then(() => null, (err) => err),
  ]);
  if (!sfOk) {
    hi.status.textContent = az.analyzeStatus.textContent;
    return false;
  }
  if (maiaErr) {
    hi.status.textContent = "Maia isn't available: " + maiaErr;
    return false;
  }
  hiEnginesReady = true;
  return true;
}

// Games sent from the Play tab only carry SANs, so the UCI moves come from a round trip through the PGN parser.
async function hiUcis() {
  if (!loadedGame.ucis) {
    const pgn = sanHistoryToPgn(loadedGame.sans, loadedGame.startFen, "*");
    loadedGame.ucis = (await invoke("parse_pgn", { pgnText: pgn })).ucis;
  }
  return loadedGame.ucis;
}

function hiArrowsFrom(moves) {
  if (!moves) return [];
  return moves.moves.slice(0, 2).map((m) => {
    const sq = uciToSquares(m.uci);
    return sq ? { from: sq[0], to: sq[1], brush: "human", opacity: 0.5 + 0.4 * m.prob } : null;
  }).filter(Boolean);
}

function hiArrowsAt(ply) {
  if (!hi.enable.checked || !hi.arrows.checked) return [];
  return hiArrowsFrom(hiData.get(`moves:${ply}:${hiRating()}`));
}

function hiRedrawBoard() {
  if (puzzleMode) return;
  hiRedrawing = true;
  try { renderAnalyzeBoard(); } finally { hiRedrawing = false; }
}

async function hiRefresh() {
  if (hiRedrawing) return;
  if (!hi.enable.checked || !loadedGame || variation || puzzleMode) {
    hiToken++;
    hi.body.style.display = "none";
    if (!hi.enable.checked) hi.status.textContent = "";
    return;
  }

  const token = ++hiToken;
  const ply = azViewPly;
  const rating = hiRating();
  if (!hiData.has(`moves:${ply}:${rating}`)) {
    hi.status.textContent = "Thinking…";
    await new Promise((r) => setTimeout(r, 250));
    if (token !== hiToken) return;
    if (!(await hiEnsureEngines())) return;
  }

  let moves;
  try {
    moves = await hiFetchMoves(ply, rating);
  } catch (err) {
    if (token === hiToken) hi.status.textContent = "Insights failed: " + err;
    return;
  }
  if (token !== hiToken || puzzleMode) return;

  hi.status.textContent = "";
  hiRender(ply, rating);
  hiRedrawBoard();

  const rerender = () => { if (token === hiToken && !puzzleMode) hiRender(ply, rating); };
  hiFetchScores(ply, rating, moves).then(rerender, (err) => {
    if (token === hiToken) hi.status.textContent = "Scoring failed: " + err;
  });
  if (hi.chartBox.open) hiFetchChart(ply).then(rerender, () => {});
}

function hiRender(ply, rating) {
  const moves = hiData.get(`moves:${ply}:${rating}`);
  if (!moves) return;
  if (!moves.moves.length) {
    hi.body.style.display = "none";
    hi.status.textContent = "No moves to show here (game over).";
    return;
  }
  const scores = hiData.get(`scores:${ply}:${rating}`);
  const byUci = new Map((scores ? scores.scores : []).map((s) => [s.uci, s]));
  const rows = moves.moves.map((m) => ({ ...m, score: byUci.get(m.uci) || null }));

  hi.body.style.display = "block";
  hiRenderSummary(rows, rating);
  hiRenderMeter(rows, scores !== undefined);
  hiRenderMoves(rows, scores ? scores.bestUci : null);
  if (hi.chartBox.open) hiRenderChart(rows, hiData.get(`chart:${ply}`), rating);
}

function hiRenderSummary(rows, rating) {
  const played = rows.find((r) => r.played);
  hi.summary.textContent = "";
  if (played) {
    const b = document.createElement("b");
    b.textContent = played.san;
    hi.summary.append(b, ` was played — a ${rating} player chooses it ${hiPct(played.prob)} of the time. `);
  } else {
    hi.summary.append("Most likely moves for this position. ");
  }
  hi.summary.append(`Top human choice: ${rows[0].san} (${hiPct(rows[0].prob)}).`);
}

function hiRenderMeter(rows, scored) {
  hi.meter.textContent = "";
  hi.meterLegend.textContent = "";
  if (!scored) {
    const seg = document.createElement("div");
    seg.style.width = "100%";
    seg.style.background = "#2c3038";
    hi.meter.appendChild(seg);
    hi.meterLegend.textContent = "Scoring moves…";
    return;
  }

  const sums = { good: 0, ok: 0, blunder: 0 };
  rows.forEach((r) => { if (r.score) sums[r.score.class] += r.prob; });
  const total = sums.good + sums.ok + sums.blunder || 1;

  for (const cls of ["good", "ok", "blunder"]) {
    const share = sums[cls] / total;
    const seg = document.createElement("div");
    seg.style.width = `${share * 100}%`;
    seg.style.background = HI_CLASS_COLORS[cls];
    seg.title = `${HI_CLASS_LABELS[cls]}: ${hiPct(share)}`;
    hi.meter.appendChild(seg);

    const label = document.createElement("span");
    label.style.color = HI_CLASS_COLORS[cls];
    label.textContent = `${HI_CLASS_LABELS[cls]} ${Math.round(share * 100)}%`;
    hi.meterLegend.appendChild(label);
  }
}

function hiRenderMoves(rows, bestUci) {
  hi.moves.textContent = "";
  const top = rows[0].prob || 1;
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "hiRow" + (r.played ? " played" : "") + (r.uci === bestUci ? " best" : "");
    if (r.score) row.title = `Loses ${(r.score.winLoss * 100).toFixed(1)}% win chance vs the engine's best`;

    const san = document.createElement("span");
    san.className = "san";
    san.textContent = r.san;
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("span");
    fill.style.width = `${(r.prob / top) * 100}%`;
    fill.style.background = r.score ? HI_CLASS_COLORS[r.score.class] : HI_PENDING_COLOR;
    bar.appendChild(fill);
    const pct = document.createElement("span");
    pct.className = "pct";
    pct.textContent = hiPct(r.prob);

    row.append(san, bar, pct);
    hi.moves.appendChild(row);
  }
}

function hiRenderChart(rows, chartData, rating) {
  const W = 320, H = 150, L = 30, R = 8, T = 8, B = 20;
  const svg = hi.chart;
  svg.textContent = "";
  hi.chartLegend.textContent = "";

  if (!chartData) {
    svgEl("text", { x: W / 2, y: H / 2, "text-anchor": "middle", "font-size": 11, fill: "#9aa0ab" }, svg).textContent = "Loading…";
    return;
  }

  const ratings = chartData.maia.ratings;
  const shown = rows.slice(0, 4);
  const played = rows.find((r) => r.played);
  if (played && !shown.includes(played)) shown.push(played);

  const series = shown.map((r) => chartData.maia.policies.map((pol) => pol[r.uci] || 0));
  const yMax = Math.max(0.1, ...series.flat());
  const lo = ratings[0], hiR = ratings[ratings.length - 1];
  const x = (rt) => L + ((rt - lo) / (hiR - lo)) * (W - L - R);
  const y = (v) => T + (1 - v / yMax) * (H - T - B);

  for (const frac of [0, 0.5, 1]) {
    const gy = y(yMax * frac);
    svgEl("line", { x1: L, x2: W - R, y1: gy, y2: gy, stroke: "#2c3038", "stroke-width": 1 }, svg);
    svgEl("text", { x: L - 4, y: gy + 3, "text-anchor": "end", "font-size": 9, fill: "#9aa0ab" }, svg).textContent = `${Math.round(yMax * frac * 100)}%`;
  }
  for (const rt of [600, 1100, 1600, 2100, 2600]) {
    svgEl("text", { x: x(rt), y: H - 5, "text-anchor": "middle", "font-size": 9, fill: "#9aa0ab" }, svg).textContent = rt;
  }
  svgEl("line", { x1: x(rating), x2: x(rating), y1: T, y2: H - B, stroke: "#5a86f5", "stroke-width": 1, "stroke-dasharray": "3 3" }, svg);

  series.forEach((values, n) => {
    const color = HI_LINE_COLORS[n % HI_LINE_COLORS.length];
    const points = values.map((v, i) => `${x(ratings[i]).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    svgEl("polyline", { points, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round" }, svg);

    const item = document.createElement("span");
    const swatch = document.createElement("i");
    swatch.style.background = color;
    item.append(swatch, shown[n].san);
    hi.chartLegend.appendChild(item);
  });
}

hi.enable.addEventListener("change", () => {
  if (puzzleMode) { hiSyncPuzzle(); return; }
  hiRefresh();
  if (!hi.enable.checked) renderAnalyzeBoard();
});
hi.rating.addEventListener("change", () => { if (puzzleMode) hiSyncPuzzle(); else hiRefresh(); });
hi.chartBox.addEventListener("toggle", () => { if (hi.chartBox.open) hiRefresh(); });
hi.arrows.addEventListener("change", () => { if (puzzleMode) hiSyncPuzzle(); else renderAnalyzeBoard(); });
