function azFenAt(ply) {
  if (!loadedGame) return STANDARD_FEN;
  return ply === 0 ? loadedGame.startFen : loadedGame.fens[ply - 1];
}
function azLastMoveAt(ply) {
  if (!analysis || ply === 0) return null;
  const m = analysis[ply - 1];
  if (!m || !m.uci) return null;
  return [m.uci.slice(0, 2), m.uci.slice(2, 4)];
}

function analysisArrowsAt(ply) {
  const arrows = [];
  if (!analysis || !az.arrowToggle.checked) return arrows;
  const m = analysis[ply];
  if (!m) return arrows;
  const played = uciToSquares(m.uci);
  if (played && !isPositiveGrade(m.grade)) arrows.push({ from: played[0], to: played[1], brush: "red", opacity: 0.7 });
  const best = uciToSquares(m.bestMoveUci);
  if (best) arrows.push({ from: best[0], to: best[1], brush: "blue" });
  return arrows;
}

function azBadgeAt(ply) {
  if (!analysis || ply === 0) return null;
  const m = analysis[ply - 1];
  const sq = m && m.uci ? m.uci.slice(2, 4) : null;
  return sq ? { square: sq, grade: m.grade } : null;
}

function fenKey(fen) { return fen.split(" ").slice(0, 4).join(" "); }

// Blue for the engine; purple belongs to the human-insight arrows.
const ENG_ARROW_OPACITY = [0.85, 0.55, 0.35];
function engineArrow(fen) {
  if (!eng.enable.checked || !eng.arrows.checked || !az.arrowToggle.checked) return [];
  if (puzzleMode && !puzzleLocked) return [];
  if (!engLive || engLive.key !== fenKey(fen)) return [];
  const out = [];
  engLive.lines.forEach((line, i) => {
    const sq = uciToSquares(line.ucis && line.ucis[0]);
    if (sq && !out.some((x) => x.from === sq[0] && x.to === sq[1])) {
      out.push({ from: sq[0], to: sq[1], brush: "blue", opacity: ENG_ARROW_OPACITY[i] ?? 0.3 });
    }
  });
  return out;
}

function analyzeView() {
  if (variation) {
    // idx 0 previews the first move; after that the arrow marks the move just played
    const sq = uciToSquares(variation.idx > 0 ? variation.ucis[variation.idx - 1] : variation.ucis[0]);
    const fen = variation.fens[variation.idx];
    return {
      fen,
      lastMove: variation.idx > 0 ? sq : null,
      arrows: variation.free
        ? engineArrow(fen)
        : sq && az.arrowToggle.checked ? [{ from: sq[0], to: sq[1], brush: "blue" }] : [],
      badge: null,
    };
  }
  const fen = azFenAt(azViewPly);
  const arrows = analysisArrowsAt(azViewPly).concat(hiArrowsAt(azViewPly));
  for (const a of engineArrow(fen)) {
    if (!arrows.some((x) => x.from === a.from && x.to === a.to)) arrows.push(a);
  }
  return {
    fen,
    lastMove: azLastMoveAt(azViewPly),
    arrows,
    badge: azBadgeAt(azViewPly),
  };
}

