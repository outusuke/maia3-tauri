// UX layer. Loaded after the feature scripts and before main.js. It only adds to the existing screens:
// strength presets, a start prompt and result card on the board, two-step confirms, status mood,
// and a smoother Review flow (load -> analyze -> practice).
(function () {
  const $ = (id) => document.getElementById(id);
  const sessionIsReady = () => typeof sessionReady !== "undefined" && sessionReady;

  function wrap(name, { before, after } = {}) {
    const orig = window[name];
    if (typeof orig !== "function") return;
    window[name] = function (...args) {
      try { if (before) before(args); } catch (e) { console.error(e); }
      const out = orig.apply(this, args);
      try { if (after) after(out, args); } catch (e) { console.error(e); }
      return out;
    };
  }

  // ---------- opponent strength: presets + a human label ----------
  const PRESETS = [[800, "Beginner"], [1100, "Casual"], [1500, "Club"], [1900, "Strong"], [2300, "Expert"]];
  function levelName(elo) {
    if (elo < 900) return "Beginner";
    if (elo < 1200) return "Casual player";
    if (elo < 1500) return "Intermediate";
    if (elo < 1800) return "Club player";
    if (elo < 2100) return "Strong club player";
    if (elo < 2400) return "Expert";
    return "Master level";
  }

  const presetBox = $("elo-presets");
  PRESETS.forEach(([elo, label]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.elo = String(elo);
    const num = document.createElement("b"), name = document.createElement("span");
    num.textContent = String(elo);
    name.textContent = label;
    b.append(num, name);
    b.title = `${label} · Elo ${elo}`;
    presetBox.appendChild(b);
  });
  presetBox.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-elo]");
    if (!b) return;
    els.eloSlider.value = b.dataset.elo;
    els.eloSlider.dispatchEvent(new Event("input"));
    els.eloSlider.dispatchEvent(new Event("change")); // mid-game this updates the engine too
  });

  function syncElo() {
    const elo = parseInt(els.eloSlider.value, 10);
    $("elo-level").textContent = levelName(elo);
    presetBox.querySelectorAll("button").forEach((b) => b.classList.toggle("active", Number(b.dataset.elo) === elo));
    relabelStrips();
    syncOpp();
  }
  els.eloSlider.addEventListener("input", syncElo);
  // session restore sets the label text without firing events
  new MutationObserver(syncElo).observe(els.eloValue, { childList: true, characterData: true, subtree: true });
  
  // ---------- player strips: "You" and "Maia 1500" instead of White / Black ----------
  function relabelStrips() {
    if (!(gameStarted || posHistory.length > 1)) return;
    for (const strip of [els.materialTop, els.materialBottom]) {
      const name = strip.querySelector(".pName");
      const dot = name && name.querySelector(".pDot");
      if (!dot) continue;
      const color = dot.classList.contains("white") ? "white" : "black";
      const label = color === playerColor ? "You" : `Maia ${els.eloSlider.value}`;
      const text = [...name.childNodes].find((n) => n.nodeType === 3);
      if (text && text.nodeValue !== label) text.nodeValue = label;
    }
  }
  wrap("renderMaterialBars", { after: (_, [top]) => { if (top === els.materialTop) relabelStrips(); } });

  // ---------- status line mood ----------
  function moodOf(t) {
    if (/^(Could not|Engine error|Move rejected|Fix the|Stockfish)/.test(t)) return "error";
    if (/^Your move/.test(t)) return "yours";
    if (/thinking|^Starting Maia|^Loading/.test(t)) return "thinking";
    if (/^(Checkmate|Draw|You resigned)/.test(t)) return "over";
    return "";
  }
  wrap("setStatus", {
  after: (_, [t]) => {
    const mood = moodOf(String(t));
    els.status.dataset.mood = mood;
    // the status line sits behind the dialog, so show start-up errors inside it
    const err = $("sheet-error");
    err.textContent = mood === "error" ? String(t) : "";
    err.hidden = mood !== "error";
    syncOpp();
  },
});

  // ---------- New game dialog (the old side panel, lifted into a modal / bottom sheet) ----------
  const sheet = els.setupPanel;
  document.body.appendChild(sheet);
  const scrim = document.createElement("div");
  scrim.id = "setupScrim";
  scrim.hidden = true;
  document.body.appendChild(scrim);
  document.body.dataset.tab = "play";
  wrap("switchTab", { after: (_, [name]) => { document.body.dataset.tab = name; syncSheet(); } });

  const startCard = $("startCard");
  const sheetIsOpen = () => !sheet.classList.contains("collapsed");
  const closeSheet = () => sheet.classList.add("collapsed");
  let wasOpen = false;
  function syncSheet() {
    const open = sheetIsOpen() && document.body.dataset.tab !== "analyze";
    scrim.hidden = !open;
    if (open && !wasOpen) els.startBtn.focus({ preventScroll: true });
    wasOpen = open;
    syncPlayUX();
  }
  new MutationObserver(syncSheet).observe(sheet, { attributes: true, attributeFilter: ["class"] });
  $("setup-close").addEventListener("click", closeSheet);
  scrim.addEventListener("click", closeSheet);
  $("startCardBtn").addEventListener("click", () => sheet.classList.remove("collapsed"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sheetIsOpen() && document.body.dataset.tab === "play") closeSheet();
  });

  // ---------- opponent card in the side panel ----------
  function syncOpp() {
    const elo = parseInt(els.eloSlider.value, 10);
    const inGame = gameStarted || posHistory.length > 1;
    const mood = inGame ? (els.status.dataset.mood || "") : "";
    $("oppName").textContent = `Maia ${elo}`;
    $("oppSub").textContent = inGame ? `${levelName(elo)} · You play ${playerColor === "white" ? "White" : "Black"}` : levelName(elo);
    $("oppState").textContent = { thinking: "Thinking", yours: "Your turn", over: "Game over" }[mood] || "";
    $("oppCard").dataset.mood = mood;
  }

  // ---------- result card ----------
  const resultCard = $("resultCard");
  const resultBox = resultCard.querySelector(".overlayCard");
  let wasOver = false;

  function showResult() {
    const moves = Math.ceil((state.sanHistory || []).length / 2);
    const elo = els.eloSlider.value;
    let outcome = "draw", title = "Draw", text = "";
    if (state.status === "checkmate") {
      const won = state.winner === playerColor;
      outcome = won ? "win" : "loss";
      title = won ? "You won!" : "Maia won";
      text = won ? "Checkmate. Nicely played." : "Checkmate. Review the game to see where it turned.";
    } else if (state.status === "resigned") {
      outcome = "loss"; title = "You resigned"; text = "Review the game to see what happened.";
    } else if (state.status === "stalemate") {
      text = "Stalemate: no legal moves, but no check.";
    } else {
      text = "The game ended in a draw.";
    }
    resultBox.dataset.outcome = outcome;
    $("resultTitle").textContent = title;
    $("resultText").textContent = `${text} (${moves} move${moves === 1 ? "" : "s"} vs Maia ${elo})`;
    $("resultReview").disabled = posHistory.length <= 1;
    resultCard.hidden = false;
    $("resultReview").focus({ preventScroll: true });
  }
  const hideResult = () => { resultCard.hidden = true; };
  $("resultClose").addEventListener("click", hideResult);
  $("resultReview").addEventListener("click", () => { hideResult(); els.analyzeThisBtn.click(); });
  $("resultRematch").addEventListener("click", () => { hideResult(); els.startBtn.click(); });
  $("resultNew").addEventListener("click", () => { hideResult(); sheet.classList.remove("collapsed"); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !resultCard.hidden) hideResult(); });

  // ---------- keep the Play screen in sync ----------
  function syncPlayUX() {
    const hasGame = gameStarted || posHistory.length > 1;
    document.body.classList.toggle("noGame", !hasGame);
    els.resignBtn.disabled = !gameStarted || isGameOver();
    startCard.hidden = hasGame || sheetIsOpen();
    $("sheet-note").hidden = !(gameStarted && !isGameOver());
    syncOpp();

    const over = isGameOver();
    if (!sessionIsReady()) {          // restoring a saved game: don't pop the result card
      wasOver = over;
      hideResult();
    } else {
      if (over && !wasOver) showResult();
      if (!over || !isLive()) hideResult();
      wasOver = over;
    }
  }
  wrap("updateControls", { after: syncPlayUX });
  
  // ---------- two-step confirms (no modal, no accidental loss) ----------
  function twoStep(btn, shouldConfirm, armedText) {
    let timer = null, original = null;
    const disarm = () => {
      clearTimeout(timer); timer = null;
      btn.classList.remove("armed");
      if (original !== null) { btn.textContent = original; original = null; }
    };
    btn.addEventListener("click", (e) => {
      if (timer !== null) { disarm(); return; }            // second click: let the real handler run
      if (!shouldConfirm()) return;
      e.stopImmediatePropagation();
      original = btn.textContent;
      btn.textContent = armedText;
      btn.classList.add("armed");
      timer = setTimeout(disarm, 3500);
    }, true);
  }
  twoStep(els.resignBtn, () => gameStarted && !isGameOver(), "Tap again to resign");
  twoStep(els.startBtn, () => gameStarted && !isGameOver() && (state.sanHistory || []).length >= 2, "Abandon this game?");

  // ---------- Review: stepper, empty state, one-click flow ----------
  const steps = [...document.querySelectorAll("#reviewSteps li")];
  const reviewEmpty = $("reviewEmpty");
  function syncReview() {
    const loaded = !!loadedGame;
    const analyzed = !!analysis;
    const cur = !loaded ? 1 : !analyzed ? 2 : 3;
    steps.forEach((li, i) => {
      li.classList.toggle("done", i + 1 < cur);
      li.classList.toggle("current", i + 1 === cur);
    });
    reviewEmpty.hidden = loaded;
    az.tab.classList.toggle("analyzed", analyzed);
  }
  $("reviewPlayBtn").addEventListener("click", () => switchTab("play"));
  steps.forEach((li, i) => li.addEventListener("click", () => {
    if (i === 0) { az.loadPanel.classList.remove("collapsed"); recentPanel.classList.remove("collapsed"); az.pgnInput.focus(); }
    else if (i === 1 && loadedGame && !analysis && !az.analyzeBtn.disabled) az.analyzeBtn.click();
    else if (i === 2 && analysis && az.practiceBtn.style.display !== "none") az.practiceBtn.click();
  }));

  let autoUntil = 0;
  $("recentList").addEventListener("click", () => { autoUntil = Date.now() + 3000; }, true);
  az.loadBtn.addEventListener("click", () => { autoUntil = Date.now() + 4000; });

  wrap("loadAnalysisGame", {
    after: (_, [game]) => {
      syncReview();
      az.loadPanel.classList.add("collapsed");     // get the loaders out of the way once a game is open
      recentPanel.classList.add("collapsed");
      const wanted = sessionIsReady() && (game.myColor || Date.now() < autoUntil);
      if (!wanted || !game.sans.length) return;
      autoUntil = 0;
      setTimeout(() => {
        if (loadedGame === game && !analysis && !analyzingGame && !az.analyzeBtn.disabled) az.analyzeBtn.click();
      }, 50);
    },
  });
  ["renderFlaggedList", "renderAccuracy", "enterPuzzleMode", "exitPuzzleMode", "applyCachedAnalysis"]
    .forEach((n) => wrap(n, { after: syncReview }));

  $("pasteBtn").addEventListener("click", async () => {
    az.loadError.textContent = "";
    try {
      const t = (await navigator.clipboard.readText()).trim();
      if (!t) { az.loadError.textContent = "The clipboard is empty."; return; }
      az.pgnInput.value = t;
      az.pgnInput.focus();
    } catch {
      az.pgnInput.focus();
      az.loadError.textContent = "Couldn't read the clipboard. Click the box and press Ctrl+V (⌘V on Mac).";
    }
  });
  az.pgnInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); az.loadBtn.click(); }
  });

  syncElo();
  syncSheet();
  syncReview();
})();
