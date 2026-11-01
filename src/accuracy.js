const ACC_PHASES = [
  ["overall", "Accuracy"],
  ["opening", "Opening"],
  ["middlegame", "Middlegame"],
  ["endgame", "Endgame"],
];

// Ranks run 0..7 from White's back rank.
function accParseBoard(fen) {
  const grid = [];
  fen.split(" ")[0].split("/").forEach((row, r) => {
    const cells = [];
    for (const ch of row) {
      if (/\d/.test(ch)) for (let k = 0; k < +ch; k++) cells.push(null);
      else cells.push(ch);
    }
    grid[7 - r] = cells;
  });
  return grid;
}

function accMajorsAndMinors(grid) {
  let n = 0;
  for (const row of grid) for (const p of row) if (p && !/[pk]/i.test(p)) n++;
  return n;
}

function accBackrankSparse(grid) {
  const white = grid[0].filter((p) => p && p === p.toUpperCase()).length;
  const black = grid[7].filter((p) => p && p === p.toLowerCase()).length;
  return white < 4 || black < 4;
}

function accRegionScore(y, w, b) {
  switch (w) {
    case 0:
      if (b === 1) return 1 + y;
      if (b === 2) return y < 6 ? 2 + (6 - y) : 0;
      if (b === 3 || b === 4) return y < 7 ? 3 + (7 - y) : 0;
      return 0;
    case 1:
      if (b === 0) return 1 + (8 - y);
      if (b === 1) return 5 + Math.abs(4 - y);
      if (b === 2) return 4 + (7 - y);
      if (b === 3) return 5 + (7 - y);
      return 0;
    case 2:
      if (b === 0) return y > 2 ? 2 + (y - 2) : 0;
      if (b === 1) return 4 + (y - 1);
      if (b === 2) return 7;
      return 0;
    case 3:
      if (b === 0) return y > 1 ? 3 + (y - 1) : 0;
      if (b === 1) return 5 + (y - 1);
      return 0;
    case 4:
      return b === 0 && y > 1 ? 3 + (y - 1) : 0;
    default:
      return 0;
  }
}

function accMixedness(grid) {
  let total = 0;
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      let w = 0, b = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const p = grid[y + dy][x + dx];
        if (!p) continue;
        if (p === p.toUpperCase()) w++; else b++;
      }
      total += accRegionScore(y + 1, w, b);
    }
  }
  return total;
}

// Same thresholds as lichess's game divider; `fens` holds every position, start included.
function accDivide(fens) {
  const grids = fens.map(accParseBoard);
  const middle = grids.findIndex((g) => accMajorsAndMinors(g) <= 10 || accBackrankSparse(g) || accMixedness(g) > 150);
  const end = middle < 0 ? -1 : grids.findIndex((g) => accMajorsAndMinors(g) <= 6);
  return { middle: end >= 0 && middle >= end ? -1 : middle, end };
}

function accPhaseOf(ply, div) {
  if (div.end >= 0 && ply >= div.end) return "endgame";
  if (div.middle >= 0 && ply >= div.middle) return "middlegame";
  return "opening";
}

function accMoveAccuracy(winLoss) {
  const raw = 103.1668 * Math.exp(-0.04354 * winLoss) - 3.1669 + 1;
  return Math.max(0, Math.min(100, raw));
}

function accStdDev(xs) {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length);
}

// Mean of the volatility-weighted mean and the harmonic mean, as lichess does.
function accCombine(items) {
  if (items.length === 0) return null;
  const weightSum = items.reduce((a, it) => a + it.weight, 0);
  const weighted = items.reduce((a, it) => a + it.acc * it.weight, 0) / weightSum;
  const harmonic = items.length / items.reduce((a, it) => a + 1 / Math.max(it.acc, 0.01), 0);
  return (weighted + harmonic) / 2;
}

function computeAccuracy(moves) {
  const winAfter = moves.map((m) => evalWinPct(evalWhiteCp(m.evalAfterCp, m.mateAfter)));
  const series = [evalWinPct(evalWhiteCp(moves[0].evalBeforeCp, moves[0].mateBefore))].concat(winAfter);
  const size = Math.max(2, Math.min(8, Math.floor(moves.length / 10)));
  const fens = moves.map((m) => m.fenBefore).concat(moves[moves.length - 1].fenAfter);
  const div = accDivide(fens);

  const buckets = { white: { overall: [] }, black: { overall: [] } };
  moves.forEach((m, i) => {
    const white = sideToMove(m.fenBefore) === "white";
    const before = evalWinPct(evalWhiteCp(m.evalBeforeCp, m.mateBefore));
    const after = winAfter[i];
    const loss = Math.max(0, white ? before - after : after - before);
    const start = Math.max(0, i - (size - 2));
    const weight = Math.max(0.5, Math.min(12, accStdDev(series.slice(start, start + size))));
    const item = { acc: accMoveAccuracy(loss), weight };
    const side = buckets[white ? "white" : "black"];
    const phase = accPhaseOf(i, div);
    side.overall.push(item);
    (side[phase] = side[phase] || []).push(item);
  });

  const out = {};
  for (const side of ["white", "black"]) {
    out[side] = {};
    for (const [key] of ACC_PHASES) out[side][key] = accCombine(buckets[side][key] || []);
  }
  return out;
}

function renderAccuracy() {
  const sel = az.sideSelect.value;
  if (!analysis || analysis.length === 0) {
    az.accuracyPanel.style.display = "none";
    return;
  }
  const stats = computeAccuracy(analysis);
  const sides = sel === "both" ? ["white", "black"] : [sel];
  const body = az.accuracyBody;
  body.innerHTML = "";
  body.style.gridTemplateColumns = `1fr repeat(${sides.length}, 64px)`;

  body.appendChild(document.createElement("span"));
  for (const side of sides) {
    const tag = document.createElement("span");
    tag.className = `sideTag ${side}`;
    tag.textContent = side === "white" ? "White" : "Black";
    body.appendChild(tag);
  }
  for (const [key, label] of ACC_PHASES) {
    const name = document.createElement("span");
    name.className = key === "overall" ? "accLabel accOverall" : "accLabel";
    name.textContent = label;
    body.appendChild(name);
    for (const side of sides) {
      const v = stats[side][key];
      const cell = document.createElement("span");
      cell.className = key === "overall" ? "accValue accOverall" : "accValue";
      cell.textContent = v === null ? "–" : `${Math.round(v)}%`;
      body.appendChild(cell);
    }
  }
  az.accuracyPanel.style.display = "block";
}