function renderAnalyzeBoard() {
  const view = analyzeView();
  renderMaterialBars(az.materialTop, az.materialBottom, view.fen, azFlipped);
  if (azSelFen !== view.fen) { azSelected = null; azTargets = []; }
  const mover = sideToMove(view.fen);
  renderChessBoard(az.board, view.fen, {
    interactive: true,
    flipped: azFlipped,
    lastMove: view.lastMove,
    arrows: view.arrows,
    badge: view.badge,
    selected: azSelected,
    legalTargets: azTargets,
    canDrag: (piece) => isPieceOfColor(piece, mover),
    onGrab: onAzSquareClick,
    onSquareClick: onAzSquareClick,
    onDeselect: () => { azSelected = null; azTargets = []; renderAnalyzeBoard(); },
    onDropMove: (from, to) => {
      if (azSelected === from && azTargets.length > 0 && !azTargets.includes(to)) {
        renderAnalyzeBoard();
        return;
      }
      azSelected = null;
      azTargets = [];
      attemptAzMove(from, to);
    },
  });

  let atStart, atEnd;
  if (variation) {
    atStart = variation.idx === 0;
    atEnd = variation.idx >= variation.fens.length - 1;
  } else {
    const maxPly = loadedGame ? loadedGame.sans.length : 0;
    atStart = azViewPly === 0;
    atEnd = azViewPly >= maxPly;
  }
  az.navStart.disabled = atStart;
  az.navPrev.disabled = atStart;
  az.navNext.disabled = atEnd;
  az.navEnd.disabled = atEnd;
  setBoardNav(atStart, atEnd);
  az.variationBar.style.display = variation ? "flex" : "none";
  syncLineHighlights();
  highlightCurrentMove();
  drawEvalGraph();
  hiRefresh();
  engRefresh();
}

function azGo(where) {
  if (puzzleMode) return;
  if (variation) {
    const last = variation.fens.length - 1;
    if (where === "start") variation.idx = 0;
    else if (where === "end") variation.idx = last;
    else variation.idx = Math.max(0, Math.min(last, variation.idx + (where === "prev" ? -1 : 1)));
  } else {
    const maxPly = loadedGame ? loadedGame.sans.length : 0;
    if (where === "start") azViewPly = 0;
    else if (where === "end") azViewPly = maxPly;
    else azViewPly = Math.max(0, Math.min(maxPly, azViewPly + (where === "prev" ? -1 : 1)));
  }
  renderAnalyzeBoard();
}
az.navStart.addEventListener("click", () => azGo("start"));
az.navPrev.addEventListener("click", () => azGo("prev"));
az.navNext.addEventListener("click", () => azGo("next"));
az.navEnd.addEventListener("click", () => azGo("end"));

function azGoToPly(ply) {
  if (puzzleMode) return;
  variation = null;
  azViewPly = ply;
  renderAnalyzeBoard();
}

async function onAzSquareClick(sq) {
  if (puzzleMode) return;
  const fen = analyzeView().fen;
  const mover = sideToMove(fen);
  const isOwn = isPieceOfColor(fenToBoard(fen)[sq], mover);

  if (azSelected && azTargets.includes(sq)) {
    const from = azSelected;
    azSelected = null;
    azTargets = [];
    await attemptAzMove(from, sq);
    return;
  }
  if (isOwn) {
    if (azSelected === sq) return;
    azSelected = sq;
    azTargets = [];
    azSelFen = fen;
    renderAnalyzeBoard();
    let targets = [];
    try { targets = await invoke("scratch_legal_targets", { fen, square: sq }); } catch { targets = []; }
    if (azSelected !== sq || analyzeView().fen !== fen) return;
    azTargets = targets;
    renderAnalyzeBoard();
    return;
  }
  azSelected = null;
  azTargets = [];
  renderAnalyzeBoard();
}

async function attemptAzMove(from, to) {
  const fen = analyzeView().fen;
  let promotion = null;
  if (needsPromotionMove(fen, from, to)) {
    promotion = await askPromotion(az.promo, sideToMove(fen) === "white" ? "w" : "b");
    if (!promotion) { renderAnalyzeBoard(); return; }
  }
  let result;
  try {
    result = await invoke("scratch_try_move", { fen, from, to, promotion });
  } catch {
    renderAnalyzeBoard();
    return;
  }
  if (analyzeView().fen !== fen) return;
  playFreeMove(fen, result);
}

function setFreeVariation(v) {
  v.free = true;
  v.ply = -1;
  v.m = { fenBefore: v.fens[0], bestLineSan: v.sans };
  variation = v;
  az.variationTitle.textContent = "Your line — move a piece to branch off";
  renderLineChips(az.variationLine, v.m, (n) => { v.idx = n; renderAnalyzeBoard(); });
  renderAnalyzeBoard();
}

