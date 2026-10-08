const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = ["1", "2", "3", "4", "5", "6", "7", "8"];
const STANDARD_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const GRADE_BADGE_ICON = {
  brilliant: "img/classifications/brilliant.png",
  onlymove: "img/classifications/critical.png",
  best: "img/classifications/best.png",
  good: "img/classifications/okay.png",
  inaccuracy: "img/classifications/inaccuracy.png",
  mistake: "img/classifications/mistake.png",
  blunder: "img/classifications/blunder.png",
};

function pieceImageSrc(piece) {
  const color = piece === piece.toUpperCase() ? "w" : "b";
  return `img/chesspieces/wikipedia/${color}${piece.toUpperCase()}.png`;
}

for (const p of "KQRBNPkqrbnp") {
  const img = new Image();
  img.src = pieceImageSrc(p);
  if (img.decode) img.decode().catch(() => {});
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(name, attrs, parent) {
  const e = document.createElementNS(SVG_NS, name);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(e);
  return e;
}

function isPieceOfColor(piece, color) {
  if (!piece) return false;
  return color === "white" ? piece === piece.toUpperCase() : piece === piece.toLowerCase();
}

// Pointer events instead of HTML5 DnD: WebKitGTK's is flaky, and the click after a drag used to land on the destination square.
let activeDrag = null;

function beginPointerDrag(pointerEvent, spec) {
  const { boardEl, fromSq } = spec;
  const startX = pointerEvent.clientX;
  const startY = pointerEvent.clientY;
  let size = 52;
  let engaged = false;
  let ghost = null;
  let overEl = null;

  function applyDragClasses() {
    if (!boardEl || !fromSq) return;
    const src = boardEl.querySelector(`.square[data-square="${fromSq}"]`);
    if (src) src.classList.add("dragging");
    if (overEl && overEl.dataset && overEl.dataset.square && !overEl.isConnected) {
      overEl = boardEl.querySelector(`.square[data-square="${overEl.dataset.square}"]`);
    }
    if (overEl) overEl.classList.add("drag-over");
  }

  function setOver(next) {
    if (next === overEl) return;
    if (overEl) overEl.classList.remove("drag-over");
    if (next) next.classList.add("drag-over");
    overEl = next;
  }

  function elementUnder(clientX, clientY) {
    const under = document.elementFromPoint(clientX, clientY);
    if (!under || !under.closest) return null;
    return under.closest(".square[data-square]") || under.closest(".tray");
  }

  function onMove(ev) {
    if (!spec.ghostSrc) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!engaged) {
      if (Math.hypot(dx, dy) < 4) return;
      engaged = true;
      const anySquare = boardEl && boardEl.querySelector(".square");
      if (anySquare) size = anySquare.getBoundingClientRect().width * 0.95;
      document.body.classList.add("is-dragging");
      const sel = window.getSelection && window.getSelection();
      if (sel && sel.removeAllRanges) sel.removeAllRanges();
      ghost = document.createElement("img");
      ghost.src = spec.ghostSrc;
      ghost.draggable = false;
      ghost.className = "piece drag-ghost";
      ghost.style.width = ghost.style.height = size + "px";
      document.body.appendChild(ghost);
      activeDrag = { boardEl, refresh: applyDragClasses };
      applyDragClasses();
    }
    ev.preventDefault();
    ghost.style.left = (ev.clientX - size / 2) + "px";
    ghost.style.top = (ev.clientY - size / 2) + "px";
    setOver(elementUnder(ev.clientX, ev.clientY));
  }

  function cleanup() {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onCancel);
    if (boardEl) boardEl.querySelectorAll(".dragging, .drag-over").forEach((n) => n.classList.remove("dragging", "drag-over"));
    if (overEl) overEl.classList.remove("drag-over");
    if (ghost) ghost.remove();
    document.body.classList.remove("is-dragging");
    if (activeDrag && activeDrag.boardEl === boardEl) activeDrag = null;
  }

  function onUp(ev) {
    const wasEngaged = engaged;
    const under = elementUnder(ev.clientX, ev.clientY);
    const target = under;
    cleanup();
    if (!wasEngaged) {
      if (spec.onClick && under && under.dataset && under.dataset.square === fromSq) spec.onClick(fromSq);
      return;
    }
    if (!spec.onDrop) return;
    if (target && target.classList.contains("square")) spec.onDrop("square", target.dataset.square);
    else if (target && target.classList.contains("tray")) spec.onDrop("tray", target);
    else spec.onDrop(null, null);
  }

  function onCancel() { cleanup(); }

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onCancel);
}

