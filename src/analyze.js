const az = {
  board: document.getElementById("analyzeBoard"),
  promo: document.getElementById("analyzePromo"),
  flipBtn: document.getElementById("aFlipBtn"),
  evalGraph: document.getElementById("evalGraph"),
  evalBox: document.getElementById("evalGraphBox"),
  evalInfo: document.getElementById("evalInfo"),
  evalLine: document.getElementById("evalLine"),
  evalLegend: document.getElementById("evalLegend"),
  pgnInput: document.getElementById("pgnInput"),
  loadBtn: document.getElementById("loadGameBtn"),
  loadError: document.getElementById("loadError"),
  sideSelect: document.getElementById("analyzeSideSelect"),
  depthSelect: document.getElementById("analyzeDepthSelect"),
  analyzeBtn: document.getElementById("analyzeGameBtn"),
  analyzeStatus: document.getElementById("analyzeStatus"),
  sidebar: document.getElementById("analyzeSidebar"),
  loadPanel: document.getElementById("loadPanel"),
  controlsPanel: document.getElementById("analyzeControlsPanel"),
  moveListPanel: document.getElementById("moveListPanel"),
  moveList: document.getElementById("analyzeMoveList"),
  flaggedPanel: document.getElementById("flaggedPanel"),
  flaggedList: document.getElementById("flaggedList"),
  flaggedHeading: document.getElementById("flaggedHeading"),
  flaggedCount: document.getElementById("flaggedCount"),
  practiceSideRow: document.getElementById("practiceSideRow"),
  practiceSideSelect: document.getElementById("practiceSideSelect"),
  practiceBtn: document.getElementById("practiceBtn"),
  navStart: document.getElementById("aNavStart"),
  navPrev: document.getElementById("aNavPrev"),
  navNext: document.getElementById("aNavNext"),
  navEnd: document.getElementById("aNavEnd"),
  puzzlePanel: document.getElementById("puzzlePanelV2"),
  puzzleProgress: document.getElementById("puzzleProgressV2"),
  puzzlePrompt: document.getElementById("puzzlePromptV2"),
  puzzleFeedback: document.getElementById("puzzleFeedbackV2"),
  puzzleActiveActions: document.getElementById("puzzleActiveActions"),
  puzzleDoneActions: document.getElementById("puzzleDoneActions"),
  puzzleRevealBtn: document.getElementById("puzzleRevealBtn"),
  puzzleBackBtn: document.getElementById("puzzleBackBtn"),
  puzzleExitBtn: document.getElementById("puzzleExitBtn"),
  puzzleExitBtn2: document.getElementById("puzzleExitBtn2"),
  puzzleRestartBtn: document.getElementById("puzzleRestartBtn"),
  puzzleNextBtn: document.getElementById("puzzleNextBtn"),
  arrowToggle: document.getElementById("aArrowToggle"),
  variationBar: document.getElementById("variationBar"),
  variationTitle: document.getElementById("variationTitle"),
  variationLine: document.getElementById("variationLine"),
  variationExitBtn: document.getElementById("variationExitBtn"),
  materialTop: document.getElementById("aMaterialTop"),
  materialBottom: document.getElementById("aMaterialBottom"),
};

let loadedGame = null;      // {startFen, sans, fens}
let analysis = null;        // Vec<MoveAnalysis> from analyze_moves
let azViewPly = 0;          // 0 = start position, i = after sans[i-1]
let azFlipped = false;      // Analyze board orientation (true = Black at the bottom)
let stockfishStarted = false;
// Side line off the game: an engine line being previewed, or the user's own moves.
// { ply, m, fens, ucis, idx, free?, sans? } — `free` lines can be branched by moving pieces.
let variation = null;

const eng = {
  enable: document.getElementById("engEnable"),
  lines: document.getElementById("engLines"),
  note: document.getElementById("engNote"),
  body: document.getElementById("engBody"),
  score: document.getElementById("engScore"),
  barFill: document.getElementById("engBarFill"),
  status: document.getElementById("engStatus"),
  list: document.getElementById("engList"),
  arrows: document.getElementById("engArrows"),
};
const ENG_DEBOUNCE_MS = 250;
const ENG_DEPTH = 10;
let engToken = 0;
let engKey = null;     // position/settings the current search belongs to
let engLive = null;    // { key, lines } latest result for the arrow and list
let analyzingGame = false;
const engCache = new Map();
// Remainders of searched lines, so stepping along one shows something instantly.
const engSeed = new Map();
let analysisDepth = 0;

function engSeedLine(startFen, line, depth) {
  if (line.mate !== null && line.mate !== undefined) return;   // mate distances change along the line
  const fens = [startFen].concat(line.fens || []);
  for (let k = 0; k < line.ucis.length && depth - k >= 6; k++) {
    const key = fenKey(fens[k]);
    const have = engSeed.get(key);
    if (have && have.depth >= depth - k) continue;
    engSeed.set(key, {
      depth: depth - k,
      lines: [{
        multipv: 1, depth: depth - k, scoreCp: line.scoreCp, mate: null,
        sans: line.sans.slice(k), ucis: line.ucis.slice(k), fens: (line.fens || []).slice(k),
      }],
    });
  }
}

let azSelected = null;
let azTargets = [];
let azSelFen = null;