function playFreeMove(fen, mv) {
  let v;
  if (!variation) {
    v = { fens: [fen], ucis: [], sans: [], idx: 0 };
  } else {
    // an engine-line preview becomes the user's own line from the current point
    const sans = variation.sans || (variation.m && variation.m.bestLineSan) || [];
    v = {
      fens: variation.fens.slice(0, variation.idx + 1),
      ucis: variation.ucis.slice(0, variation.idx),
      sans: sans.slice(0, variation.idx),
      idx: variation.idx,
    };
    // playing the move already on the board just steps forward
    if (variation.ucis[variation.idx] === mv.uci) {
      v = { fens: variation.fens.slice(), ucis: variation.ucis.slice(), sans: sans.slice(), idx: variation.idx + 1 };
      setFreeVariation(v);
      return;
    }
  }
  v.fens.push(mv.fen);
  v.ucis.push(mv.uci);
  v.sans.push(mv.san);
  v.idx = v.fens.length - 1;
  setFreeVariation(v);
}

function startEngineLine(fen, line, n) {
  setFreeVariation({ fens: [fen].concat(line.fens), ucis: line.ucis.slice(), sans: line.sans.slice(), idx: n });
}

function formatEngineEval(line) {
  if (line.mate !== null && line.mate !== undefined) return line.mate === 0 ? "#" : `#${line.mate}`;
  const pawns = (line.scoreCp || 0) / 100;
  return (pawns > 0 ? "+" : "") + pawns.toFixed(2);
}

function engineSideAhead(line) {
  if (line.mate !== null && line.mate !== undefined) return line.mate >= 0 ? "white" : "black";
  return (line.scoreCp || 0) >= 0 ? "white" : "black";
}

// Share of the bar given to White, using the same curve as the grading.
function engineWhiteShare(line) {
  if (line.mate !== null && line.mate !== undefined) return line.mate >= 0 ? 100 : 0;
  return 100 / (1 + Math.exp(-0.004 * (line.scoreCp || 0)));
}

// The position the board is showing right now, in analysis or practice mode.
function engPosition() {
  if (!puzzleMode) return analyzeView().fen;
  return puzzleCurFen();
}

function redrawBoardForEngine() {
  if (puzzleMode) renderPuzzleBoard(sideToMove(puzzleFen) === "black");
  else renderAnalyzeBoard();
}

function engMessage(text) {
  eng.note.textContent = text;
}

function renderEngineLines(fen, lines) {
  eng.list.textContent = "";
  lines.forEach((line) => {
    const row = document.createElement("div");
    row.className = "engLine";
    const chip = document.createElement("span");
    chip.className = `engChip ${engineSideAhead(line)}`;
    chip.textContent = formatEngineEval(line);
    const moves = document.createElement("span");
    moves.className = "lineMoves";
    renderLineChips(moves, { fenBefore: fen, bestLineSan: line.sans }, (n) => {
      if (puzzleMode) startPuzzleEngineLine(line, n);
      else startEngineLine(fen, line, n);
    });
    row.appendChild(chip);
    row.appendChild(moves);
    eng.list.appendChild(row);
  });

  const top = lines[0];
  eng.score.textContent = formatEngineEval(top);
  eng.score.className = `engChip engScore ${engineSideAhead(top)}`;
  eng.barFill.style.width = `${engineWhiteShare(top).toFixed(1)}%`;
}

function engSetStatus(depth, searching) {
  eng.status.textContent = searching ? `depth ${depth}…` : `depth ${depth}`;
  eng.body.classList.toggle("busy", searching);
}

