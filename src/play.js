const els = {
  board: document.getElementById("board"),
  status: document.getElementById("status-line"),
  moveList: document.getElementById("move-list"),
  startBtn: document.getElementById("start-btn"),
  flipBtn: document.getElementById("flip-btn"),
  resignBtn: document.getElementById("resign-btn"),
  analyzeThisBtn: document.getElementById("analyze-this-btn"),
  sideSelect: document.getElementById("side-select"),
  activeModelName: document.getElementById("active-model-name"),
  noModelHint: document.getElementById("no-model-hint"),
  modelSelect: document.getElementById("model-select"),
  eloSlider: document.getElementById("elo-slider"),
  eloValue: document.getElementById("elo-value"),
  eloLiveHint: document.getElementById("elo-live-hint"),
  temperatureSlider: document.getElementById("temperature-slider"),
  temperatureValue: document.getElementById("temperature-value"),
  topPSlider: document.getElementById("top-p-slider"),
  topPValue: document.getElementById("top-p-value"),
  openingCheckbox: document.getElementById("opening-checkbox"),
  helpToast: document.getElementById("help-toast"),
  promoPicker: document.getElementById("promo-picker"),
  startFenInput: document.getElementById("start-fen-input"),
  clearFenBtn: document.getElementById("clear-fen-btn"),
  fenError: document.getElementById("fen-error"),
  openSetupBtn: document.getElementById("open-setup-btn"),
  undoBtn: document.getElementById("undo-btn"),
  copyPgnBtn: document.getElementById("copy-pgn-btn"),
  historyNotice: document.getElementById("history-notice"),
  goLiveBtn: document.getElementById("go-live-btn"),
  navStart: document.getElementById("nav-start"),
  navPrev: document.getElementById("nav-prev"),
  navNext: document.getElementById("nav-next"),
  navEnd: document.getElementById("nav-end"),
  materialTop: document.getElementById("materialTop"),
  materialBottom: document.getElementById("materialBottom"),
  setupPanel: document.getElementById("setup-panel"),
  setupSummary: document.getElementById("setup-summary"),
  advanced: document.getElementById("advanced-settings"),
  advancedSummary: document.getElementById("advanced-summary"),
  movesMeta: document.getElementById("moves-meta"),
};

let state = {
  fen: STANDARD_FEN,
  turn: "white",
  status: "not-started",
  winner: null,
  lastMove: null,
  sanHistory: [],
};

let playerColor = "white";
let flipped = false;
let selected = null;
let legalTargets = [];
let engineBusy = false;
let gameStarted = false;
let startFen = STANDARD_FEN;

// One entry per ply (0 = start), mirrors the backend's game state.
let posHistory = [{ fen: STANDARD_FEN, lastMove: null }];
let viewPly = 0; // index into posHistory currently shown; live = length-1

els.eloSlider.addEventListener("input", () => { els.eloValue.textContent = els.eloSlider.value; });
els.eloSlider.addEventListener("change", async () => {
  if (!gameStarted || isGameOver()) return; // pre-game, this just sets the value startGame() will read
  const elo = parseInt(els.eloSlider.value, 10);
  try {
    await invoke("set_engine_elo", { elo });
    els.movesMeta.textContent = `You (${playerColor}) vs Maia-3 · ${elo} Elo`;
    setStatus(`Maia-3 Elo set to ${elo} for the rest of this game.`);
  } catch (err) {
    setStatus(`Could not update Elo: ${err}`);
  }
});
els.temperatureSlider.addEventListener("input", () => { els.temperatureValue.textContent = Number(els.temperatureSlider.value).toFixed(2).replace(/0$/, ""); });
els.topPSlider.addEventListener("input", () => { els.topPValue.textContent = Number(els.topPSlider.value).toFixed(2).replace(/0$/, ""); });
const HELP = {
  temperature: ["Temperature", "How closely Maia sticks to its favorite move. Low plays the top choice almost every time. 1.0 mirrors how real players at this Elo pick moves."],
  topP: ["Top-p", "Drops the least likely moves before Maia picks. Lower cuts obvious blunders. At 1.0 every legal move stays in play."],
  opening: ["Loose opening", "Plays Maia's first 4 moves at temp 1.0 and top-p 1.0, so low temperatures don't open 1.e4 every game. Your settings take over from move 5."],
};
let helpKey = null;
let helpTimer = null;

