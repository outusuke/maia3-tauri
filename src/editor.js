const ed = {
  overlay: document.getElementById("setup-overlay"),
  board: document.getElementById("editor-board"),
  trayWhite: document.getElementById("trayWhite"),
  trayBlack: document.getElementById("trayBlack"),
  turnSelect: document.getElementById("editorTurnSelect"),
  castleWK: document.getElementById("castleWK"),
  castleWQ: document.getElementById("castleWQ"),
  castleBK: document.getElementById("castleBK"),
  castleBQ: document.getElementById("castleBQ"),
  fenPreview: document.getElementById("fenPreview"),
  error: document.getElementById("editorError"),
  standardBtn: document.getElementById("editorStandardBtn"),
  clearBtn: document.getElementById("editorClearBtn"),
  applyBtn: document.getElementById("editorApplyBtn"),
  cancelBtn: document.getElementById("editorCancelBtn"),
};

let editorBoardState = {}; // {square: pieceChar}

function buildTray(container, color) {
  container.innerHTML = "";
  const order = ["K", "Q", "R", "B", "N", "P"];
  for (const letter of order) {
    const piece = color === "white" ? letter : letter.toLowerCase();
    const img = document.createElement("img");
    img.className = "piece";
    img.src = pieceImageSrc(piece);
    img.alt = piece;
    img.dataset.piece = piece;
    img.draggable = false;
    img.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      beginPointerDrag(e, {
        ghostSrc: pieceImageSrc(piece),
        onDrop: (kind, value) => {
          if (kind === "square") {
            editorBoardState[value] = piece;
            renderEditorBoard();
          }
        },
      });
    });
    container.appendChild(img);
  }
}
buildTray(ed.trayWhite, "white");
buildTray(ed.trayBlack, "black");

function renderEditorBoard() {
  renderChessBoard(ed.board, boardFenOnly(), {
    interactive: true,
    userArrows: false,
    onSquareClick: (sq) => {
      if (editorBoardState[sq]) { delete editorBoardState[sq]; renderEditorBoard(); }
    },
    onDropMove: (from, to) => {
      editorBoardState[to] = editorBoardState[from];
      delete editorBoardState[from];
      renderEditorBoard();
    },
    onDropToTray: (from) => {
      delete editorBoardState[from];
      renderEditorBoard();
    },
  });
  updateFenPreview();
}

function boardFenOnly() {
  return boardToPlacement(editorBoardState) + " w - - 0 1";
}

// checkboxes go stale when the board is cleared/edited, so verify against the actual pieces
function canCastle(board, side, kingSide) {
  const rank = side === "w" ? "1" : "8";
  const king = side === "w" ? "K" : "k";
  const rook = side === "w" ? "R" : "r";
  const rookFile = kingSide ? "h" : "a";
  return board["e" + rank] === king && board[rookFile + rank] === rook;
}

function buildEditorFen() {
  const placement = boardToPlacement(editorBoardState);
  const turn = ed.turnSelect.value;
  let castling = "";
  if (ed.castleWK.checked && canCastle(editorBoardState, "w", true)) castling += "K";
  if (ed.castleWQ.checked && canCastle(editorBoardState, "w", false)) castling += "Q";
  if (ed.castleBK.checked && canCastle(editorBoardState, "b", true)) castling += "k";
  if (ed.castleBQ.checked && canCastle(editorBoardState, "b", false)) castling += "q";
  if (!castling) castling = "-";
  return `${placement} ${turn} ${castling} - 0 1`;
}

function updateFenPreview() {
  ed.fenPreview.textContent = buildEditorFen();
}

function loadStandardIntoEditor() {
  editorBoardState = fenToBoard(STANDARD_FEN);
  ed.turnSelect.value = "w";
  ed.castleWK.checked = ed.castleWQ.checked = ed.castleBK.checked = ed.castleBQ.checked = true;
  renderEditorBoard();
}

ed.standardBtn.addEventListener("click", loadStandardIntoEditor);
ed.clearBtn.addEventListener("click", () => {
  editorBoardState = {};
  ed.castleWK.checked = ed.castleWQ.checked = ed.castleBK.checked = ed.castleBQ.checked = false;
  renderEditorBoard();
});
[ed.turnSelect, ed.castleWK, ed.castleWQ, ed.castleBK, ed.castleBQ].forEach((el) => {
  el.addEventListener("change", updateFenPreview);
});

els.openSetupBtn.addEventListener("click", () => {
  ed.error.textContent = "";
  const startingFen = els.startFenInput.value.trim() || state.fen || STANDARD_FEN;
  editorBoardState = fenToBoard(startingFen);
  const parts = startingFen.split(" ");
  ed.turnSelect.value = parts[1] === "b" ? "b" : "w";
  const castling = parts[2] || "-";
  ed.castleWK.checked = castling.includes("K");
  ed.castleWQ.checked = castling.includes("Q");
  ed.castleBK.checked = castling.includes("k");
  ed.castleBQ.checked = castling.includes("q");
  renderEditorBoard();
  ed.overlay.classList.add("show");
});
ed.cancelBtn.addEventListener("click", () => ed.overlay.classList.remove("show"));

ed.applyBtn.addEventListener("click", async () => {
  const fen = buildEditorFen();
  ed.error.textContent = "";
  try {
    await invoke("validate_fen", { fen });
  } catch (err) {
    ed.error.textContent = String(err);
    return;
  }
  els.startFenInput.value = fen;
  els.advanced.open = true;
  updateAdvancedSummary();
  hideFenError();
  ed.overlay.classList.remove("show");
  setStatus("Position loaded — click New Game to play it.");
});