async function engRefresh() {
  if (!eng.enable.checked) {
    engToken++;
    engKey = null;
    engLive = null;
    eng.body.style.display = "none";
    engMessage("");
    return;
  }
  if (puzzleMode && !puzzleLocked) {
    // keeps the answer hidden until the puzzle is solved or revealed
    engToken++;
    engKey = null;
    engLive = null;
    eng.body.style.display = "none";
    engMessage("The engine unlocks once you solve the puzzle or reveal the answer.");
    return;
  }
  if (analyzingGame) {
    engToken++;
    engKey = null;
    engMessage("Waiting for the game analysis to finish…");
    return;
  }

  const fen = engPosition();
  const target = ENG_DEPTH;
  const count = parseInt(eng.lines.value, 10);
  const key = `${fenKey(fen)}|${target}|${count}`;
  if (key === engKey) return;
  engKey = key;
  const token = ++engToken;

  const cached = engCache.get(key);
  if (cached) {
    engLive = { key: fenKey(fen), lines: cached };
    showEngineResult(fen, cached, target, target, token);
    return;
  }

  const seed = engSeed.get(fenKey(fen));
  if (seed && seed.depth >= target && seed.lines.length >= count) {
    engCache.set(key, seed.lines);
    engLive = { key: fenKey(fen), lines: seed.lines };
    showEngineResult(fen, seed.lines, target, target, token);
    return;
  }
  if (seed) {
    engLive = { key: fenKey(fen), lines: seed.lines };
    showEngineResult(fen, seed.lines, seed.depth, target, token);
  } else if (eng.body.style.display === "none") engMessage("Thinking…");
  else eng.body.classList.add("busy");
  await new Promise((r) => setTimeout(r, ENG_DEBOUNCE_MS));
  if (token !== engToken) return;

  if (!(await ensureStockfish())) {
    if (token === engToken) engMessage(az.analyzeStatus.textContent);
    return;
  }

  const depths = target > 10 && !(seed && seed.depth >= 10) ? [10, target] : [target];
  for (const depth of depths) {
    if (token !== engToken) return;
    let lines;
    try {
      lines = await invoke("engine_lines", { fen, depth, multipv: count });
    } catch (err) {
      if (token === engToken) {
        eng.body.style.display = "none";
        engMessage("Engine failed: " + err);
      }
      return;
    }
    if (token !== engToken) return;
    engLive = { key: fenKey(fen), lines };
    if (depth === target) engCache.set(key, lines);
    lines.forEach((l) => engSeedLine(fen, l, depth));
    showEngineResult(fen, lines, depth, target, token);
  }
}

function showEngineResult(fen, lines, depth, target, token) {
  if (token !== engToken) return;
  if (!lines.length || !lines[0].ucis.length) {
    eng.body.style.display = "none";
    engMessage("No moves to analyze here — the game is over.");
    return;
  }
  engMessage("");
  eng.body.style.display = "block";
  renderEngineLines(fen, lines);
  engSetStatus(depth, depth < target);
  // arrows depend on the result; the key guard stops this from restarting the search
  redrawBoardForEngine();
}

eng.enable.addEventListener("change", () => { engKey = null; engRefresh(); if (!eng.enable.checked) redrawBoardForEngine(); });
eng.lines.addEventListener("change", () => { engKey = null; engRefresh(); });
eng.arrows.addEventListener("change", redrawBoardForEngine);

az.arrowToggle.addEventListener("change", () => { if (!puzzleMode) renderAnalyzeBoard(); });
az.variationExitBtn.addEventListener("click", () => { variation = null; renderAnalyzeBoard(); });

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (!document.getElementById("analyzeTab").classList.contains("active")) return;
  if (e.target.closest && e.target.closest("input, textarea, select, summary")) return;

  const navTargets = { ArrowLeft: "prev", ArrowRight: "next", Home: "start", End: "end" };
  if (e.key in navTargets) {
    e.preventDefault();
    if (puzzleMode) goPuzzleLine(navTargets[e.key]);
    else azGo(navTargets[e.key]);
    return;
  }
  if (e.key === "Escape") {
    if (variation) {
      e.preventDefault();
      variation = null;
      renderAnalyzeBoard();
    } else if (puzzleMode) {
      e.preventDefault();
      exitPuzzleMode();
    }
    return;
  }
  if (e.key.toLowerCase() === "f" && !puzzleMode) {
    e.preventDefault();
    az.flipBtn.click();
  }
});