function hideHelp() {
  helpKey = null;
  els.helpToast.classList.remove("show");
  document.querySelectorAll(".helpBtn").forEach((b) => b.classList.remove("active"));
}

function showHelp(key, ms = 7000) {
  clearTimeout(helpTimer);
  helpKey = key;
  const [title, body] = HELP[key];
  els.helpToast.textContent = `${title}. ${body}`;
  els.helpToast.classList.add("show");
  document.querySelectorAll(".helpBtn").forEach((b) => b.classList.toggle("active", b.dataset.help === key));
  helpTimer = setTimeout(hideHelp, ms);
}

document.querySelectorAll(".helpBtn").forEach((btn) => btn.addEventListener("click", () => {
  if (helpKey === btn.dataset.help) { clearTimeout(helpTimer); hideHelp(); } else showHelp(btn.dataset.help);
}));
[[els.temperatureSlider, "temperature"], [els.topPSlider, "topP"]].forEach(([el, key]) => {
  el.addEventListener("pointerdown", () => showHelp(key, 60000));
  el.addEventListener("pointerup", () => showHelp(key, 2500));
});
els.openingCheckbox.addEventListener("change", () => { if (els.openingCheckbox.checked) showHelp("opening"); });

els.startBtn.addEventListener("click", startGame);
els.flipBtn.addEventListener("click", () => { flipped = !flipped; renderPlayBoard(); });
els.resignBtn.addEventListener("click", resign);
els.clearFenBtn.addEventListener("click", () => { els.startFenInput.value = ""; hideFenError(); updateAdvancedSummary(); });
els.undoBtn.addEventListener("click", doUndo);
els.copyPgnBtn.addEventListener("click", copyPgn);
function viewMove(ply) {
  viewPly = Math.max(0, Math.min(posHistory.length - 1, ply));
  renderPlayBoard();
  renderMoveList();
}

els.goLiveBtn.addEventListener("click", () => viewMove(posHistory.length - 1));
els.navStart.addEventListener("click", () => viewMove(0));
els.navPrev.addEventListener("click", () => viewMove(viewPly - 1));
els.navNext.addEventListener("click", () => viewMove(viewPly + 1));
els.navEnd.addEventListener("click", () => viewMove(posHistory.length - 1));

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (!document.getElementById("playTab").classList.contains("active")) return;
  if (document.getElementById("setup-overlay").classList.contains("show")) return;
  if (e.target.closest && e.target.closest("input, textarea, select, summary")) return;

  const navTargets = { ArrowLeft: viewPly - 1, ArrowRight: viewPly + 1, Home: 0, End: posHistory.length - 1 };
  if (e.key in navTargets) {
    e.preventDefault();
    viewMove(navTargets[e.key]);
    return;
  }
  const key = e.key.toLowerCase();
  if (key === "f") {
    e.preventDefault();
    els.flipBtn.click();
  } else if (key === "u" && !els.undoBtn.disabled) {
    e.preventDefault();
    els.undoBtn.click();
  } else if (key === "n" && !els.startBtn.disabled) {
    e.preventDefault();
    els.startBtn.click();
  }
});

function selectedSide() {
  return els.sideSelect.querySelector("button.active").dataset.value;
}

els.sideSelect.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-value]");
  if (!btn) return;
  els.sideSelect.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b === btn);
    b.setAttribute("aria-checked", String(b === btn));
  });
});

function updateAdvancedSummary() {
  els.advancedSummary.textContent = els.startFenInput.value.trim() ? "Advanced · custom position" : "Advanced";
}
els.startFenInput.addEventListener("input", updateAdvancedSummary);
els.setupPanel.querySelector("h2").addEventListener("click", () => els.setupPanel.classList.toggle("collapsed"));
els.analyzeThisBtn.addEventListener("click", sendGameToAnalyze);
document.getElementById("new-game-btn").addEventListener("click", () => {
  switchTab("play");
  els.setupPanel.classList.remove("collapsed");
});

