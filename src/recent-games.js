const RECENT_KEY = "maia3.recentGames.v1";
const RECENT_MAX = 20;
const recentPanel = document.getElementById("recentPanel");
const recentList = document.getElementById("recentList");
const recentClearBtn = document.getElementById("recentClearBtn");
const ANALYSIS_KEY = "maia3.analysisCache.v1";
const ANALYSIS_MAX = 8; // each analysis is ~100 KB of JSON and localStorage is only ~5 MB

function readRecentGames() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; }
}

// Same game from play or from a pasted PGN should hit the same entry, so drop check/annotation marks.
function analysisKey(startFen, sans) {
  const fen = !startFen || startFen === STANDARD_FEN ? "" : startFen;
  return `${fen}|${sans.map((s) => s.replace(/[+#!?]/g, "")).join(" ")}`;
}

function readAnalysisCache() {
  try { return JSON.parse(localStorage.getItem(ANALYSIS_KEY)) || []; } catch { return []; }
}

function cacheAnalysis(game, result, depth) {
  const key = analysisKey(game.startFen, game.sans);
  const keep = readAnalysisCache().filter((e) => e.key !== key);
  keep.unshift({ key, depth, analysis: result });
  keep.length = Math.min(keep.length, ANALYSIS_MAX);
  // out of space: drop the oldest analysis and try again
  while (keep.length) {
    try { localStorage.setItem(ANALYSIS_KEY, JSON.stringify(keep)); break; } catch { keep.pop(); }
  }
  renderRecentGames();
}

function applyCachedAnalysis(game) {
  const hit = readAnalysisCache().find((e) => e.key === analysisKey(game.startFen, game.sans));
  if (!hit || hit.analysis.length !== game.sans.length) return;
  analysis = hit.analysis;
  analysisDepth = hit.depth;
  if ([...az.depthSelect.options].some((o) => o.value === String(hit.depth))) az.depthSelect.value = String(hit.depth);
  az.analyzeStatus.textContent = `Analyzed ${analysis.length} moves (saved from last time).`;
  renderAnalyzeMoveList();
  renderFlaggedList();
  drawEvalGraph();
  az.moveListPanel.style.display = "block";
  az.flaggedPanel.style.display = "block";
  az.controlsPanel.classList.add("collapsed");
}

function saveRecentGame() {
  if (posHistory.length <= 1) return;
  const result = gameResult(state);
  const pgn = sanHistoryToPgn(state.sanHistory, startFen, result);
  const games = readRecentGames();
  if (games[0] && games[0].pgn === pgn) return;
  games.unshift({
    t: Date.now(), pgn, color: playerColor, elo: els.eloSlider.value, result,
    plies: state.sanHistory.length, key: analysisKey(startFen, state.sanHistory),
  });
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(games.slice(0, RECENT_MAX))); } catch {}
  renderRecentGames();
}

function recentTitle(g) {
  const side = g.color === "black" ? "Black" : "White";
  if (!g.result) return `Game as ${side}`;
  if (g.result === "1/2-1/2") return `Draw as ${side}`;
  const won = (g.result === "1-0") === (g.color !== "black");
  return `${won ? "Won" : "Lost"} as ${side}`;
}

function renderRecentGames() {
  const games = readRecentGames();
  recentPanel.style.display = games.length ? "" : "none";
  recentList.textContent = "";
  const analyzed = new Set(readAnalysisCache().map((e) => e.key));
  for (const g of games) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "recentItem";
    const title = document.createElement("span");
    title.className = "recentTitle";
    title.textContent = recentTitle(g);
    const meta = document.createElement("span");
    meta.className = "recentMeta";
    const when = new Date(g.t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    meta.textContent = `${Math.ceil(g.plies / 2)} moves · ${g.elo} Elo · ${when}${analyzed.has(g.key) ? " · analyzed" : ""}`;
    btn.append(title, meta);
    btn.addEventListener("click", () => loadRecentGame(g));
    recentList.appendChild(btn);
  }
}

async function loadRecentGame(g) {
  try {
    const parsed = await invoke("parse_pgn", { pgnText: g.pgn });
    loadAnalysisGame({ startFen: parsed.startFen, sans: parsed.sans, fens: parsed.fens, ucis: parsed.ucis, myColor: g.color });
    az.pgnInput.value = g.pgn;
    document.querySelector("main").scrollTo({ top: 0, behavior: "smooth" });
  } catch (err) {
    az.analyzeStatus.textContent = `Could not load that game: ${err}`;
  }
}

recentPanel.querySelector("h2").addEventListener("click", () => recentPanel.classList.toggle("collapsed"));

let recentClearTimer = null;
recentClearBtn.addEventListener("click", () => {
  if (recentClearTimer === null) {
    recentClearBtn.textContent = "Tap again to clear";
    recentClearTimer = setTimeout(() => { recentClearTimer = null; recentClearBtn.textContent = "Clear list"; }, 3000);
    return;
  }
  clearTimeout(recentClearTimer);
  recentClearTimer = null;
  recentClearBtn.textContent = "Clear list";
  try { localStorage.removeItem(RECENT_KEY); localStorage.removeItem(ANALYSIS_KEY); } catch {}
  renderRecentGames();
});

renderRecentGames();