// onPick(n): n = moves played from the start of the line
function renderLineChips(container, entry, onPick) {
  container.textContent = "";
  const parts = entry.fenBefore.split(" ");
  let white = parts[1] !== "b";
  let num = parseInt(parts[5], 10) || 1;
  (entry.bestLineSan || []).forEach((san, i) => {
    if (white || i === 0) {
      const n = document.createElement("span");
      n.className = "lineNum";
      n.textContent = white ? `${num}.` : `${num}...`;
      container.appendChild(n);
    }
    const chip = document.createElement("span");
    chip.className = "lineMove";
    chip.dataset.idx = String(i + 1);
    chip.textContent = san;
    chip.title = "Show this position on the board";
    chip.addEventListener("click", (e) => { e.stopPropagation(); onPick(i + 1); });
    container.appendChild(chip);
    if (!white) num += 1;
    white = !white;
  });
}

function setActiveChip(container, idx) {
  container.querySelectorAll(".lineMove[data-idx]").forEach((c) => {
    c.classList.toggle("active", c.dataset.idx === String(idx));
  });
}

function hasClickableLine(m) {
  return !!(m && m.bestLineFens && m.bestLineFens.length && m.bestLineUci && m.bestLineUci.length);
}

function startVariation(i, idx) {
  if (puzzleMode || !analysis) return;
  const m = analysis[i];
  if (!hasClickableLine(m)) return;
  variation = {
    ply: i,
    m,
    fens: [m.fenBefore].concat(m.bestLineFens),
    ucis: m.bestLineUci,
    idx: Math.max(0, Math.min(idx, m.bestLineFens.length)),
  };
  azViewPly = i; // exiting the variation returns to where it branched off

  const mover = sideToMove(m.fenBefore);
  const num = Math.floor(i / 2) + 1;
  az.variationTitle.textContent = `Engine line instead of ${mover === "white" ? `${num}.` : `${num}...`} ${m.san}`;
  renderLineChips(az.variationLine, m, (n) => { variation.idx = n; renderAnalyzeBoard(); });
  renderAnalyzeBoard();
}

function syncLineHighlights() {
  az.flaggedList.querySelectorAll(".lineMoves").forEach((box) => {
    setActiveChip(box, variation && String(variation.ply) === box.dataset.ply ? variation.idx : -1);
  });
  if (variation) setActiveChip(az.variationLine, variation.idx);
}

// Puzzle mode orients itself to the side to move, so flipping only shows once you leave it.
az.flipBtn.addEventListener("click", () => {
  azFlipped = !azFlipped;
  if (!puzzleMode) renderAnalyzeBoard();
});

function orientAnalyzeBoardForSide() {
  const side = az.sideSelect.value;
  if (side === "white") azFlipped = false;
  else if (side === "black") azFlipped = true;
}

function loadAnalysisGame(game) {
  loadedGame = game;
  hiResetForGame();
  analysis = null;
  variation = null;
  gradeFilter = null;
  // Games sent from the Play tab know which side the person played; a pasted PGN doesn't, so leave "Both" then.
  az.practiceSideSelect.value = game.myColor === "white" || game.myColor === "black" ? game.myColor : "both";
  azViewPly = game.sans.length;
  az.analyzeBtn.disabled = game.sans.length === 0;
  az.moveListPanel.style.display = "none";
  az.flaggedPanel.style.display = "none";
  az.loadPanel.classList.add("collapsed");
  az.controlsPanel.classList.remove("collapsed");
  az.analyzeStatus.textContent = `Loaded ${game.sans.length} ply. Click "Analyze Game" to grade it.`;
  azFlipped = game.myColor === "white" || game.myColor === "black" ? game.myColor === "black" : az.sideSelect.value === "black";
  renderAnalyzeBoard();
  drawEvalGraph();
  exitPuzzleMode();
}

