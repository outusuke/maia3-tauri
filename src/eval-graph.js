// Eval graph: Y axis is win probability (Lichess curve); linear centipawns would flatten most games near zero.
const EVAL_GRADE_COLORS = { brilliant: "#26c2c2", onlymove: "#5b9bd5", inaccuracy: "#e3c96b", mistake: "#f0a860", blunder: "#e05555" };
const EVAL_GRADE_RADIUS = { brilliant: 5, onlymove: 4.5, inaccuracy: 3.5, mistake: 4.5, blunder: 5.5 };
const EVAL_GRADE_MARK = { good: "", best: "", onlymove: "!", brilliant: "!!", inaccuracy: "?!", mistake: "?", blunder: "??" };
const EVAL_GRADE_NAME = { good: "Good", best: "Best", onlymove: "Only move", brilliant: "Brilliant", inaccuracy: "Inaccuracy", mistake: "Mistake", blunder: "Blunder" };
let evalHoverPly = null;
let evalDragging = false;
let evalGeom = null;       // { left, plotW, n } from the last draw, for hit-testing

// White's point of view in centipawns, clamped; mates pin to the edge.
function evalWhiteCp(cp, mate) {
  if (typeof cp === "number") return Math.max(-3000, Math.min(3000, cp));
  if (typeof mate === "number") return mate > 0 ? 3000 : mate < 0 ? -3000 : 0;
  return 0;
}
function evalWinPct(cp) {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}
// "+1.25", "−0.40", "#3" (White mates in 3), "−#2" (Black mates in 2)
function evalLabel(cp, mate) {
  if (typeof cp !== "number") {
    if (typeof mate !== "number") return "?";
    return (mate < 0 ? "−" : "") + "#" + Math.abs(mate);
  }
  const v = cp / 100;
  const t = Math.abs(v).toFixed(2);
  return v > 0 ? "+" + t : v < 0 ? "−" + t : "0.00";
}

// Follows the "Grade whose moves" selector, same as the move list.
let gradeFilter = null; // which legend button is "active" for cycling; doesn't hide anything
function evalMoveVisible(m) {
  if (puzzleMode) return puzzles.includes(m);
  const side = az.sideSelect.value;
  return side === "both" || sideToMove(m.fenBefore) === side;
}

// Indices of moves of grade `g` that the "Grade whose moves" selector currently includes, in play order.
function gradeMatches(g) {
  return analysis.reduce((acc, m, i) => { if (m.grade === g && evalMoveVisible(m)) acc.push(i); return acc; }, []);
}

function evalCursorPly() {
  if (puzzleMode && puzzles[puzzleIndex]) return Math.max(0, analysis.indexOf(puzzles[puzzleIndex]));
  return azViewPly;
}

function selectPuzzleNearPly(ply) {
  if (ply === null || puzzles.length === 0) return;
  let best = puzzleIndex, bestDist = Infinity;
  puzzles.forEach((p, i) => {
    const d = Math.abs(analysis.indexOf(p) + 1 - ply); // dots sit one ply after the mistake
    if (d < bestDist) { bestDist = d; best = i; }
  });
  if (best === puzzleIndex) return;
  puzzleIndex = best;
  loadPuzzle(true);
}

// Jumps to the next move of this grade after the position on screen, wrapping back to the first.
function jumpToGrade(g) {
  const matches = gradeMatches(g);
  if (matches.length === 0) return;
  if (puzzleMode) {
    const cur = evalCursorPly();
    const next = matches.find((i) => i > cur);
    const target = analysis[next === undefined ? matches[0] : next];
    const idx = puzzles.indexOf(target);
    if (idx >= 0 && idx !== puzzleIndex) { puzzleIndex = idx; loadPuzzle(true); }
    return;
  }
  gradeFilter = g;
  const next = matches.find((i) => i + 1 > azViewPly);
  variation = null;
  azViewPly = next === undefined ? matches[0] + 1 : next + 1;
  renderAnalyzeBoard();
}

