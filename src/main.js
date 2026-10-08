// Android can kill the app in the background, so save enough to reopen where you left off.
const SESSION_KEY = "maia3.session.v1";
let lastSavedSession = "";
let sessionReady = false; // saving before the restore finishes would overwrite what is being restored

function activeTabName() {
  const btn = document.querySelector(".tabBtn.active");
  return btn ? btn.dataset.tab : "play";
}

function snapshotSession() {
  const live = gameStarted && !isGameOver();
  return {
    tab: activeTabName(),
    settings: {
      side: selectedSide(),
      elo: els.eloSlider.value,
      temperature: els.temperatureSlider.value,
      topP: els.topPSlider.value,
      opening: els.openingCheckbox.checked,
    },
    play: live ? {
      startFen,
      playerColor,
      flipped,
      model: activeModelStore.get(),
      plies: posHistory.slice(1).map((p) => ({ fen: p.fen, lastMove: p.lastMove })),
    } : null,
    analyze: loadedGame ? {
      game: loadedGame,
      pgn: az.pgnInput.value,
      side: az.sideSelect.value,
      depthSelect: az.depthSelect.value,
      practiceSide: az.practiceSideSelect.value,
      analysis,
      depth: analysisDepth,
      viewPly: azViewPly,
      flipped: azFlipped,
      puzzle: puzzleMode ? { index: puzzleIndex, solved: puzzleSolved } : null,
    } : null,
  };
}

function saveSession() {
  if (!sessionReady) return;
  try {
    const json = JSON.stringify(snapshotSession());
    if (json === lastSavedSession) return;
    localStorage.setItem(SESSION_KEY, json);
    lastSavedSession = json;
  } catch {}
}

function pieceAtSquare(fen, sq) {
  const rows = fen.split(" ")[0].split("/");
  const row = rows[8 - Number(sq[1])];
  let file = 0;
  for (const c of row) {
    if (/\d/.test(c)) file += Number(c);
    else { if (file === sq.charCodeAt(0) - 97) return c; file += 1; }
  }
  return null;
}

// The saved list only has from/to squares, so a promotion piece is read off the position after the move.
function promotionFor(prevFen, ply) {
  const [from, to] = ply.lastMove;
  const mover = pieceAtSquare(prevFen, from);
  if (!mover || mover.toLowerCase() !== "p" || (to[1] !== "8" && to[1] !== "1")) return null;
  const promoted = pieceAtSquare(ply.fen, to);
  return promoted ? promoted.toLowerCase() : null;
}

async function restorePlay(p) {
  const model = p.model;
  if (!model || !activeModelReady) return;
  state = await invoke("new_game", { fen: p.startFen === STANDARD_FEN ? null : p.startFen });
  startFen = p.startFen;
  posHistory = [{ fen: state.fen, lastMove: null }];
  let prevFen = state.fen;
  for (const ply of p.plies) {
    state = await invoke("make_move", {
      from: ply.lastMove[0], to: ply.lastMove[1], promotion: promotionFor(prevFen, ply),
    });
    posHistory.push({ fen: state.fen, lastMove: state.lastMove });
    prevFen = ply.fen;
  }
  viewPly = posHistory.length - 1;
  playerColor = p.playerColor;
  flipped = p.flipped;
  if (isGameOver()) { renderPlayBoard(); renderMoveList(); return; }

  const elo = parseInt(els.eloSlider.value, 10);
  await invoke("start_engine", {
    command: model,
    elo,
    extraArgs: [
      "--temperature", els.temperatureSlider.value,
      "--top-p", els.topPSlider.value,
      "--opening-moves", String(posHistory.length > 8 || !els.openingCheckbox.checked ? 0 : 4),
      "--seed", String((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0),
    ],
  });
  gameStarted = true;
  els.setupSummary.textContent = `${playerColor === "white" ? "White" : "Black"} · ${elo} · ${modelLabel(model)}`;
  els.movesMeta.textContent = `You (${playerColor}) vs Maia-3 · ${elo} Elo`;
  els.setupPanel.classList.add("collapsed");
  els.eloLiveHint.style.display = "";
  renderPlayBoard();
  renderMoveList();
  setStatus(statusBanner());
  syncStartButton();
  if (state.turn !== playerColor) await triggerEngineMove();
}

function restoreAnalyze(a) {
  az.pgnInput.value = a.pgn || "";
  loadAnalysisGame(a.game);
  az.sideSelect.value = a.side;
  az.depthSelect.value = a.depthSelect;
  az.practiceSideSelect.value = a.practiceSide;
  if (a.analysis) {
    analysis = a.analysis;
    analysisDepth = a.depth;
    az.analyzeStatus.textContent = `Analyzed ${analysis.length} moves.`;
    renderAnalyzeMoveList();
    renderFlaggedList();
    az.moveListPanel.style.display = "block";
    az.flaggedPanel.style.display = "block";
    az.controlsPanel.classList.add("collapsed");
  }
  azViewPly = Math.max(0, Math.min(a.viewPly, a.game.sans.length));
  azFlipped = a.flipped;
  drawEvalGraph();
  renderAnalyzeBoard();
  if (a.puzzle && analysis && puzzles.length > 0) {
    enterPuzzleMode();
    puzzleIndex = Math.min(a.puzzle.index, puzzles.length - 1);
    puzzleSolved = a.puzzle.solved;
    loadPuzzle();
  }
}

async function restoreSession() {
  let s;
  try { s = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { s = null; }
  if (!s) { sessionReady = true; return; }
  lastSavedSession = JSON.stringify(s);
  try {
    const st = s.settings || {};
    if (st.elo) { els.eloSlider.value = st.elo; els.eloValue.textContent = st.elo; }
    if (st.temperature) { els.temperatureSlider.value = st.temperature; els.temperatureSlider.dispatchEvent(new Event("input")); }
    if (st.topP) { els.topPSlider.value = st.topP; els.topPSlider.dispatchEvent(new Event("input")); }
    if (typeof st.opening === "boolean") els.openingCheckbox.checked = st.opening;
    if (st.side) els.sideSelect.querySelector(`button[data-value="${st.side}"]`)?.click();
    if (s.analyze) restoreAnalyze(s.analyze);
    if (s.tab) switchTab(s.tab);
    await refreshActiveModelUI();
    if (s.play) await restorePlay(s.play);
  } catch (err) {
    setStatus(`Could not restore the last session: ${err}`);
  }
  sessionReady = true;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    saveSession();
    invoke("suspend_engines").catch(() => {});
  } else if (gameStarted && !isGameOver()) {
    invoke("resume_engines").catch(() => {});
  }
});
window.addEventListener("pagehide", saveSession);
setInterval(saveSession, 5000);
restoreSession();