function hideFenError() { els.fenError.style.display = "none"; els.fenError.textContent = ""; }
function showFenError(msg) {
  els.fenError.textContent = msg;
  els.fenError.style.display = "block";
  els.advanced.open = true;
}

function modelLabel(model) {
  return model.replace("maia3-", "").toUpperCase();
}

// Wrapped since localStorage can throw (privacy mode, disabled storage); shouldn't take the tab down.
const activeModelStore = {
  get() { try { return localStorage.getItem("maia3.activeModel"); } catch { return null; } },
  set(v) { try { localStorage.setItem("maia3.activeModel", v); } catch {} },
};

let activeModelReady = false;

function syncStartButton() {
  els.startBtn.disabled = !activeModelReady;
  els.startBtn.textContent = startLabel();
}

async function refreshActiveModelUI() {
  let ready = [];
  try {
    ready = await invoke("list_models");
  } catch {
    ready = [];
  }
  const stored = activeModelStore.get();
  const active = (stored && ready.includes(stored)) ? stored : (ready[0] || null);
  if (active) activeModelStore.set(active);

  activeModelReady = !!active;
  els.activeModelName.textContent = active ? modelLabel(active) : "None bundled";
  els.noModelHint.style.display = active ? "none" : "block";

  const picker = els.modelSelect;
  const fixedModel = ready.length <= 1;
  picker.hidden = fixedModel;
  els.activeModelName.hidden = !fixedModel;
  els.activeModelName.classList.toggle("fixedModel", fixedModel);
  picker.replaceChildren(...ready.map((id) => new Option(modelLabel(id), id, false, id === active)));
  syncStartButton();
}

els.modelSelect.addEventListener("change", () => {
  activeModelStore.set(els.modelSelect.value);
});

function getActiveModel() {
  const model = activeModelStore.get();
  if (!model) throw new Error("This build has no Maia-3 model bundled.");
  return model;
}

refreshActiveModelUI();

function startLabel() {
  return gameStarted && !isGameOver() ? "Start new game" : "Start game";
}