// Right-drag draws an arrow, right-click a circle; Shift = red, Ctrl/Alt = blue, both = yellow.
const BRUSH = {
  green: "#15781b",
  red: "#c33333",
  blue: "#2f6fdc",
  yellow: "#e68f00",
  human: "#9b4fd8",
};

function brushFromEvent(e) {
  const mod = e.ctrlKey || e.metaKey || e.altKey;
  if (mod && e.shiftKey) return "yellow";
  if (mod) return "blue";
  if (e.shiftKey) return "red";
  return "green";
}

function uciToSquares(uci) {
  return uci && uci.length >= 4 ? [uci.slice(0, 2), uci.slice(2, 4)] : null;
}

function squareCenter(sq, flipped) {
  const fi = FILES.indexOf(sq[0]);
  const ri = parseInt(sq[1], 10) - 1;
  return [(flipped ? 7 - fi : fi) + 0.5, (flipped ? ri : 7 - ri) + 0.5];
}

function squareFromPoint(boardEl, clientX, clientY) {
  const r = boardEl.getBoundingClientRect();
  const w = boardEl.clientWidth, h = boardEl.clientHeight;
  if (!w || !h) return null;
  const x = (clientX - r.left - boardEl.clientLeft) / w * 8;
  const y = (clientY - r.top - boardEl.clientTop) / h * 8;
  if (x < 0 || y < 0 || x >= 8 || y >= 8) return null;
  const col = Math.floor(x), row = Math.floor(y);
  const flipped = !!boardEl._flipped;
  return FILES[flipped ? 7 - col : col] + ((flipped ? row : 7 - row) + 1);
}

function drawArrowShape(svg, shape, flipped) {
  const [x1, y1] = squareCenter(shape.from, flipped);
  const color = BRUSH[shape.brush] || shape.brush || BRUSH.green;
  const opacity = shape.opacity !== undefined ? shape.opacity : 0.8;

  if (shape.from === shape.to) {
    svgEl("circle", {
      cx: x1, cy: y1, r: 0.45, fill: "none", stroke: color, "stroke-width": 0.08, opacity,
    }, svg);
    return;
  }

  const [x2, y2] = squareCenter(shape.to, flipped);
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const ux = dx / len, uy = dy / len;
  const HEAD_LEN = 0.44, HEAD_HALF = 0.3, LINE_W = 0.17, MARGIN = 0.1, TAIL = 0.12;

  const tipX = x2 - ux * MARGIN, tipY = y2 - uy * MARGIN;
  const baseX = tipX - ux * HEAD_LEN, baseY = tipY - uy * HEAD_LEN;
  // group opacity so the shaft/head overlap doesn't show a darker seam
  const g = svgEl("g", { opacity }, svg);
  svgEl("line", {
    x1: x1 + ux * TAIL, y1: y1 + uy * TAIL,
    x2: baseX + ux * 0.03, y2: baseY + uy * 0.03,
    stroke: color, "stroke-width": LINE_W, "stroke-linecap": "butt",
  }, g);
  const px = -uy, py = ux;
  svgEl("polygon", {
    points: [
      `${tipX},${tipY}`,
      `${baseX + px * HEAD_HALF},${baseY + py * HEAD_HALF}`,
      `${baseX - px * HEAD_HALF},${baseY - py * HEAD_HALF}`,
    ].join(" "),
    fill: color,
  }, g);
}

