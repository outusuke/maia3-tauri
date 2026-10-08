mod analysis;
mod brilliant;
mod bundled;
mod engine;
mod game;
mod insights;
#[cfg(target_os = "android")]
mod native_stockfish;
mod pgn;
#[cfg(not(target_os = "android"))]
mod process_stockfish;

use analysis::{AnalysisConfig, MoveAnalysis};
use chess::{Board, Piece, Square};
use engine::Engine;
use game::{Game, GameState};
use bundled::list_models;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError, Weak};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

// a panic on one thread shouldn't brick every later command, so poisoned locks are recovered
struct AppState {
    game: Mutex<Game>,
    // bumped under the game lock so a late engine move can tell the position moved on
    generation: AtomicU64,
    engine: Mutex<Option<Engine>>,
    engine_spec: Mutex<Option<EngineSpec>>,
    // own processes, so Analyze doesn't disturb a game in progress
    stockfish: Mutex<Option<Engine>>,
    insights: Mutex<Option<Engine>>,
    insights_model: Mutex<Option<String>>,
    insights_last_used: Mutex<Instant>,
}

#[derive(Clone)]
struct EngineSpec {
    model: String,
    elo: u32,
    args: Vec<String>,
}

const INSIGHTS_IDLE: Duration = Duration::from_secs(120);
const STALE_MOVE: &str = "game changed while the engine was thinking";

// the UI tops out at depth 18 and 5 lines; these only stop a bad value from hanging Stockfish
const MAX_DEPTH: u32 = 30;
const MAX_MULTIPV: u32 = 8;
const MAX_PLIES: usize = 1024;
const MAX_CANDIDATES: usize = 32;

fn check_len(name: &str, len: usize, max: usize) -> Result<(), String> {
    if len > max {
        return Err(format!("too many {name} ({len}, max {max})"));
    }
    Ok(())
}

// Weak so the weights are freed once both engines are gone
type SessionCache = Mutex<Option<(String, usize, Weak<maia_core::Session>)>>;

fn session_cache() -> &'static SessionCache {
    static CACHE: OnceLock<SessionCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn shared_session(app: &AppHandle, model: &str, history: usize) -> Result<Arc<maia_core::Session>, String> {
    // held through the load so two spawns can't both load the model
    let mut cache = session_cache().lock().unwrap_or_else(PoisonError::into_inner);
    if let Some((name, hist, weak)) = cache.as_ref() {
        if name == model && *hist == history {
            if let Some(session) = weak.upgrade() {
                eprintln!("[engine] reusing the loaded {model} session");
                return Ok(session);
            }
        }
    }
    let source = bundled::maia_model_source(app, model)?;
    bundled::configure_ort(app)?;
    let session = Arc::new(maia_core::Session::load(&source, history)?);
    drop(source);
    *cache = Some((model.to_string(), history, Arc::downgrade(&session)));
    Ok(session)
}

fn spawn_maia(app: &AppHandle, model: &str, extra_args: Vec<String>) -> Result<Engine, String> {
    let mut args: Vec<String> = vec!["--history".into(), "8".into(), "--use-uci-history".into()];
    args.extend(extra_args);
    let history = maia_core::Config::from_args(&args).history;
    let session = shared_session(app, model, history)?;
    Engine::spawn_maia(maia_core::ModelSource::Shared(session), &args)
}

// the idle reaper may have shut it down
fn insights_slot<'a>(
    app: &AppHandle,
    state: &'a AppState,
) -> Result<MutexGuard<'a, Option<Engine>>, String> {
    let mut slot = state.insights.lock().unwrap_or_else(PoisonError::into_inner);
    if slot.is_none() {
        let model = state
            .insights_model
            .lock().unwrap_or_else(PoisonError::into_inner)
            .clone()
            .ok_or("Maia insights engine is not running")?;
        *slot = Some(spawn_maia(app, &model, vec!["--threads".into(), "2".into()])?);
    }
    *state.insights_last_used.lock().unwrap_or_else(PoisonError::into_inner) = Instant::now();
    Ok(slot)
}

fn revive_engine(app: &AppHandle, state: &AppState, slot: &mut Option<Engine>) -> Result<(), String> {
    if slot.is_some() {
        return Ok(());
    }
    let spec = state.engine_spec.lock().unwrap_or_else(PoisonError::into_inner).clone();
    if let Some(spec) = spec {
        let mut eng = spawn_maia(app, &spec.model, spec.args)?;
        eng.set_elo(spec.elo)?;
        *slot = Some(eng);
    }
    Ok(())
}