function drawEvalGraph() {
  const svg = az.evalGraph;
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  if (!analysis || analysis.length === 0) {
    az.evalBox.style.display = "none";
    evalGeom = null;
    return;
  }
  az.evalBox.style.display = "block";

  const W = Math.round(svg.clientWidth);
  const H = Math.round(svg.clientHeight);
  if (W < 80 || H < 40) return; // not laid out yet; the ResizeObserver redraws
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const n = analysis.length;
  const curPly = evalCursorPly();
  const left = 30, right = 10, top = 10, bottom = 20;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  const mid = top + plotH / 2;
  const xAt = (ply) => left + (n === 0 ? 0 : (ply / n) * plotW);
  const yAt = (cp) => top + plotH * (1 - evalWinPct(cp) / 100);
  evalGeom = { left, plotW, n };

  const cps = [evalWhiteCp(analysis[0].evalBeforeCp, analysis[0].mateBefore)]
    .concat(analysis.map((m) => evalWhiteCp(m.evalAfterCp, m.mateAfter)));
  const pts = cps.map((cp, i) => [xAt(i), yAt(cp)]);

  for (const [cp, label] of [[300, "+3"], [100, "+1"], [0, "0"], [-100, "−1"], [-300, "−3"]]) {
    const y = yAt(cp);
    svgEl("line", {
      x1: left, x2: left + plotW, y1: y, y2: y,
      stroke: cp === 0 ? "#5a5f6b" : "rgba(255,255,255,0.08)",
      "stroke-width": 1, "stroke-dasharray": cp === 0 ? "" : "2 3",
    }, svg);
    const t = svgEl("text", {
      x: left - 6, y: y + 3, "text-anchor": "end", "font-size": 9.5, fill: "#7d8390",
    }, svg);
    t.textContent = label;
  }

  const moves = n / 2;
  const step = moves <= 10 ? 2 : moves <= 30 ? 5 : moves <= 60 ? 10 : 20;
  for (let mv = step; mv * 2 <= n; mv += step) {
    const x = xAt(mv * 2);
    svgEl("line", { x1: x, x2: x, y1: top + plotH, y2: top + plotH + 3, stroke: "#5a5f6b" }, svg);
    const t = svgEl("text", {
      x, y: H - 5, "text-anchor": "middle", "font-size": 9.5, fill: "#7d8390",
    }, svg);
    t.textContent = String(mv);
  }

  const defs = svgEl("defs", {}, svg);
  const clipUp = svgEl("clipPath", { id: "evalClipUp" }, defs);
  svgEl("rect", { x: left, y: top, width: plotW, height: mid - top }, clipUp);
  const clipDown = svgEl("clipPath", { id: "evalClipDown" }, defs);
  svgEl("rect", { x: left, y: mid, width: plotW, height: top + plotH - mid }, clipDown);
  const areaD =
    `M${pts[0][0].toFixed(1)},${mid} ` +
    pts.map((p) => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ") +
    ` L${pts[pts.length - 1][0].toFixed(1)},${mid} Z`;
  svgEl("path", { d: areaD, fill: "rgba(231,233,238,0.65)", "clip-path": "url(#evalClipUp)" }, svg);
  svgEl("path", { d: areaD, fill: "rgba(0,0,0,0.55)", "clip-path": "url(#evalClipDown)" }, svg);

  svgEl("polyline", {
    points: pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" "),
    fill: "none", stroke: "#8fb0ff", "stroke-width": 1.8,
    "stroke-linejoin": "round", "stroke-linecap": "round",
  }, svg);

  if (evalHoverPly !== null && evalHoverPly !== curPly) {
    svgEl("line", {
      x1: xAt(evalHoverPly), x2: xAt(evalHoverPly), y1: top, y2: top + plotH,
      stroke: "rgba(255,255,255,0.35)", "stroke-width": 1,
    }, svg);
  }

  const cx = xAt(curPly);
  svgEl("line", {
    x1: cx, x2: cx, y1: top, y2: top + plotH, stroke: "#5a86f5", "stroke-width": 1.5,
  }, svg);

  // Drawn last so the dots sit on top.
  for (let i = 0; i < n; i++) {
    const m = analysis[i];
    const color = EVAL_GRADE_COLORS[m.grade];
    if (!color || !evalMoveVisible(m)) continue;
    const [x, y] = pts[i + 1];
    const r = EVAL_GRADE_RADIUS[m.grade];
    const isCurPuzzle = puzzleMode && puzzles[puzzleIndex] === m;
    if (isCurPuzzle || i + 1 === curPly || i + 1 === evalHoverPly) {
      svgEl("circle", { cx: x, cy: y, r: r + 3.5, fill: "none", stroke: "#fff", "stroke-width": 1.5 }, svg);
    }
    svgEl("circle", { cx: x, cy: y, r, fill: color, stroke: "#16181d", "stroke-width": 1.5 }, svg);
  }
  const curMove = curPly > 0 ? analysis[curPly - 1] : null;
  if (!curMove || !EVAL_GRADE_COLORS[curMove.grade] || !evalMoveVisible(curMove)) {
    const [x, y] = pts[curPly];
    svgEl("circle", { cx: x, cy: y, r: 3.5, fill: "#fff", stroke: "#5a86f5", "stroke-width": 2 }, svg);
  }

  renderEvalInfo(evalHoverPly !== null ? evalHoverPly : curPly);
  renderEvalLegend();
}