[az.loadPanel, az.controlsPanel].forEach((panel) => {
  panel.querySelector("h2").addEventListener("click", () => panel.classList.toggle("collapsed"));
});

az.loadBtn.addEventListener("click", async () => {
  az.loadError.textContent = "";
  const text = az.pgnInput.value.trim();
  if (!text) { az.loadError.textContent = "Paste a PGN first."; return; }
  try {
    const parsed = await invoke("parse_pgn", { pgnText: text });
    loadAnalysisGame({ startFen: parsed.startFen, sans: parsed.sans, fens: parsed.fens, ucis: parsed.ucis });
  } catch (err) {
    az.loadError.textContent = String(err);
  }
});

async function ensureStockfish() {
  if (stockfishStarted) return true;
  try {
    if (!(await invoke("stockfish_running"))) await invoke("start_stockfish");
    stockfishStarted = true;
    return true;
  } catch (err) {
    az.analyzeStatus.textContent = "Stockfish isn't available: " + err;
    return false;
  }
}

az.analyzeBtn.addEventListener("click", async () => {
  if (!loadedGame || loadedGame.sans.length === 0) return;
  az.analyzeBtn.disabled = true;
  az.analyzeStatus.textContent = "Checking Stockfish…";
  const ok = await ensureStockfish();
  if (!ok) { az.analyzeBtn.disabled = false; return; }

  az.analyzeStatus.textContent = "Analyzing… this can take a while at higher depth.";
  analyzingGame = true;
  engRefresh();
  const analysisDepthUsed = parseInt(az.depthSelect.value, 10);
  try {
    analysis = await invoke("analyze_moves", {
      sans: loadedGame.sans,
      startFen: loadedGame.startFen,
      depth: analysisDepthUsed,
      multipv: 5,
    });
    analysisDepth = analysisDepthUsed;
    az.analyzeStatus.textContent = `Analyzed ${analysis.length} moves.`;
    renderAnalyzeMoveList();
    renderFlaggedList();
    drawEvalGraph();
    az.moveListPanel.style.display = "block";
    az.flaggedPanel.style.display = "block";
    az.controlsPanel.classList.add("collapsed");
  } catch (err) {
    az.analyzeStatus.textContent = "Analysis failed: " + err;
  } finally {
    analyzingGame = false;
    az.analyzeBtn.disabled = false;
    engRefresh();
  }
});

function gradeClass(grade) { return "grade-" + grade; }
// no "better move" hint for either — both are already the top choice
function isPositiveGrade(grade) { return ["good", "best", "onlymove", "brilliant"].includes(grade); }

function renderAnalyzeMoveList() {
  az.moveList.innerHTML = "";
  const side = az.sideSelect.value;
  for (let i = 0; i < analysis.length; i++) {
    const m = analysis[i];
    const mover = sideToMove(m.fenBefore);
    if (side !== "both" && side !== mover) continue;

    const row = document.createElement("div");
    row.className = "aMove";
    row.dataset.ply = String(i + 1);
    const num = Math.floor(i / 2) + 1;
    const label = (i % 2 === 0) ? `${num}.` : `${num}...`;
    const left = document.createElement("span");
    const chip = document.createElement("span");
    chip.className = `gradeChip ${gradeClass(m.grade)}`;
    left.append(chip, `${label} ${m.san}`);
    const right = document.createElement("span");
    right.className = gradeClass(m.grade);
    right.textContent = EVAL_GRADE_NAME[m.grade] ?? m.grade;
    row.appendChild(left);
    row.appendChild(right);
    row.addEventListener("click", () => azGoToPly(i + 1));
    az.moveList.appendChild(row);
  }
  if (!az.moveList.children.length) {
    az.moveList.innerHTML = '<div class="emptyHint">No moves for this side.</div>';
  }
}
az.sideSelect.addEventListener("change", () => {
  orientAnalyzeBoardForSide();
  if (analysis) renderAnalyzeMoveList();
  if (!puzzleMode) renderAnalyzeBoard();
});

