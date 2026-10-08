let puzzleMode = false;
let puzzleIndex = 0;
let puzzleHomeIndex = 0;
let puzzleSolved = 0;
let puzzleLocked = false;
let puzzleFen = null;
let puzzleSelected = null;
let puzzleLegalTargets = [];
let puzzleViewIdx = 0;
// Line explored after solving: starts as the solution, branches when you move a piece.
let puzzleExp = null;

function puzzleCurFen() {
  return puzzleLocked && puzzleExp ? puzzleExp.fens[puzzleViewIdx] : puzzleFen;
}

function lockPuzzle(puzzle) {
  puzzleLocked = true;
  puzzleSelected = null;
  puzzleLegalTargets = [];
  puzzleViewIdx = 0;
  const clickable = hasClickableLine(puzzle);
  if (analysisDepth && puzzle && puzzle.bestLineUci && puzzle.bestLineUci.length &&
      (puzzle.evalBeforeCp !== null && puzzle.evalBeforeCp !== undefined)) {
    engSeedLine(puzzleFen, {
      scoreCp: puzzle.evalBeforeCp, mate: puzzle.mateBefore ?? null,
      sans: puzzle.bestLineSan || [], ucis: puzzle.bestLineUci, fens: puzzle.bestLineFens || [],
    }, analysisDepth);
  }
  puzzleExp = {
    fens: [puzzleFen].concat(clickable ? puzzle.bestLineFens : []),
    ucis: clickable ? puzzle.bestLineUci.slice() : [],
    sans: clickable ? (puzzle.bestLineSan || []).slice() : [],
  };
}

function refreshPuzzleChips() {
  const moves = az.puzzleFeedback.querySelector(".puzzleLine .lineMoves");
  if (!moves || !puzzleExp) return;
  renderLineChips(moves, { fenBefore: puzzleFen, bestLineSan: puzzleExp.sans }, (n) => {
    puzzleViewIdx = n;
    renderPuzzleBoard(sideToMove(puzzleFen) === "black");
  });
  setActiveChip(moves, puzzleViewIdx);
}

function playPuzzleFreeMove(mv) {
  const e = puzzleExp, i = puzzleViewIdx;
  if (e.ucis[i] !== mv.uci) {
    e.fens = e.fens.slice(0, i + 1).concat(mv.fen);
    e.ucis = e.ucis.slice(0, i).concat(mv.uci);
    e.sans = e.sans.slice(0, i).concat(mv.san);
  }
  puzzleViewIdx = i + 1;
  refreshPuzzleChips();
  renderPuzzleBoard(sideToMove(puzzleFen) === "black");
}

function startPuzzleEngineLine(line, n) {
  const e = puzzleExp, i = puzzleViewIdx;
  e.fens = e.fens.slice(0, i + 1).concat(line.fens);
  e.ucis = e.ucis.slice(0, i).concat(line.ucis);
  e.sans = e.sans.slice(0, i).concat(line.sans);
  puzzleViewIdx = i + n;
  refreshPuzzleChips();
  renderPuzzleBoard(sideToMove(puzzleFen) === "black");
}

function isAcceptable(puzzle, uci) {
  if (Array.isArray(puzzle.acceptableMoves) && puzzle.acceptableMoves.length > 0) {
    return puzzle.acceptableMoves.includes(uci);
  }
  return uci === puzzle.bestMoveUci;
}

function enterPuzzleMode() {
  if (puzzles.length === 0) return;
  puzzleMode = true;
  variation = null;
  az.variationBar.style.display = "none";
  // A refresh still running from the analysis view would repaint the board over the puzzle.
  hiToken++;
  hi.body.style.display = "none";
  hi.status.textContent = "";
  puzzleIndex = 0;
  puzzleSolved = 0;
  az.puzzlePanel.classList.add("show");
  document.getElementById("analyzeTab").classList.add("practicing");
  if (az.puzzlePanel.scrollIntoView) az.puzzlePanel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  loadPuzzle();
}