function renderArrowOverlay(el) {
  let svg = el.querySelector(":scope > svg.board-arrows");
  if (!svg) {
    svg = svgEl("svg", { class: "board-arrows", viewBox: "0 0 8 8", preserveAspectRatio: "none" });
    el.appendChild(svg);
  }
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const flipped = !!el._flipped;
  const shapes = []
    .concat(el._autoShapes || [])
    .concat(el._user ? el._user.shapes : [])
    .concat(el._drawing ? [el._drawing] : []);
  shapes.filter((s) => s.from === s.to).forEach((s) => drawArrowShape(svg, s, flipped));
  shapes.filter((s) => s.from !== s.to).forEach((s) => drawArrowShape(svg, s, flipped));
}

function clearUserShapes(el) {
  if (el._user && el._user.shapes.length) {
    el._user.shapes = [];
    renderArrowOverlay(el);
  }
}

function toggleUserShape(el, shape) {
  const list = el._user.shapes;
  const i = list.findIndex((s) => s.from === shape.from && s.to === shape.to);
  if (i >= 0) {
    const same = list[i].brush === shape.brush;
    list.splice(i, 1);
    if (same) return;
  }
  list.push(shape);
}

// the board element outlives re-renders (only its children are rebuilt), so this runs once
function installBoardHandlers(el, allowArrows) {
  if (el._handlersInstalled) return;
  el._handlersInstalled = true;

  // backup for webviews that still start a native selection/drag despite preventDefault
  el.addEventListener("selectstart", (e) => e.preventDefault());
  el.addEventListener("dragstart", (e) => e.preventDefault());
  if (!allowArrows) return;

  el.addEventListener("contextmenu", (e) => e.preventDefault());

  el.addEventListener("pointerdown", (e) => {
    if (e.button === 0) { clearUserShapes(el); return; }
    if (e.button !== 2) return;
    const from = squareFromPoint(el, e.clientX, e.clientY);
    if (!from) return;
    e.preventDefault();
    const brush = brushFromEvent(e);
    el._drawing = { from, to: from, brush, opacity: 0.6 };
    renderArrowOverlay(el);

    const move = (ev) => {
      const sq = squareFromPoint(el, ev.clientX, ev.clientY);
      if (el._drawing && sq && sq !== el._drawing.to) {
        el._drawing.to = sq;
        renderArrowOverlay(el);
      }
    };
    const finish = (commit) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel);
      const d = el._drawing;
      el._drawing = null;
      if (commit && d && el._user) toggleUserShape(el, { from: d.from, to: d.to, brush: d.brush });
      renderArrowOverlay(el);
    };
    const up = (ev) => { if (ev.button === 2) finish(true); };
    const cancel = () => finish(false);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel);
  });
}

function fenToBoard(fen) {
  const placement = fen.split(" ")[0];
  const rows = placement.split("/"); // rank8 .. rank1
  const board = {};
  rows.forEach((row, rowIdx) => {
    const rank = 8 - rowIdx;
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        file += parseInt(ch, 10);
      } else {
        board[FILES[file] + rank] = ch;
        file += 1;
      }
    }
  });
  return board;
}

function boardToPlacement(board) {
  const rows = [];
  for (let rank = 8; rank >= 1; rank--) {
    let row = "";
    let empty = 0;
    for (const file of FILES) {
      const piece = board[file + rank];
      if (piece) {
        if (empty > 0) { row += empty; empty = 0; }
        row += piece;
      } else {
        empty += 1;
      }
    }
    if (empty > 0) row += empty;
    rows.push(row);
  }
  return rows.join("/");
}

function squareColor(file, rank) {
  const fi = FILES.indexOf(file);
  const ri = RANKS.indexOf(rank);
  return (fi + ri) % 2 === 0 ? "dark" : "light";
}

function sideToMove(fen) {
  const parts = fen.split(" ");
  return parts[1] === "b" ? "black" : "white";
}