async function startGame() {
  els.startBtn.disabled = true;
  els.startBtn.textContent = "Loading model…";
  setStatus("Starting Maia-3…");

  try {
    const fenInput = els.startFenInput.value.trim();
    if (fenInput) {
      try {
        await invoke("validate_fen", { fen: fenInput });
      } catch (err) {
        showFenError(String(err));
        els.startBtn.disabled = false;
        els.startBtn.textContent = startLabel();
        setStatus("Fix the Start FEN before starting.");
        return;
      }
    }
    hideFenError();

    const chosen = selectedSide();
    playerColor = chosen === "random" ? (Math.random() < 0.5 ? "white" : "black") : chosen;
    flipped = playerColor === "black";

    const model = getActiveModel();
    const elo = parseInt(els.eloSlider.value, 10);
    const temperature = Number(els.temperatureSlider.value);
    const topP = Number(els.topPSlider.value);
    const openingMoves = els.openingCheckbox.checked ? 4 : 0;

    state = await invoke("new_game", { fen: fenInput || null });
    startFen = state.fen === STANDARD_FEN ? STANDARD_FEN : (fenInput || state.fen);
    posHistory = [{ fen: state.fen, lastMove: null }];
    viewPly = 0;

    await invoke("start_engine", {
      command: model,
      elo,
      extraArgs: [
        "--temperature", String(temperature),
        "--top-p", String(topP),
        "--opening-moves", String(openingMoves),
        // Fresh seed per game so temperature > 0 actually varies between games.
        "--seed", String((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0),
      ],
    });

    gameStarted = true;
    selected = null;
    legalTargets = [];
    els.setupSummary.textContent = `${playerColor === "white" ? "White" : "Black"} · ${elo} · ${model.replace("maia3-", "").toUpperCase()}`;
    els.movesMeta.textContent = `You (${playerColor}) vs Maia-3 · ${elo} Elo`;
    els.setupPanel.classList.add("collapsed");
    els.eloLiveHint.style.display = "";
    renderPlayBoard();
    renderMoveList();
    const tempNote = temperature > 0
      ? `, temp ${temperature}, top-p ${topP}${openingMoves ? `, opening ${openingMoves}` : ""}`
      : ", greedy";
    setStatus(`Playing as ${playerColor}. Maia-3 (${model}, ${elo} Elo${tempNote}) is your opponent.`);

    if (state.turn !== playerColor) {
      await triggerEngineMove();
    }
  } catch (err) {
    setStatus(`Could not start engine: ${err}`);
  } finally {
    syncStartButton();
  }
}

async function resign() {
  if (!gameStarted || isGameOver()) return;
  gameStarted = false;
  state.status = "resigned";
  state.winner = playerColor === "white" ? "black" : "white";
  await invoke("stop_engine").catch(() => {});
  renderPlayBoard();
  renderMoveList();
  setStatus("You resigned.");
}

function isGameOver() {
  return ["checkmate", "stalemate", "draw", "resigned"].includes(state.status);
}

function setStatus(text) { els.status.textContent = text; }

function statusBanner() {
  switch (state.status) {
    case "checkmate":
      return `Checkmate — ${state.winner === playerColor ? "you win!" : "Maia-3 wins."}`;
    case "stalemate": return "Draw by stalemate.";
    case "draw": return "Draw.";
    case "resigned": return "You resigned.";
    default: return state.turn === playerColor ? "Your move." : "Maia-3 is thinking…";
  }
}

async function triggerEngineMove() {
  if (isGameOver()) return;
  engineBusy = true;
  updateControls();
  setStatus("Maia-3 is thinking…");
  try {
    state = await invoke("engine_move");
    posHistory.push({ fen: state.fen, lastMove: state.lastMove });
    viewPly = posHistory.length - 1;
    renderPlayBoard();
    renderMoveList();
  } catch (err) {
    if (!String(err).includes("game changed")) setStatus(`Engine error: ${err}`);
  } finally {
    engineBusy = false;
    updateControls();
    if (!isGameOver()) setStatus(statusBanner());
  }
}

async function attemptMove(from, to) {
  if (!isLive()) return;
  const promoNeeded = needsPromotionMove(state.fen, from, to);
  let promotion = null;
  if (promoNeeded) {
    const prefix = playerColor === "white" ? "w" : "b";
    promotion = await askPromotion(els.promoPicker, prefix);
    if (!promotion) { clearSelection(); renderPlayBoard(); return; }
  }

  try {
    state = await invoke("make_move", { from, to, promotion });
    posHistory.push({ fen: state.fen, lastMove: state.lastMove });
    viewPly = posHistory.length - 1;
    clearSelection();
    renderPlayBoard();
    renderMoveList();
    if (isGameOver()) { setStatus(statusBanner()); return; }
    setStatus(statusBanner());
    if (state.turn !== playerColor) {
      await triggerEngineMove();
      if (isGameOver()) setStatus(statusBanner());
    }
  } catch (err) {
    clearSelection();
    renderPlayBoard();
    setStatus(`Move rejected: ${err}`);
  }
}

function clearSelection() { selected = null; legalTargets = []; }

function isLive() { return viewPly === posHistory.length - 1; }
function currentViewFen() { return posHistory[viewPly] ? posHistory[viewPly].fen : state.fen; }

function findKingInCheckSquare(board, turnColor) {
  const kingChar = turnColor === "white" ? "K" : "k";
  for (const [sq, p] of Object.entries(board)) if (p === kingChar) return sq;
  return null;
}

let gameOverHandled = false;

function updateControls() {
  if (isGameOver()) {
    if (!gameOverHandled) {
      saveRecentGame();
      els.setupPanel.classList.remove("collapsed");
      els.eloLiveHint.style.display = "none";
    }
    gameOverHandled = true;
  } else {
    gameOverHandled = false;
  }
  els.historyNotice.classList.toggle("show", !isLive());
  els.navStart.disabled = viewPly === 0;
  els.navPrev.disabled = viewPly === 0;
  els.navNext.disabled = viewPly >= posHistory.length - 1;
  els.navEnd.disabled = viewPly >= posHistory.length - 1;
  els.undoBtn.disabled = !gameStarted || posHistory.length <= 1 || engineBusy;
  els.copyPgnBtn.disabled = posHistory.length <= 1;
  els.analyzeThisBtn.disabled = posHistory.length <= 1;
}

function renderPlayBoard() {
  const viewingLive = isLive();
  const fen = currentViewFen();
  const entry = posHistory[viewPly] || { lastMove: null };

  updateControls();

  const board = fenToBoard(fen);
  const checkSquare = (viewingLive && state.inCheck) ? findKingInCheckSquare(board, sideToMove(fen)) : null;

  renderMaterialBars(els.materialTop, els.materialBottom, fen, flipped);
  renderChessBoard(els.board, fen, {
    flipped,
    selected: viewingLive ? selected : null,
    legalTargets: viewingLive ? legalTargets : [],
    lastMove: entry.lastMove,
    checkSquare,
    interactive: viewingLive,
    canDrag: (piece) => canPlayerMove() && isPieceOfColor(piece, playerColor),
    onGrab: onPlaySquareClick,
    onDeselect: () => { clearSelection(); renderPlayBoard(); },
    onSquareClick: onPlaySquareClick,
    onDropMove: (from, to) => {
      if (selected === from && legalTargets.length > 0 && !legalTargets.includes(to)) {
        renderPlayBoard();
        return;
      }
      clearSelection();
      attemptMove(from, to);
    },
  });
}

function canPlayerMove() {
  return gameStarted && !isGameOver() && !engineBusy && isLive() && state.turn === playerColor;
}

async function onPlaySquareClick(sq) {
  if (!gameStarted || isGameOver() || engineBusy || !isLive()) return;
  if (state.turn !== playerColor) return;

  const board = fenToBoard(state.fen);
  const piece = board[sq];
  const isOwnPiece = piece && ((playerColor === "white" && piece === piece.toUpperCase()) ||
                                (playerColor === "black" && piece === piece.toLowerCase()));

  if (selected && legalTargets.includes(sq)) {
    const from = selected;
    clearSelection();
    await attemptMove(from, sq);
    return;
  }

  if (isOwnPiece) {
    if (selected === sq) return;
    selected = sq;
    legalTargets = [];
    renderPlayBoard();
    let targets = [];
    try { targets = await invoke("legal_targets", { square: sq }); } catch { targets = []; }
    // piece was dropped or another one picked while this was in flight
    if (selected !== sq) return;
    legalTargets = targets;
    renderPlayBoard();
    return;
  }

  clearSelection();
  renderPlayBoard();
}

// Numbering follows the start position, which can be Black to move or mid-game.
function movePairs(sans, fen) {
  const parts = (fen || STANDARD_FEN).split(" ");
  let isWhite = parts[1] !== "b";
  let num = parseInt(parts[5], 10) || 1;
  const rows = [];
  let row = null;
  sans.forEach((san, i) => {
    if (!row || isWhite) {
      row = { num, white: null, black: null };
      rows.push(row);
    }
    row[isWhite ? "white" : "black"] = { san, ply: i + 1 };
    if (!isWhite) num += 1;
    isWhite = !isWhite;
  });
  return rows;
}

function gameResult(st) {
  if (st.status === "checkmate" || st.status === "resigned") return st.winner === "white" ? "1-0" : "0-1";
  if (st.status === "stalemate" || st.status === "draw") return "1/2-1/2";
  return null;
}

const RESULT_REASON = { checkmate: "checkmate", resigned: "resignation", stalemate: "stalemate", draw: "draw" };

function renderMoveList() {
  const list = els.moveList;
  list.innerHTML = "";
  const history = state.sanHistory || [];
  if (history.length === 0) {
    const empty = document.createElement("li");
    empty.className = "move-empty";
    empty.textContent = "No moves yet.";
    list.appendChild(empty);
    return;
  }

  movePairs(history, startFen).forEach((row) => {
    const li = document.createElement("li");
    li.className = "move-row";
    const numEl = document.createElement("span");
    numEl.className = "move-num";
    numEl.textContent = `${row.num}.`;
    li.appendChild(numEl);

    [row.white, row.black].forEach((m, side) => {
      const cell = document.createElement("span");
      cell.className = "move-san";
      if (m) {
        cell.textContent = m.san;
        if (m.ply === viewPly) cell.classList.add("current");
        cell.addEventListener("click", () => viewMove(m.ply));
      } else {
        cell.classList.add("empty");
        // A missing White move only happens when the game starts with Black to move.
        cell.textContent = side === 0 ? "…" : "";
      }
      li.appendChild(cell);
    });
    list.appendChild(li);
  });

  const result = gameResult(state);
  if (result) {
    const li = document.createElement("li");
    li.className = "move-result";
    li.textContent = result;
    const why = document.createElement("small");
    why.textContent = RESULT_REASON[state.status] || "";
    li.appendChild(why);
    list.appendChild(li);
  }

  // Keep the current move in view without scrolling anything outside the list.
  const cur = list.querySelector(".current");
  const strip = getComputedStyle(list).display === "flex"; // phone layout lays the list out as one scrolling row
  if (!cur) {
    if (strip) list.scrollLeft = viewPly === 0 ? 0 : list.scrollWidth;
    else list.scrollTop = viewPly === 0 ? 0 : list.scrollHeight;
    return;
  }
  const lr = list.getBoundingClientRect();
  const cr = cur.getBoundingClientRect();
  if (strip) {
    list.scrollLeft += cr.left - lr.left - (lr.width - cr.width) / 2;
    return;
  }
  if (cr.top < lr.top) list.scrollTop -= lr.top - cr.top;
  else if (cr.bottom > lr.bottom) list.scrollTop += cr.bottom - lr.bottom;
}

async function doUndo() {
  if (!gameStarted || posHistory.length <= 1 || engineBusy) return;
  // A fixed 2 plies left the engine on move (board dead) whenever its last reply had failed, so go back to the player's turn instead.
  let removed = 0;
  while (posHistory.length > 1) {
    try {
      state = await invoke("undo_move");
      posHistory.pop();
      removed += 1;
    } catch { break; }
    if (state.turn === playerColor) break;
  }
  if (removed === 0) return;
  viewPly = posHistory.length - 1;
  clearSelection();
  renderPlayBoard();
  renderMoveList();
  setStatus(statusBanner());
  if (!isGameOver() && state.turn !== playerColor) triggerEngineMove();
}

function sanHistoryToPgn(sanHistory, fenForHeader, result) {
  const lines = [];
  if (fenForHeader && fenForHeader !== STANDARD_FEN) {
    lines.push('[SetUp "1"]');
    lines.push(`[FEN "${fenForHeader}"]`);
  }
  const parts = movePairs(sanHistory, fenForHeader).map((row) => {
    if (row.white) return `${row.num}. ${row.white.san}${row.black ? " " + row.black.san : ""}`;
    return `${row.num}... ${row.black.san}`;
  });
  if (result) parts.push(result);
  lines.push(parts.join(" "));
  return lines.join("\n");
}

async function copyPgn() {
  const pgn = sanHistoryToPgn(state.sanHistory, startFen, gameResult(state));
  try {
    await navigator.clipboard.writeText(pgn);
    const original = els.copyPgnBtn.textContent;
    els.copyPgnBtn.textContent = "Copied!";
    setTimeout(() => { els.copyPgnBtn.textContent = original; }, 1200);
  } catch {
    window.prompt("Copy PGN:", pgn);
  }
}

function sendGameToAnalyze() {
  if (posHistory.length <= 1) return;
  const fens = posHistory.slice(1).map((p) => p.fen);
  loadAnalysisGame({
    startFen: startFen,
    sans: state.sanHistory.slice(),
    fens,
    myColor: playerColor,
  });
  switchTab("analyze");
}

renderPlayBoard();
