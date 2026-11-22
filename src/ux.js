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

  // ---------- opponent strength: presets ----------
  const PRESETS = [800, 1200, 1500, 2000, 2400];

  const presetBox = $("elo-presets");
  PRESETS.forEach((elo) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.elo = String(elo);
    b.textContent = String(elo);
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
    presetBox.querySelectorAll("button").forEach((b) => b.classList.toggle("active", Number(b.dataset.elo) === elo));
    relabelStrips();
    syncOpp();
  }
  els.eloSlider.addEventListener("input", syncElo);
  els.eloBlackSlider.addEventListener("input", syncElo);
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
      const label = selfPlay ? `Maia-3 ${eloOf(color)}` : color === playerColor ? "You" : `Maia-3 ${els.eloSlider.value}`;
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
    if (/^(Checkmate|Draw|You resigned|Time out)/.test(t)) return "over";
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

  // ---------- New game panel: inline on wide minimal layouts, a modal / bottom sheet elsewhere ----------
  const sheet = els.setupPanel;
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

  // ---------- one-line recap of the Settings choices on the New game sheet ----------
  function syncSheetSummary() {
    const side = els.sideSelect.querySelector("button.active");
    const time = els.timeSelect.querySelector("button.active");
    const strength = side && side.dataset.value === "selfplay" ? `Maia ${els.eloSlider.value} vs ${els.eloBlackSlider.value}` : `Maia ${els.eloSlider.value}`;
    const sideText = side && side.dataset.value === "selfplay" ? "Watching" : side ? side.textContent : "Random";
    $("sheet-summary").textContent = `${strength} · ${sideText} · ${time ? time.textContent : "None"}  ·  Change in Settings`;
  }
  [els.eloSlider, els.eloBlackSlider, els.sideSelect, els.timeSelect].forEach((el) => {
    el.addEventListener("input", syncSheetSummary);
    el.addEventListener("click", () => setTimeout(syncSheetSummary));
  });

  // ---------- opponent card in the side panel ----------
  function syncOpp() {
    const elo = parseInt(els.eloSlider.value, 10);
    const inGame = gameStarted || posHistory.length > 1;
    const mood = inGame ? (els.status.dataset.mood || "") : "";
    $("oppName").textContent = selfPlay ? `Maia-3 · ${elo} vs ${eloOf("black")}` : `Maia-3 · ${elo}`;
    $("oppSub").textContent = selfPlay ? (inGame ? "White vs Black" : "") : inGame ? `You play ${playerColor === "white" ? "White" : "Black"}` : "";
    $("oppState").textContent = (selfPlay && selfPlayPaused && !isGameOver()) ? "Paused" : { thinking: "Thinking", yours: "Your turn", over: "Game over" }[mood] || "";
    $("oppCard").dataset.mood = mood;
    document.body.classList.toggle("watching", selfPlay);
  }

  // ---------- result card ----------
  const resultCard = $("resultCard");
  const resultBox = resultCard.querySelector(".overlayCard");
  let wasOver = false;

  function showResult() {
    const moves = Math.ceil((state.sanHistory || []).length / 2);
    const elo = els.eloSlider.value;
    let outcome = "draw", title = "Draw", text = "";
    if (selfPlay) {
      const w = state.winner === "white" ? "White" : "Black";
      outcome = "draw";
      title = state.winner ? `${w} wins` : "Draw";
      text = state.status === "checkmate" ? `Checkmate by ${w} (Maia ${eloOf(state.winner)}).`
        : state.status === "timeout" ? `${w} wins on time.`
        : state.status === "stalemate" ? "Stalemate: no legal moves, but no check." : "The game ended in a draw.";
    } else if (state.status === "checkmate") {
      const won = state.winner === playerColor;
      outcome = won ? "win" : "loss";
      title = won ? "You won!" : "Maia won";
      text = won ? "Checkmate. Nicely played." : "Checkmate. Review the game to see where it turned.";
    } else if (state.status === "resigned") {
      outcome = "loss"; title = "You resigned"; text = "Review the game to see what happened.";
    } else if (state.status === "timeout") {
      const won = state.winner === playerColor;
      outcome = won ? "win" : "loss"; title = won ? "You won on time" : "Out of time"; text = won ? "Maia ran out of time." : "Your clock ran out.";
    } else if (state.status === "stalemate") {
      text = "Stalemate: no legal moves, but no check.";
    } else {
      text = "The game ended in a draw.";
    }
    resultBox.dataset.outcome = outcome;
    $("resultTitle").textContent = title;
    $("resultText").textContent = selfPlay
      ? `${text} (${moves} move${moves === 1 ? "" : "s"}, Maia ${eloOf("white")} vs Maia ${eloOf("black")})`
      : `${text} (${moves} move${moves === 1 ? "" : "s"} vs Maia ${elo})`;
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
    els.resignBtn.hidden = selfPlay;
    els.pauseBtn.hidden = !selfPlay;
    els.pauseBtn.disabled = !gameStarted || isGameOver();
    startCard.hidden = hasGame || sheetIsOpen();
    $("sheet-note").hidden = !(gameStarted && !isGameOver());
    syncSheetSummary();
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
      const t = (await clip.read()).trim();
      if (!t) { az.loadError.textContent = "The clipboard is empty."; return; }
      az.pgnInput.value = t;
      az.pgnInput.focus();
    } catch {
      az.pgnInput.focus();
      az.loadError.textContent = "Couldn't read the clipboard. Click the box and press Ctrl+V (⌘V on Mac).";
    }
  });
  $("clearPgnBtn").addEventListener("click", () => {
    az.pgnInput.value = "";
    az.loadError.textContent = "";
    az.pgnInput.focus();
  });
  // Ctrl+V anywhere on Review (outside a field) reopens the Load panel with the text in it
  document.addEventListener("paste", (e) => {
    if (document.body.dataset.tab !== "analyze") return;
    if (e.target.closest("input, textarea, select, [contenteditable]")) return;
    const t = (e.clipboardData?.getData("text") || "").trim();
    if (!t) return;
    e.preventDefault();
    az.loadPanel.classList.remove("collapsed");
    az.pgnInput.value = t;
    az.loadError.textContent = "";
    az.pgnInput.focus();
  });
  az.pgnInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); az.loadBtn.click(); }
  });

  const navStatus = $("navStatus");
  function syncNavStatus() {
    const model = activeModelStore.get();
    navStatus.textContent = activeModelReady && model ? `Offline · ${model}` : "Offline";
  }
  new MutationObserver(syncNavStatus).observe(els.activeModelName, { childList: true, characterData: true, subtree: true });

  const practiceTab = $("tabBtnPractice");
  function syncPracticeNav() {
    const practicing = document.body.dataset.tab === "analyze" && puzzleMode;
    document.body.classList.toggle("practicing", practicing);
    practiceTab.classList.toggle("active", practicing);
  }
  practiceTab.addEventListener("click", () => {
    switchTab("analyze");
    if (puzzleMode) return;
    const ready = analysis && az.practiceBtn.style.display !== "none" && !az.practiceBtn.disabled;
    if (ready) az.practiceBtn.click();
    else (loadedGame ? az.analyzeStatus : az.loadError).textContent = analysis ? "No mistakes to practice in this game." : "Analyze a game first, then practice its mistakes.";
  });
  wrap("switchTab", { after: syncPracticeNav });
  ["enterPuzzleMode", "exitPuzzleMode"].forEach((n) => wrap(n, { after: syncPracticeNav }));

  function showLoader() {
    az.loadPanel.classList.remove("collapsed");
    recentPanel.classList.remove("collapsed");
    az.pgnInput.focus({ preventScroll: true });
    az.loadPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  $("import-link").addEventListener("click", () => { switchTab("analyze"); showLoader(); });
  $("importAnotherBtn").addEventListener("click", showLoader);

  const drop = $("pgnDrop"), fileIn = $("pgnFile");
  async function readPgnFile(file) {
    if (!file) return;
    try {
      az.pgnInput.value = await file.text();
      az.loadError.textContent = "";
      az.pgnInput.dispatchEvent(new Event("input"));
    } catch {
      az.loadError.textContent = "Couldn't read that file.";
    }
  }
  fileIn.addEventListener("change", () => readPgnFile(fileIn.files[0]));
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => readPgnFile(e.dataTransfer.files[0]));

  // movetext tokens only: headers, comments, move numbers and results don't count
  function approxPlies(text) {
    const moves = text.replace(/^\s*\[.*\]\s*$/gm, " ").replace(/\{[^}]*\}|;.*$/gm, " ").replace(/\d+\.(\.\.)?/g, " ")
      .split(/\s+/).filter((t) => t && !/^(1-0|0-1|1\/2-1\/2|\*|\$\d+)$/.test(t));
    return moves.length;
  }
  const est = $("analyzeEst");
  function syncEst() {
    $("depthVal").textContent = az.depthSelect.value;
    const plies = loadedGame ? loadedGame.sans.length : approxPlies(az.pgnInput.value);
    est.hidden = !plies;
    if (!plies) return;
    const cap = analyzeOpts.capSecs, depth = az.depthSelect.value;
    if (cap) {
      const mins = Math.max(1, Math.ceil((plies * 2 * cap) / 60));
      est.className = "est";
      est.innerHTML = `Worst case: <b>≤ ${mins} min</b> (${plies} moves × 2 searches × ${cap}s cap). Usually much faster, since a search stops early once it reaches depth ${depth}.`;
    } else {
      est.className = "est warn";
      est.innerHTML = `<b>No upper limit.</b> Depth ${depth} with no time cap can take a very long time on older CPUs.`;
    }
  }
  function chips(box, key, attr) {
    box.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      box.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      analyzeOpts[key] = Number(b.dataset[attr]);
      syncEst();
    });
  }
  chips($("lineChips"), "lines", "lines");
  chips($("capChips"), "capSecs", "cap");
  az.depthSelect.addEventListener("input", syncEst);
  az.pgnInput.addEventListener("input", () => {
    if (!loadedGame) az.analyzeBtn.disabled = !az.pgnInput.value.trim();
    syncEst();
  });
  // before a game is loaded the Analyze button loads the pasted PGN, which then analyzes itself
  az.analyzeBtn.addEventListener("click", (e) => {
    if (loadedGame) return;
    e.stopImmediatePropagation();
    az.loadBtn.click();
  }, true);
  wrap("loadAnalysisGame", { after: syncEst });

  const evalBar = $("evalBar"), evalFill = $("evalBarFill");
  function syncEvalBar() {
    evalBar.hidden = !analysis || analysis.length === 0;
    if (evalBar.hidden) return;
    const ply = Math.min(azViewPly, analysis.length);
    const cp = ply === 0
      ? evalWhiteCp(analysis[0].evalBeforeCp, analysis[0].mateBefore)
      : evalWhiteCp(analysis[ply - 1].evalAfterCp, analysis[ply - 1].mateAfter);
    evalFill.style.height = `${evalWinPct(cp)}%`;
    evalBar.classList.toggle("flipped", azFlipped);
  }
  ["renderAnalyzeBoard", "renderAccuracy", "loadAnalysisGame"].forEach((n) => wrap(n, { after: syncEvalBar }));

  // Review choices live in Settings now, so they are remembered across launches
  const REVIEW_PREFS_KEY = "maia3.reviewPrefs";
  function saveReviewPrefs() {
    try {
      localStorage.setItem(REVIEW_PREFS_KEY, JSON.stringify({
        depth: az.depthSelect.value, lines: analyzeOpts.lines, cap: analyzeOpts.capSecs,
        engLines: eng.lines.value, hiRating: hi.rating.value,
        threads: $("sfThreads").value, hash: $("sfHash").value,
      }));
    } catch {}
  }
  const sfThreads = $("sfThreads"), sfHash = $("sfHash");
  const maxThreads = Math.max(1, navigator.hardwareConcurrency || 1);
  sfThreads.innerHTML = `<option value="">Auto (half the cores)</option>` +
    Array.from({ length: maxThreads }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("");
  const pushStockfishOptions = () => {
    invoke("set_stockfish_options", {
      threads: sfThreads.value ? Number(sfThreads.value) : null,
      hashMb: sfHash.value ? Number(sfHash.value) : null,
    }).catch(() => {});
  };
  function loadReviewPrefs() {
    let p = null;
    try { p = JSON.parse(localStorage.getItem(REVIEW_PREFS_KEY)); } catch {}
    if (!p) return;
    if (p.depth) az.depthSelect.value = p.depth;
    $("lineChips").querySelector(`button[data-lines="${p.lines}"]`)?.click();
    $("capChips").querySelector(`button[data-cap="${p.cap}"]`)?.click();
    if (p.engLines) eng.lines.value = p.engLines;
    if (p.threads && Number(p.threads) <= maxThreads) sfThreads.value = p.threads;
    if (p.hash) sfHash.value = p.hash;
    if (sfThreads.value || sfHash.value) pushStockfishOptions();
    if (p.hiRating && [...hi.rating.options].some((o) => o.value === String(p.hiRating))) hi.rating.value = p.hiRating;
  }
  loadReviewPrefs();
  [az.depthSelect, eng.lines, hi.rating, sfThreads, sfHash].forEach((el) => el.addEventListener("change", saveReviewPrefs));
  [sfThreads, sfHash].forEach((el) => el.addEventListener("change", pushStockfishOptions));
  az.depthSelect.addEventListener("input", saveReviewPrefs);
  ["lineChips", "capChips"].forEach((id) => $(id).addEventListener("click", saveReviewPrefs));

  syncElo();
  syncSheet();
  syncReview();
  syncNavStatus();
  syncPracticeNav();
  syncEvalBar();
  syncEst();
})();