function loadPuzzle(browsing = false) {
  if (!browsing) puzzleHomeIndex = puzzleIndex;
  az.puzzleBackBtn.style.display = puzzleIndex === puzzleHomeIndex ? "none" : "";
  const puzzle = puzzles[puzzleIndex];
  puzzleFen = puzzle.fenBefore;
  puzzleSelected = null;
  puzzleLegalTargets = [];
  puzzleLocked = false;
  puzzleExp = null;
  puzzleViewIdx = 0;
  az.puzzleFeedback.className = "";
  az.puzzleFeedback.textContent = "";
  az.puzzleRevealBtn.style.display = "";
  az.puzzleNextBtn.style.display = "none";
  az.puzzleActiveActions.style.display = "flex";
  az.puzzleDoneActions.style.display = "none";
  const mover = sideToMove(puzzleFen);
  az.puzzleProgress.textContent = `Puzzle ${puzzleIndex + 1} / ${puzzles.length} — solved ${puzzleSolved}`;
  az.puzzlePrompt.innerHTML = `Find the best move for <b>${mover}</b>.`;
  renderPuzzleBoard(mover === "black");
  drawEvalGraph();
}

function renderPuzzleBoard(flip) {
  const puzzle = puzzles[puzzleIndex];
  let fen = puzzleFen, lastMove = null, arrows = [];
  if (puzzleLocked && puzzle && puzzleExp) {
    const idx = puzzleViewIdx;
    fen = puzzleExp.fens[idx];
    const sq = uciToSquares(idx > 0 ? puzzleExp.ucis[idx - 1] : puzzleExp.ucis[0]);
    if (idx > 0) lastMove = sq;
    if (sq) arrows = [{ from: sq[0], to: sq[1], brush: "blue" }];
    if (idx === 0 && hi.enable.checked && hi.arrows.checked) {
      arrows = hiArrowsFrom(hiData.get(`moves:${analysis.indexOf(puzzle)}:${hiRating()}`)).concat(arrows);
    }
  }
  for (const a of engineArrow(fen)) {
    if (!arrows.some((x) => x.from === a.from && x.to === a.to)) arrows.push(a);
  }
  syncPuzzleNav();
  renderMaterialBars(az.materialTop, az.materialBottom, fen, flip);
  renderChessBoard(az.board, fen, {
    flipped: flip,
    lastMove,
    arrows,
    selected: puzzleSelected,
    legalTargets: puzzleLegalTargets,
    interactive: true,
    canDrag: (piece) => isPieceOfColor(piece, sideToMove(puzzleCurFen())),
    onGrab: onPuzzleSquareClick,
    onDeselect: () => {
      puzzleSelected = null;
      puzzleLegalTargets = [];
      renderPuzzleBoard(sideToMove(puzzleFen) === "black");
    },
    onSquareClick: onPuzzleSquareClick,
    onDropMove: (from, to) => {
      if (puzzleSelected === from && puzzleLegalTargets.length > 0 && !puzzleLegalTargets.includes(to)) {
        renderPuzzleBoard(sideToMove(puzzleFen) === "black");
        return;
      }
      puzzleSelected = null;
      puzzleLegalTargets = [];
      attemptPuzzleMove(from, to);
    },
  });
  engRefresh();
}

async function onPuzzleSquareClick(sq) {
  const curFen = puzzleCurFen();
  const board = fenToBoard(curFen);
  const mover = sideToMove(curFen);
  const piece = board[sq];
  const isOwn = piece && ((mover === "white" && piece === piece.toUpperCase()) ||
                           (mover === "black" && piece === piece.toLowerCase()));

  if (puzzleSelected && puzzleLegalTargets.includes(sq)) {
    const from = puzzleSelected;
    puzzleSelected = null;
    puzzleLegalTargets = [];
    await attemptPuzzleMove(from, sq);
    return;
  }
  if (isOwn) {
    if (puzzleSelected === sq) return;
    puzzleSelected = sq;
    puzzleLegalTargets = [];
    renderPuzzleBoard(sideToMove(puzzleFen) === "black");
    const fenAtPress = curFen;
    let targets = [];
    try { targets = await invoke("scratch_legal_targets", { fen: curFen, square: sq }); } catch { targets = []; }
    if (puzzleSelected !== sq || puzzleCurFen() !== fenAtPress) return;
    puzzleLegalTargets = targets;
    renderPuzzleBoard(sideToMove(puzzleFen) === "black");
    return;
  }
  puzzleSelected = null;
  puzzleLegalTargets = [];
  renderPuzzleBoard(sideToMove(puzzleFen) === "black");
}