function highlightCurrentMove() {
  az.moveList.querySelectorAll(".aMove").forEach((row) => {
    row.classList.toggle("current", !variation && row.dataset.ply === String(azViewPly));
  });
}

az.flaggedHeading.addEventListener("click", () => az.flaggedPanel.classList.toggle("listCollapsed"));

function renderFlaggedList() {
  az.flaggedList.innerHTML = "";
  const flagged = analysis
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.grade === "mistake" || m.grade === "blunder");
  // folded by default; the practice button below it stays visible
  az.flaggedPanel.classList.add("listCollapsed");
  az.flaggedCount.textContent = flagged.length ? `(${flagged.length})` : "";

  if (flagged.length === 0) {
    az.flaggedList.innerHTML = '<div class="emptyHint">No mistakes or blunders flagged — nice game!</div>';
    az.practiceBtn.style.display = "none";
    az.practiceSideRow.style.display = "none";
    return;
  }

  for (const { m, i } of flagged) {
    const num = Math.floor(i / 2) + 1;
    const mover = sideToMove(m.fenBefore);
    const label = mover === "white" ? `${num}.` : `${num}...`;
    const clickable = hasClickableLine(m);
    const div = document.createElement("div");
    div.className = "flaggedItem";

    const head = document.createElement("div");
    head.className = "head";
    const tag = document.createElement("span");
    tag.className = `sideTag ${mover}`;
    tag.textContent = mover === "white" ? "White" : "Black";
    const moveText = document.createElement("span");
    moveText.className = gradeClass(m.grade);
    moveText.textContent = `${label} ${m.san} (${m.grade})`;
    head.append(tag, " ", moveText);
    div.appendChild(head);

    const better = document.createElement("div");
    if (m.bestMoveSan) {
      better.appendChild(document.createTextNode("— better was "));
      const b = document.createElement(clickable ? "span" : "b");
      b.textContent = m.bestMoveSan;
      if (clickable) {
        b.className = "lineMove bestMove";
        b.title = "Show the better move on the board";
        b.addEventListener("click", (e) => { e.stopPropagation(); startVariation(i, 1); });
      }
      better.appendChild(b);
    }
    div.appendChild(better);

    if (m.bestLineSan && m.bestLineSan.length) {
      const line = document.createElement("div");
      line.className = "line lineMoves";
      line.dataset.ply = String(i);
      if (clickable) renderLineChips(line, m, (n) => startVariation(i, n));
      else line.textContent = m.bestLineSan.join(" ");
      div.appendChild(line);
    }

    div.addEventListener("click", () => azGoToPly(i + 1));
    az.flaggedList.appendChild(div);
  }

  updatePracticeControls();
}

let allPuzzles = [];
let puzzles = [];
function updatePracticeControls() {
  allPuzzles = analysis
    .filter((m) => (m.grade === "mistake" || m.grade === "blunder") && m.bestMoveUci);
  const side = az.practiceSideSelect.value;
  puzzles = allPuzzles.filter((m) => side === "both" || sideToMove(m.fenBefore) === side);
  if (allPuzzles.length === 0) {
    az.practiceSideRow.style.display = "none";
    az.practiceBtn.style.display = "none";
    return;
  }
  az.practiceSideRow.style.display = "flex";
  az.practiceBtn.style.display = "inline-block";
  az.practiceBtn.disabled = puzzles.length === 0;
  az.practiceBtn.textContent = puzzles.length > 0
    ? `Practice My Mistakes (${puzzles.length}) →` : "No mistakes for this side";
}
az.practiceSideSelect.addEventListener("change", () => {
  updatePracticeControls();
  if (!puzzleMode) return;
  if (puzzles.length > 0) enterPuzzleMode(); else exitPuzzleMode();
});
az.practiceBtn.addEventListener("click", () => enterPuzzleMode());