fn release_engine_if_over(state: &AppState, gs: &GameState) {
    if gs.status != "ongoing" {
        *state.engine_spec.lock().unwrap_or_else(PoisonError::into_inner) = None;
        *state.engine.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }
}

fn parse_promotion(p: Option<String>) -> Option<Piece> {
    match p.as_deref() {
        Some("q") => Some(Piece::Queen),
        Some("r") => Some(Piece::Rook),
        Some("b") => Some(Piece::Bishop),
        Some("n") => Some(Piece::Knight),
        _ => None,
    }
}

#[tauri::command]
fn new_game(state: State<AppState>, fen: Option<String>) -> Result<GameState, String> {
    let mut game = state.game.lock().unwrap_or_else(PoisonError::into_inner);
    *game = match fen {
        Some(f) if !f.trim().is_empty() => Game::from_fen(&f)?,
        _ => Game::new(),
    };
    state.generation.fetch_add(1, Ordering::SeqCst);
    Ok(game.state())
}

#[tauri::command]
fn legal_targets(state: State<AppState>, square: String) -> Result<Vec<String>, String> {
    let sq = Square::from_str(&square).map_err(|e| e.to_string())?;
    let game = state.game.lock().unwrap_or_else(PoisonError::into_inner);
    Ok(game.legal_targets(sq))
}

#[tauri::command]
fn make_move(
    state: State<AppState>,
    from: String,
    to: String,
    promotion: Option<String>,
) -> Result<GameState, String> {
    let from_sq = Square::from_str(&from).map_err(|e| e.to_string())?;
    let to_sq = Square::from_str(&to).map_err(|e| e.to_string())?;
    let promo = parse_promotion(promotion);
    let gs = {
        let mut game = state.game.lock().unwrap_or_else(PoisonError::into_inner);
        game.try_move(from_sq, to_sq, promo)?;
        state.generation.fetch_add(1, Ordering::SeqCst);
        game.state()
    };
    release_engine_if_over(&state, &gs);
    Ok(gs)
}

// a plain sync command runs on the UI thread, so anything that can wait on an engine lock is async
#[tauri::command(async)]
// `command` is the model id
fn start_engine(
    app: AppHandle,
    state: State<AppState>,
    command: String,
    elo: u32,
    extra_args: Option<Vec<String>>,
) -> Result<(), String> {
    let mut slot = state.engine.lock().unwrap_or_else(PoisonError::into_inner);
    // the old engine quits when dropped
    *slot = None;

    let extra_args = extra_args.unwrap_or_default();
    let mut eng = spawn_maia(&app, &command, extra_args.clone())?;
    eng.set_elo(elo)?;
    *slot = Some(eng);
    *state.engine_spec.lock().unwrap_or_else(PoisonError::into_inner) =
        Some(EngineSpec { model: command, elo, args: extra_args });
    Ok(())
}

#[tauri::command(async)]
fn start_insights_engine(
    app: AppHandle,
    state: State<AppState>,
    command: String,
) -> Result<(), String> {
    *state.insights_model.lock().unwrap_or_else(PoisonError::into_inner) = Some(command);
    drop(insights_slot(&app, state.inner())?);
    Ok(())
}

#[tauri::command(async)]
fn human_moves(
    app: AppHandle,
    state: State<AppState>,
    start_fen: String,
    ucis: Vec<String>,
    played: Option<String>,
    ratings: Vec<u32>,
    rating: u32,
) -> Result<insights::HumanMoves, String> {
    let mut slot = insights_slot(&app, state.inner())?;
    let maia = slot.as_mut().ok_or("Maia insights engine is not running")?;
    insights::human_moves(maia, &start_fen, &ucis, played.as_deref(), &ratings, rating)
}

#[tauri::command(async)]
fn score_human_moves(
    state: State<AppState>,
    start_fen: String,
    ucis: Vec<String>,
    moves: Vec<String>,
    depth: Option<u32>,
) -> Result<insights::MoveScores, String> {
    check_len("moves", ucis.len(), MAX_PLIES)?;
    check_len("candidates", moves.len(), MAX_CANDIDATES)?;
    let depth = depth.unwrap_or(10).clamp(1, MAX_DEPTH);
    let mut slot = state.stockfish.lock().unwrap_or_else(PoisonError::into_inner);
    let sf = slot.as_mut().ok_or("stockfish is not running")?;
    insights::score_moves(sf, &start_fen, &ucis, &moves, depth)
}