async function attemptPuzzleMove(from, to) {
  const puzzle = puzzles[puzzleIndex];
  const curFen = puzzleCurFen();
  let promotion = null;
  if (needsPromotionMove(curFen, from, to)) {
    const mover = sideToMove(curFen);
    promotion = await askPromotion(az.promo, mover === "white" ? "w" : "b");
    if (!promotion) { renderPuzzleBoard(sideToMove(puzzleFen) === "black"); return; }
  }
  let result;
  try {
    result = await invoke("scratch_try_move", { fen: curFen, from, to, promotion });
  } catch {
    renderPuzzleBoard(sideToMove(puzzleFen) === "black");
    return;
  }
  if (puzzleLocked) {
    if (puzzleCurFen() === curFen) playPuzzleFreeMove(result);
    return;
  }
  if (isAcceptable(puzzle, result.uci)) {
    handlePuzzleCorrect(puzzle);
  } else {
    az.puzzleFeedback.className = "show wrong";
    az.puzzleFeedback.textContent = "Not quite — try again.";
    renderPuzzleBoard(sideToMove(puzzleFen) === "black");
  }
}

function fillPuzzleFeedback(prefix, puzzle) {
  const box = az.puzzleFeedback;
  box.textContent = prefix;
  const line = document.createElement("div");
  line.className = "lineMoves puzzleLine";
  const label = document.createElement("span");
  label.className = "lineLabel";
  label.textContent = "Line:";
  const moves = document.createElement("span");
  moves.className = "lineMoves";
  line.append(label, moves);
  box.appendChild(line);
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = "Move pieces to explore other lines. Turn on the Engine panel to see what else was possible.";
  box.appendChild(hint);
  refreshPuzzleChips();
}

for (const btn of document.querySelectorAll("#boardNav .navBtn")) {
  btn.addEventListener("click", () => (puzzleMode ? goPuzzleLine(btn.dataset.nav) : azGo(btn.dataset.nav)));
}

function setBoardNav(atStart, atEnd) {
  const nav = document.getElementById("boardNav");
  nav.querySelector('[data-nav="start"]').disabled = atStart;
  nav.querySelector('[data-nav="prev"]').disabled = atStart;
  nav.querySelector('[data-nav="next"]').disabled = atEnd;
  nav.querySelector('[data-nav="end"]').disabled = atEnd;
}

function syncPuzzleNav() {
  const active = puzzleLocked && puzzleExp;
  setBoardNav(!active || puzzleViewIdx === 0, !active || puzzleViewIdx >= puzzleExp.ucis.length);
}

// same as azGo(), but for the solution line shown once a puzzle is solved/revealed
function goPuzzleLine(where) {
  const puzzle = puzzles[puzzleIndex];
  if (!puzzleLocked || !puzzleExp) return;
  const last = puzzleExp.ucis.length;
  if (where === "start") puzzleViewIdx = 0;
  else if (where === "end") puzzleViewIdx = last;
  else puzzleViewIdx = Math.max(0, Math.min(last, puzzleViewIdx + (where === "prev" ? -1 : 1)));
  const moves = az.puzzleFeedback.querySelector(".puzzleLine .lineMoves");
  if (moves) setActiveChip(moves, puzzleViewIdx);
  renderPuzzleBoard(sideToMove(puzzleFen) === "black");
}

function hiSyncPuzzle() {
  const stale = az.puzzleFeedback.querySelector(".puzzleHuman");
  if (stale) stale.remove();
  if (!puzzleLocked || !puzzles[puzzleIndex]) return;
  renderPuzzleBoard(sideToMove(puzzleFen) === "black");
  puzzleShowHuman(puzzles[puzzleIndex]);
}