// Lichess order: pawns, then minor/major pieces by value.
const CAPTURE_ORDER = ["p", "n", "b", "r", "q"];
const START_COUNTS = { p: 8, n: 2, b: 2, r: 2, q: 1 };

function materialInfo(fen) {
  const board = fenToBoard(fen);
  const remaining = { p: 0, n: 0, b: 0, r: 0, q: 0, P: 0, N: 0, B: 0, R: 0, Q: 0 };
  for (const p of Object.values(board)) if (p in remaining) remaining[p]++;
  let diff = 0;
  const capturedByWhite = []; // black pieces White has taken, drawn as black icons
  const capturedByBlack = []; // white pieces Black has taken, drawn as white icons
  for (const t of CAPTURE_ORDER) {
    const blackLost = START_COUNTS[t] - remaining[t];
    const whiteLost = START_COUNTS[t] - remaining[t.toUpperCase()];
    for (let i = 0; i < blackLost; i++) capturedByWhite.push(t);
    for (let i = 0; i < whiteLost; i++) capturedByBlack.push(t.toUpperCase());
    diff += (blackLost - whiteLost) * PIECE_VALUES[t];
  }
  return { capturedByWhite, capturedByBlack, diff };
}

function renderMaterialSide(el, pieces, lead) {
  const key = pieces.join("") + "|" + lead;
  if (el._materialKey === key) return;
  el._materialKey = key;
  el.textContent = "";
  if (pieces.length === 0 && !lead) return;
  const group = document.createElement("span");
  group.className = "materialGroup";
  for (const p of pieces) {
    const img = document.createElement("img");
    img.src = pieceImageSrc(p);
    img.alt = p;
    group.appendChild(img);
  }
  el.appendChild(group);
  if (lead) {
    const span = document.createElement("span");
    span.className = "materialLead";
    span.textContent = `+${lead}`;
    el.appendChild(span);
  }
}

// Which bar shows which color's captures follows the board's orientation, same as Lichess.
function renderMaterialBars(topEl, bottomEl, fen, flipped) {
  const { capturedByWhite, capturedByBlack, diff } = materialInfo(fen);
  renderMaterialSide(flipped ? topEl : bottomEl, capturedByWhite, diff > 0 ? diff : 0);
  renderMaterialSide(flipped ? bottomEl : topEl, capturedByBlack, diff < 0 ? -diff : 0);
}

function onSquarePointerDown(e, boardEl, sq, piece, opts) {
  if (e.button !== undefined && e.button !== 0) return;
  // otherwise the webview starts a text selection that highlights other squares mid-drag
  e.preventDefault();
  const draggable = !!piece && (!opts.canDrag || opts.canDrag(piece));
  const wasSelected = opts.selected === sq;
  if (draggable && opts.onGrab) opts.onGrab(sq);

  beginPointerDrag(e, {
    boardEl,
    fromSq: sq,
    ghostSrc: draggable ? pieceImageSrc(piece) : null,
    onDrop: (kind, value) => {
      if (kind === "square" && value !== sq && opts.onDropMove) {
        opts.onDropMove(sq, value);
      } else if (kind === "tray" && opts.onDropToTray) {
        opts.onDropToTray(sq);
      }
    },
    onClick: () => {
      if (draggable && opts.onGrab) {
        if (wasSelected && opts.onDeselect) opts.onDeselect();
        return;
      }
      if (opts.onSquareClick) opts.onSquareClick(sq);
    },
  });
}

function buildBoardSquares(el, files, ranks) {
  el.innerHTML = "";
  el._squares = {};
  for (const rank of ranks) {
    for (const file of files) {
      const sq = file + rank;
      const div = document.createElement("div");
      div.dataset.square = sq;
      if (file === files[0]) {
        const rc = document.createElement("span");
        rc.className = "coord rank";
        rc.textContent = rank;
        div.appendChild(rc);
      }
      if (rank === ranks[ranks.length - 1]) {
        const fc = document.createElement("span");
        fc.className = "coord file";
        fc.textContent = file;
        div.appendChild(fc);
      }
      div.addEventListener("pointerdown", (e) => {
        if (el._opts && el._opts.interactive) onSquarePointerDown(e, el, sq, el._board[sq], el._opts);
      });
      el.appendChild(div);
      el._squares[sq] = div;
    }
  }
}