function renderEvalInfo(ply) {
  const box = az.evalInfo;
  box.textContent = "";
  const add = (text, cls) => {
    const s = document.createElement("span");
    if (cls) s.className = cls;
    s.textContent = text;
    box.appendChild(s);
    return s;
  };

  if (ply === 0) {
    add("Start position", "evalMove");
    add(` · eval ${evalLabel(analysis[0].evalBeforeCp, analysis[0].mateBefore)}`, "evalMuted");
    return;
  }
  const m = analysis[ply - 1];
  const num = Math.floor((ply - 1) / 2) + 1;
  const label = (ply - 1) % 2 === 0 ? `${num}.` : `${num}...`;
  add(`${label} ${m.san}${EVAL_GRADE_MARK[m.grade]}`, "evalMove");
  add(` ${EVAL_GRADE_NAME[m.grade]}`, gradeClass(m.grade));

  const before = evalLabel(m.evalBeforeCp, m.mateBefore);
  const after = evalLabel(m.evalAfterCp, m.mateAfter);
  add(` · eval ${before === after ? after : `${before} → ${after}`}`, "evalMuted");

  if (!puzzleMode && !isPositiveGrade(m.grade) && m.bestMoveSan) {
    add(" · better: ", "evalMuted");
    const b = document.createElement(hasClickableLine(m) ? "span" : "b");
    b.textContent = m.bestMoveSan;
    if (hasClickableLine(m)) {
      b.className = "lineMove bestMove";
      b.title = "Show the better move on the board";
      b.addEventListener("click", (e) => { e.stopPropagation(); startVariation(ply - 1, 1); });
    }
    box.appendChild(b);
  }

  az.evalLine.textContent = "";
  if (!puzzleMode && !isPositiveGrade(m.grade) && hasClickableLine(m)) {
    renderLineChips(az.evalLine, m, (n) => startVariation(ply - 1, n));
    az.evalLine.dataset.ply = String(ply - 1);
  }
}

function renderEvalLegend() {
  az.evalLegend.textContent = "";
  const GRADE_NOUN_PLURAL = { brilliant: "brilliant moves", onlymove: "only moves", inaccuracy: "inaccuracies", mistake: "mistakes", blunder: "blunders" };
  const GRADE_NOUN_SINGULAR = { brilliant: "brilliant move", onlymove: "only move", inaccuracy: "inaccuracy", mistake: "mistake", blunder: "blunder" };
  for (const g of ["brilliant", "onlymove", "inaccuracy", "mistake", "blunder"]) {
    const matches = gradeMatches(g);
    const item = document.createElement("button");
    item.type = "button";
    item.className = "evalLegendItem";
    item.classList.toggle("active", gradeFilter === g);
    item.disabled = matches.length === 0;
    const dot = document.createElement("span");
    dot.className = "evalLegendDot";
    dot.style.background = EVAL_GRADE_COLORS[g];
    item.appendChild(dot);
    const noun = matches.length === 1 ? GRADE_NOUN_SINGULAR[g] : GRADE_NOUN_PLURAL[g];
    item.appendChild(document.createTextNode(`${matches.length} ${noun}`));
    item.title = matches.length ? `Jump to the next ${EVAL_GRADE_NAME[g].toLowerCase()}` : "";
    item.addEventListener("click", () => jumpToGrade(g));
    az.evalLegend.appendChild(item);
  }
}

function evalPlyFromEvent(e) {
  if (!analysis || !evalGeom) return null;
  const rect = az.evalGraph.getBoundingClientRect();
  const frac = (e.clientX - rect.left - evalGeom.left) / evalGeom.plotW;
  return Math.max(0, Math.min(evalGeom.n, Math.round(frac * evalGeom.n)));
}
function evalSeek(ply) {
  if (ply === null) return;
  if (puzzleMode) { selectPuzzleNearPly(ply); return; }
  if (ply === azViewPly && !variation) return;
  variation = null;
  azViewPly = ply;
  renderAnalyzeBoard();
}
az.evalGraph.addEventListener("pointerdown", (e) => {
  if (!analysis) return;
  evalDragging = true;
  az.evalGraph.setPointerCapture(e.pointerId);
  evalHoverPly = evalPlyFromEvent(e);
  evalSeek(evalHoverPly);
});
az.evalGraph.addEventListener("pointermove", (e) => {
  if (!analysis) return;
  const p = evalPlyFromEvent(e);
  if (evalDragging) evalSeek(p);
  if (p !== evalHoverPly) {
    evalHoverPly = p;
    drawEvalGraph();
  }
});
const evalPointerDone = () => { evalDragging = false; };
az.evalGraph.addEventListener("pointerup", evalPointerDone);
az.evalGraph.addEventListener("pointercancel", evalPointerDone);
az.evalGraph.addEventListener("pointerleave", () => {
  if (evalDragging) return;
  evalHoverPly = null;
  if (analysis) drawEvalGraph();
});
// Also fires when the Analyze tab first becomes visible.
new ResizeObserver(() => drawEvalGraph()).observe(az.evalGraph);