// Needs Human insights enabled; only Maia is used here, not Stockfish.
async function puzzleShowHuman(puzzle) {
  const ply = analysis.indexOf(puzzle);
  if (!hi.enable.checked || ply < 0 || !loadedGame) return;
  const rating = hiRating();
  let data;
  try {
    await hiEnsureMaia();
    data = await hiFetchMoves(ply, rating);
  } catch (_) {
    return;
  }
  if (!hi.enable.checked || !puzzleMode || !puzzleLocked || puzzles[puzzleIndex] !== puzzle || !data.moves.length) return;

  renderPuzzleBoard(sideToMove(puzzleFen) === "black");

  const previous = az.puzzleFeedback.querySelector(".puzzleHuman");
  if (previous) previous.remove();
  const line = document.createElement("div");
  line.className = "puzzleHuman";
  const swatch = document.createElement("i");
  swatch.className = "hiSwatch";
  const top = data.moves.slice(0, 3).map((m) => `${m.san} ${hiPct(m.prob)}`).join(" · ");
  const mistake = data.moves.find((m) => m.played);
  line.append(swatch, ` Maia ${rating}: ${top}`);
  if (mistake) line.append(` — the mistake (${mistake.san}) is chosen ${hiPct(mistake.prob)}`);
  az.puzzleFeedback.appendChild(line);
}

function showPuzzleNext() {
  az.puzzleRevealBtn.style.display = "none";
  az.puzzleNextBtn.style.display = "";
  az.puzzleNextBtn.textContent = puzzleIndex + 1 < puzzles.length ? "Next puzzle →" : "Finish";
}

function handlePuzzleCorrect(puzzle) {
  lockPuzzle(puzzle);
  puzzleSolved += 1;
  az.puzzleFeedback.className = "show correct";
  fillPuzzleFeedback("Correct!", puzzle);
  az.puzzleProgress.textContent = `Puzzle ${puzzleIndex + 1} / ${puzzles.length} — solved ${puzzleSolved}`;
  showPuzzleNext();
  renderPuzzleBoard(sideToMove(puzzleFen) === "black");
  puzzleShowHuman(puzzle);
}

// no auto-advance, so the solution line can be clicked through
az.puzzleNextBtn.addEventListener("click", () => {
  if (!puzzleLocked) return;
  if (puzzleIndex + 1 < puzzles.length) {
    puzzleIndex += 1;
    loadPuzzle();
  } else {
    finishPuzzles();
  }
});

az.puzzleRevealBtn.addEventListener("click", () => {
  if (puzzleLocked) return;
  const puzzle = puzzles[puzzleIndex];
  lockPuzzle(puzzle);
  az.puzzleFeedback.className = "show reveal";
  fillPuzzleFeedback(`Answer: ${puzzle.bestMoveSan || "(no line available)"}`, puzzle);
  showPuzzleNext();
  renderPuzzleBoard(sideToMove(puzzleFen) === "black");
  puzzleShowHuman(puzzle);
});

az.puzzleBackBtn.addEventListener("click", () => {
  puzzleIndex = puzzleHomeIndex;
  loadPuzzle();
});

az.puzzleExitBtn.addEventListener("click", exitPuzzleMode);
az.puzzleExitBtn2.addEventListener("click", exitPuzzleMode);
az.puzzleRestartBtn.addEventListener("click", enterPuzzleMode);

function finishPuzzles() {
  az.puzzleActiveActions.style.display = "none";
  az.puzzleDoneActions.style.display = "flex";
  az.puzzleProgress.textContent = `Done! Solved ${puzzleSolved} / ${puzzles.length}.`;
  az.puzzlePrompt.textContent = "";
}

function exitPuzzleMode() {
  puzzleMode = false;
  az.puzzlePanel.classList.remove("show");
  document.getElementById("analyzeTab").classList.remove("practicing");
  renderAnalyzeBoard();
}

renderAnalyzeBoard();
