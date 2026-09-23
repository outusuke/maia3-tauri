use crate::engine::Engine;
use crate::game::move_to_san;
use crate::pgn::ParsedGame;
use chess::{Board, ChessMove, Color};
use serde::Serialize;
use std::str::FromStr;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MoveGrade {
    Good,
    Inaccuracy,
    Mistake,
    Blunder,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveAnalysis {
    pub ply: usize,
    pub san: String,
    pub uci: String,
    pub fen_before: String,
    pub fen_after: String,
    pub grade: MoveGrade,
    /// White's perspective so signs compare across plies; None for mate scores (see the mate fields).
    pub eval_before_cp: Option<i32>,
    pub eval_after_cp: Option<i32>,
    pub mate_before: Option<i32>,
    pub mate_after: Option<i32>,
    pub best_move_uci: Option<String>,
    pub best_move_san: Option<String>,
    pub best_line_san: Vec<String>,
    /// UCI moves within the "good" eval window of the best move; any of them solves the puzzle.
    pub acceptable_moves: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AnalysisConfig {
    pub depth: u32,
    pub multipv: u32,
    pub inaccuracy_cp: i32,
    pub mistake_cp: i32,
    pub blunder_cp: i32,
    pub acceptable_cp: i32,
    pub move_timeout: Duration,
}

impl Default for AnalysisConfig {
    fn default() -> Self {
        AnalysisConfig {
            depth: 14,
            multipv: 3,
            inaccuracy_cp: 50,
            mistake_cp: 100,
            blunder_cp: 300,
            acceptable_cp: 20,
            move_timeout: Duration::from_secs(60),
        }
    }
}

/// Stand-in magnitude so mate scores compare sensibly against centipawns.
const MATE_CP_MAGNITUDE: i32 = 100_000;

fn effective_cp(cp: Option<i32>, mate: Option<i32>) -> i32 {
    match mate {
        Some(m) if m > 0 => MATE_CP_MAGNITUDE - m,
        Some(m) => -MATE_CP_MAGNITUDE - m,
        None => cp.unwrap_or(0),
    }
}

fn flip_if_black(value: i32, side_to_move: Color) -> i32 {
    if side_to_move == Color::White {
        value
    } else {
        -value
    }
}

/// Reuses the top-line search for the played move's eval when it matches; otherwise runs a second single-line search.
pub fn analyze_game(
    engine: &mut Engine,
    parsed: &ParsedGame,
    start_board: Board,
    config: &AnalysisConfig,
) -> Result<Vec<MoveAnalysis>, String> {
    let mut board = start_board;
    let mut out = Vec::with_capacity(parsed.ucis.len());

    for (ply, (uci, san)) in parsed.ucis.iter().zip(parsed.sans.iter()).enumerate() {
        let fen_before = format!("{board}");
        let side_to_move = board.side_to_move();

        let lines = engine.analyze(&fen_before, config.depth, config.multipv, config.move_timeout)?;
        let best = lines
            .iter()
            .find(|l| l.multipv == 1)
            .ok_or("engine returned no best line")?;
        let best_effective = effective_cp(best.score_cp, best.mate);

        let mv = ChessMove::from_str(uci).map_err(|e| format!("bad uci '{uci}': {e}"))?;
        let played_is_best = best.pv.first().map(|m| m.as_str()) == Some(uci.as_str());

        // Eval after the played move, from the mover's perspective so it compares with `best_effective`.
        let played_effective = if played_is_best {
            best_effective
        } else {
            let after_fen = format!("{}", board.make_move_new(mv));
            let after_lines = engine.analyze(&after_fen, config.depth, 1, config.move_timeout)?;
            let after_best = after_lines
                .first()
                .ok_or("engine returned no line for the played move")?;
            // Score is from the opponent's perspective now; negate.
            -effective_cp(after_best.score_cp, after_best.mate)
        };

        let loss = (best_effective - played_effective).max(0);
        let grade = if loss < config.inaccuracy_cp {
            MoveGrade::Good
        } else if loss < config.mistake_cp {
            MoveGrade::Inaccuracy
        } else if loss < config.blunder_cp {
            MoveGrade::Mistake
        } else {
            MoveGrade::Blunder
        };

        let eval_before_cp = best.score_cp.map(|cp| flip_if_black(cp, side_to_move));
        let mate_before = best.mate.map(|m| flip_if_black(m, side_to_move));
        // Sign flips only when Black was the mover.
        let eval_after_cp = if played_is_best {
            eval_before_cp
        } else {
            Some(flip_if_black(played_effective, side_to_move))
        };
        let mate_after = if played_is_best { mate_before } else { None };

        let best_move_uci = best.pv.first().cloned();
        let best_move_san = best_move_uci.as_ref().and_then(|u| {
            ChessMove::from_str(u)
                .ok()
                .filter(|m| board.legal(*m))
                .map(|m| move_to_san(&board, m))
        });
        let best_line_san = sanify_line(&board, &best.pv);

        let acceptable_moves: Vec<String> = lines
            .iter()
            .filter(|l| {
                let eff = effective_cp(l.score_cp, l.mate);
                (best_effective - eff).max(0) < config.acceptable_cp
            })
            .filter_map(|l| l.pv.first().cloned())
            .collect();

        out.push(MoveAnalysis {
            ply,
            san: san.clone(),
            uci: uci.clone(),
            fen_before: fen_before.clone(),
            fen_after: format!("{}", board.make_move_new(mv)),
            grade,
            eval_before_cp,
            eval_after_cp,
            mate_before,
            mate_after,
            best_move_uci,
            best_move_san,
            best_line_san,
            acceptable_moves,
        });

        board = board.make_move_new(mv);
    }

    Ok(out)
}

/// Stops quietly if the PV goes illegal, which can happen right at mate.
fn sanify_line(start: &Board, ucis: &[String]) -> Vec<String> {
    let mut board = start.clone();
    let mut out = Vec::new();
    for u in ucis.iter().take(8) {
        let Ok(mv) = ChessMove::from_str(u) else {
            break;
        };
        if !board.legal(mv) {
            break;
        }
        out.push(move_to_san(&board, mv));
        board = board.make_move_new(mv);
    }
    out
}