// squares and piece images are reused between calls so redundant redraws don't flash
function renderChessBoard(el, fen, opts) {
  opts = opts || {};
  const board = fenToBoard(fen);
  const flipped = !!opts.flipped;

  el._flipped = flipped;
  el._autoShapes = opts.arrows || [];
  el._opts = opts;
  el._board = board;
  const placement = fen.split(" ")[0];
  if (!el._user || el._user.placement !== placement) el._user = { placement, shapes: [] };
  installBoardHandlers(el, opts.userArrows !== false);

  const files = flipped ? [...FILES].reverse() : FILES;
  const ranks = flipped ? RANKS : [...RANKS].reverse();
  if (el._layout !== flipped) {
    buildBoardSquares(el, files, ranks);
    el._layout = flipped;
  }

  for (const rank of ranks) {
    for (const file of files) {
      const sq = file + rank;
      const div = el._squares[sq];

      let cls = `square ${squareColor(file, rank)}`;
      if (opts.selected === sq) cls += " selected";
      if (opts.lastMove && (opts.lastMove[0] === sq || opts.lastMove[1] === sq)) cls += " last-move";
      if (opts.checkSquare && sq === opts.checkSquare) cls += " in-check";
      const piece = board[sq];
      if (opts.legalTargets && opts.legalTargets.includes(sq)) {
        cls += " move-dot";
        if (piece) cls += " capture";
      }
      div.className = cls;

      if (piece) {
        if (!div._img) {
          const img = document.createElement("img");
          img.className = "piece";
          img.draggable = false;
          img.decoding = "sync";
          div.insertBefore(img, div.firstChild);
          div._img = img;
        }
        if (div._piece !== piece) {
          div._img.src = pieceImageSrc(piece);
          div._img.alt = piece;
          div._piece = piece;
        }
      } else if (div._img) {
        div._img.remove();
        div._img = null;
        div._piece = null;
      }

      const badgeIcon = opts.badge && opts.badge.square === sq && GRADE_BADGE_ICON[opts.badge.grade];
      if (badgeIcon) {
        if (!div._badge) {
          div._badge = document.createElement("img");
          div.appendChild(div._badge);
        }
        div._badge.className = `moveBadge ${gradeClass(opts.badge.grade)}`;
        if (div._badge.getAttribute("src") !== badgeIcon) div._badge.src = badgeIcon;
        div._badge.alt = opts.badge.grade;
      } else if (div._badge) {
        div._badge.remove();
        div._badge = null;
      }
    }
  }

  renderArrowOverlay(el);
  // legal moves can arrive mid-drag and re-render the board
  if (activeDrag && activeDrag.boardEl === el) activeDrag.refresh();
}

function needsPromotionMove(fen, from, to) {
  const board = fenToBoard(fen);
  const piece = board[from];
  if (!piece) return false;
  const isPawn = piece.toLowerCase() === "p";
  const destRank = to[1];
  return isPawn && (destRank === "8" || destRank === "1");
}

function askPromotion(pickerEl, colorPrefix) {
  return new Promise((resolve) => {
    pickerEl.querySelectorAll(".promo-btn").forEach((btn) => {
      const img = btn.querySelector(".promo-img");
      img.src = `img/chesspieces/wikipedia/${colorPrefix}${btn.dataset.piece.toUpperCase()}.png`;
    });
    pickerEl.classList.remove("hidden");
    const handler = (e) => {
      const btn = e.target.closest(".promo-btn");
      if (!btn) return;
      pickerEl.classList.add("hidden");
      pickerEl.removeEventListener("click", handler);
      resolve(btn.dataset.piece);
    };
    pickerEl.addEventListener("click", handler);
  });
}