#[tauri::command]
fn stop_engine(state: State<AppState>) -> Result<(), String> {
    *state.engine_spec.lock().unwrap_or_else(PoisonError::into_inner) = None;
    {
        let _game = state.game.lock().unwrap_or_else(PoisonError::into_inner);
        state.generation.fetch_add(1, Ordering::SeqCst);
    }
    // a search in flight keeps the lock; its move is discarded and the next start_engine replaces it
    if let Ok(mut slot) = state.engine.try_lock() {
        *slot = None;
    }
    Ok(())
}

#[tauri::command]
fn set_engine_elo(state: State<AppState>, elo: u32) -> Result<(), String> {
    let mut spec = state.engine_spec.lock().unwrap_or_else(PoisonError::into_inner);
    let spec = spec.as_mut().ok_or("engine not running")?;
    spec.elo = elo;
    // mid-search the lock is taken; engine_move re-applies spec.elo before the next move
    if let Ok(mut slot) = state.engine.try_lock() {
        if let Some(eng) = slot.as_mut() {
            eng.set_elo(elo)?;
        }
    }
    Ok(())
}

// try_lock leaves a search in flight alone
#[tauri::command]
fn suspend_engines(state: State<AppState>) -> Result<(), String> {
    let has_spec = state.engine_spec.lock().unwrap_or_else(PoisonError::into_inner).is_some();
    if has_spec {
        if let Ok(mut slot) = state.engine.try_lock() {
            *slot = None;
        }
    }
    if let Ok(mut slot) = state.insights.try_lock() {
        *slot = None;
    }
    Ok(())
}

#[tauri::command(async)]
fn resume_engines(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let mut slot = state.engine.lock().unwrap_or_else(PoisonError::into_inner);
    revive_engine(&app, state.inner(), &mut slot)
}

#[tauri::command(async)]
fn engine_move(app: AppHandle, state: State<AppState>) -> Result<GameState, String> {
    let (start_fen, moves, generation) = {
        let game = state.game.lock().unwrap_or_else(PoisonError::into_inner);
        let (start_fen, moves) = game.uci_history();
        (start_fen.to_string(), moves.to_vec(), state.generation.load(Ordering::SeqCst))
    };

    let uci_move = {
        let mut slot = state.engine.lock().unwrap_or_else(PoisonError::into_inner);
        revive_engine(&app, state.inner(), &mut slot)?;
        let elo = state.engine_spec.lock().unwrap_or_else(PoisonError::into_inner).as_ref().map(|s| s.elo);
        let eng = slot.as_mut().ok_or("engine not running")?;
        if let Some(elo) = elo {
            eng.set_elo(elo)?;
        }
        eng.best_move(&start_fen, &moves, Duration::from_secs(30))?
    };

    let gs = {
        let mut game = state.game.lock().unwrap_or_else(PoisonError::into_inner);
        if state.generation.load(Ordering::SeqCst) != generation {
            return Err(STALE_MOVE.into());
        }
        game.try_move_uci(&uci_move)?;
        game.state()
    };
    release_engine_if_over(&state, &gs);
    Ok(gs)
}

#[tauri::command]
fn undo_move(state: State<AppState>) -> Result<GameState, String> {
    let mut game = state.game.lock().unwrap_or_else(PoisonError::into_inner);
    game.undo()?;
    state.generation.fetch_add(1, Ordering::SeqCst);
    Ok(game.state())
}

#[tauri::command(async)]
fn start_stockfish(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    let _ = &app;
    let mut slot = state.stockfish.lock().unwrap_or_else(PoisonError::into_inner);
    *slot = None;
    #[cfg(target_os = "android")]
    let eng = Engine::spawn_native_stockfish()?;
    #[cfg(not(target_os = "android"))]
    let eng = Engine::spawn_process_stockfish(&bundled::stockfish_binary(&app)?)?;
    *slot = Some(eng);
    Ok(())
}

#[tauri::command(async)]
fn stockfish_running(state: State<AppState>) -> Result<bool, String> {
    let slot = state.stockfish.lock().unwrap_or_else(PoisonError::into_inner);
    Ok(slot.is_some())
}

/// One live-analysis line; scores are from White's perspective so the eval doesn't flip with the side to move.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveLine {
    multipv: u32,
    depth: u32,
    score_cp: Option<i32>,
    mate: Option<i32>,
    sans: Vec<String>,
    ucis: Vec<String>,
    fens: Vec<String>,
}

