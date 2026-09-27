use crate::engine::Engine;
use crate::game::move_to_san;
use crate::pgn::ParsedGame;
use chess::{BitBoard, Board, ChessMove, Color, MoveGen, Piece, Square};
use serde::Serialize;
use std::str::FromStr;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MoveGrade {
    /// Good, but also sacrifices material the opponent could win back — engine says it's still fine.
    Brilliant,
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
    /// UCI form of `best_line_san`, used for arrows.
    pub best_line_uci: Vec<String>,
    /// Position after each line move, so the UI can step through it.
    pub best_line_fens: Vec<String>,
    /// UCI moves within the "good" eval window of the best move; any of them solves the puzzle.
    pub acceptable_moves: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AnalysisConfig {
    pub depth: u32,
    pub multipv: u32,
    // Winning-chances units (-1..1), same scale and constants Lichess grades moves on.
    pub inaccuracy_wc: f64,
    pub mistake_wc: f64,
    pub blunder_wc: f64,
    pub acceptable_cp: i32,
    pub move_timeout: Duration,
    /// Material (pawn=1..queen=9) the opponent must be able to win back to count as a sacrifice.
    pub brilliant_min_sacrifice: i32,
}

impl Default for AnalysisConfig {
    fn default() -> Self {
        AnalysisConfig {
            depth: 14,
            multipv: 3,
            inaccuracy_wc: 0.1,
            mistake_wc: 0.2,
            blunder_wc: 0.3,
            acceptable_cp: 20,
            move_timeout: Duration::from_secs(60),
            brilliant_min_sacrifice: 3,
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

// lichess's cp->winning-chances curve; saturates near the edges so a shuffle in a won endgame isn't a "blunder"
fn winning_chances(effective_cp: i32) -> f64 {
    2.0 / (1.0 + (-0.004 * effective_cp as f64).exp()) - 1.0
}

fn flip_if_black(value: i32, side_to_move: Color) -> i32 {
    if side_to_move == Color::White {
        value
    } else {
        -value
    }
}

fn piece_value(piece: Piece) -> i32 {
    match piece {
        Piece::Pawn => 1,
        Piece::Knight | Piece::Bishop => 3,
        Piece::Rook => 5,
        Piece::Queen => 9,
        Piece::King => 0,
    }
}

/// Flips side-to-move via a null move; `None` if that side is in check and can't get a free move.
fn board_for_side(board: &Board, side: Color) -> Option<Board> {
    if board.side_to_move() == side {
        Some(*board)
    } else {
        board.null_move()
    }
}

/// Static exchange eval: material `side_to_move` nets capturing on `sq` with cheapest-piece-first,
/// both sides bailing out once recapturing would lose them material.
fn see_on_square(board: &Board, sq: Square, side_to_move: Color) -> i32 {
    let Some(b) = board_for_side(board, side_to_move) else {
        return 0;
    };
    let Some(captured) = b.piece_on(sq) else {
        return 0;
    };

    let mut attackers = MoveGen::new_legal(&b);
    attackers.set_iterator_mask(BitBoard::from_square(sq));
    let cheapest = attackers
        .filter_map(|mv| b.piece_on(mv.get_source()).map(|p| (mv, piece_value(p))))
        .min_by_key(|(_, value)| *value);

    let Some((mv, _)) = cheapest else {
        return 0;
    };

    let after = b.make_move_new(mv);
    let reply = see_on_square(&after, sq, !side_to_move);
    (piece_value(captured) - reply).max(0)
}

/// A forced move can't be a sacrifice — there was nothing else to play.
fn has_a_choice(board: &Board) -> bool {
    MoveGen::new_legal(board).count() > 1
}

/// True if the played (already-Good) move also hangs real material for the opponent to win back.
fn is_brilliant_sacrifice(
    board_before: &Board,
    board_after: &Board,
    mv: ChessMove,
    mover: Color,
    min_sacrifice: i32,
) -> bool {
    if mv.get_promotion().is_some() {
        return false;
    }
    if !has_a_choice(board_before) {
        return false;
    }
    let captured_value = board_before
        .piece_on(mv.get_dest())
        .map(piece_value)
        .unwrap_or(0);
    let opponent_see = see_on_square(board_after, mv.get_dest(), !mover);
    (opponent_see - captured_value) >= min_sacrifice
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
        let board_after = board.make_move_new(mv);
        let played_is_best = best.pv.first().map(|m| m.as_str()) == Some(uci.as_str());

        // Eval after the played move, from the mover's perspective so it compares with `best_effective`.
        let played_effective = if played_is_best {
            best_effective
        } else {
            let after_fen = format!("{board_after}");
            let after_lines = engine.analyze(&after_fen, config.depth, 1, config.move_timeout)?;
            let after_best = after_lines
                .first()
                .ok_or("engine returned no line for the played move")?;
            // Score is from the opponent's perspective now; negate.
            -effective_cp(after_best.score_cp, after_best.mate)
        };

        let loss = (winning_chances(best_effective) - winning_chances(played_effective)).max(0.0);
        let mut grade = if loss < config.inaccuracy_wc {
            MoveGrade::Good
        } else if loss < config.mistake_wc {
            MoveGrade::Inaccuracy
        } else if loss < config.blunder_wc {
            MoveGrade::Mistake
        } else {
            MoveGrade::Blunder
        };

        if grade == MoveGrade::Good
            && is_brilliant_sacrifice(&board, &board_after, mv, side_to_move, config.brilliant_min_sacrifice)
        {
            grade = MoveGrade::Brilliant;
        }

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
        let (best_line_san, best_line_uci, best_line_fens) = sanify_line(&board, &best.pv);

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
            fen_after: format!("{board_after}"),
            grade,
            eval_before_cp,
            eval_after_cp,
            mate_before,
            mate_after,
            best_move_uci,
            best_move_san,
            best_line_san,
            best_line_uci,
            best_line_fens,
            acceptable_moves,
        });

        board = board_after;
    }

    Ok(out)
}

/// (SAN, UCI, FEN after) per move; stops early if the PV goes illegal, which can happen right at mate.
fn sanify_line(start: &Board, ucis: &[String]) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut board = start.clone();
    let mut sans = Vec::new();
    let mut moves = Vec::new();
    let mut fens = Vec::new();
    for u in ucis.iter().take(8) {
        let Ok(mv) = ChessMove::from_str(u) else {
            break;
        };
        if !board.legal(mv) {
            break;
        }
        sans.push(move_to_san(&board, mv));
        moves.push(u.clone());
        board = board.make_move_new(mv);
        fens.push(format!("{board}"));
    }
    (sans, moves, fens)
}