#[tauri::command(async)]
fn engine_lines(
    state: State<AppState>,
    fen: String,
    depth: u32,
    multipv: u32,
) -> Result<Vec<LiveLine>, String> {
    let depth = depth.clamp(1, MAX_DEPTH);
    let multipv = multipv.clamp(1, MAX_MULTIPV);
    let board = Board::from_str(&fen).map_err(|e| format!("invalid FEN: {e}"))?;
    let sign = if board.side_to_move() == chess::Color::White { 1 } else { -1 };

    let mut slot = state.stockfish.lock().unwrap_or_else(PoisonError::into_inner);
    let eng = slot.as_mut().ok_or("stockfish is not running")?;
    let mut lines = eng.analyze(&fen, depth, multipv, Duration::from_secs(60))?;
    lines.sort_by_key(|l| l.multipv);

    Ok(lines
        .into_iter()
        .map(|l| {
            let (sans, ucis, fens) = analysis::sanify_line(&board, &l.pv);
            LiveLine {
                multipv: l.multipv,
                depth: l.depth,
                score_cp: l.score_cp.map(|cp| cp * sign),
                mate: l.mate.map(|m| m * sign),
                sans,
                ucis,
                fens,
            }
        })
        .collect())
}

/// Backs "Analyze This Game" so a played game skips the PGN round trip.
#[tauri::command(async)]
fn analyze_moves(
    state: State<AppState>,
    sans: Vec<String>,
    start_fen: Option<String>,
    depth: Option<u32>,
    multipv: Option<u32>,
) -> Result<Vec<MoveAnalysis>, String> {
    check_len("moves", sans.len(), MAX_PLIES)?;
    let parsed = pgn::parse_sans(&sans, start_fen.as_deref())?;
    let start_board =
        Board::from_str(&parsed.start_fen).map_err(|e| format!("invalid start FEN: {e}"))?;

    let mut config = AnalysisConfig::default();
    if let Some(d) = depth {
        config.depth = d.clamp(1, MAX_DEPTH);
    }
    if let Some(mpv) = multipv {
        config.multipv = mpv.clamp(1, MAX_MULTIPV);
    }

    let mut slot = state.stockfish.lock().unwrap_or_else(PoisonError::into_inner);
    let eng = slot.as_mut().ok_or("stockfish is not running")?;
    analysis::analyze_game(eng, &parsed, start_board, &config)
}

#[tauri::command]
fn parse_pgn(pgn_text: String) -> Result<pgn::ParsedGame, String> {
    pgn::parse_pgn(&pgn_text)
}

#[tauri::command]
fn validate_fen(fen: String) -> Result<(), String> {
    game::validate_fen(&fen)
}

#[tauri::command]
fn scratch_legal_targets(fen: String, square: String) -> Result<Vec<String>, String> {
    let sq = Square::from_str(&square).map_err(|e| e.to_string())?;
    game::scratch_legal_targets(&fen, sq)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ScratchMoveResult {
    fen: String,
    san: String,
    uci: String,
}

#[tauri::command]
fn scratch_try_move(
    fen: String,
    from: String,
    to: String,
    promotion: Option<String>,
) -> Result<ScratchMoveResult, String> {
    let from_sq = Square::from_str(&from).map_err(|e| e.to_string())?;
    let to_sq = Square::from_str(&to).map_err(|e| e.to_string())?;
    let promo = parse_promotion(promotion);
    let (fen, san, uci) = game::scratch_try_move(&fen, from_sq, to_sq, promo)?;
    Ok(ScratchMoveResult { fen, san, uci })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            game: Mutex::new(Game::new()),
            generation: AtomicU64::new(0),
            engine: Mutex::new(None),
            engine_spec: Mutex::new(None),
            stockfish: Mutex::new(None),
            insights: Mutex::new(None),
            insights_model: Mutex::new(None),
            insights_last_used: Mutex::new(Instant::now()),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(15));
                let state = handle.state::<AppState>();
                let idle = state
                    .insights_last_used
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .elapsed()
                    > INSIGHTS_IDLE;
                if idle {
                    if let Ok(mut slot) = state.insights.try_lock() {
                        if slot.is_some() {
                            eprintln!("[insights] idle, shutting down");
                            *slot = None;
                        }
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            new_game,
            legal_targets,
            make_move,
            undo_move,
            start_engine,
            stop_engine,
            start_insights_engine,
            human_moves,
            score_human_moves,
            set_engine_elo,
            suspend_engines,
            resume_engines,
            engine_move,
            start_stockfish,
            stockfish_running,
            engine_lines,
            analyze_moves,
            parse_pgn,
            validate_fen,
            scratch_legal_targets,
            scratch_try_move,
            list_models,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Maia Chess")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<AppState>();
                *state.engine.lock().unwrap_or_else(PoisonError::into_inner) = None;
                *state.stockfish.lock().unwrap_or_else(PoisonError::into_inner) = None;
                *state.insights.lock().unwrap_or_else(PoisonError::into_inner) = None;
            }
        });
}
