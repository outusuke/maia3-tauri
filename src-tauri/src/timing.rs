use chess::{Board, ChessMove, MoveGen, Piece};
use serde::Deserialize;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// Fitted on 6,000 Lichess 3+0 to 5+3 blitz positions with scripts/calibrate_think_time.py.
// Model: ln(think seconds + OFFSET) is linear in these terms, plus a sampled residual.
const INTERCEPT: f64 = -4.9157;
const C_NEFF: f64 = 0.1816;
const C_TOP: f64 = 0.1988;
const C_NEFF_TC: f64 = 0.0507;
const C_RECAPTURE: f64 = -0.3203;
const C_OPENING: f64 = -0.2793;
const C_ENDGAME: f64 = -0.3592;
const C_LN_PLY: f64 = 1.2167;
const C_LN_PLY2: f64 = -0.2164;
const C_FR_LO: f64 = 2.2337;
const C_FR_HI: f64 = -3.0503;
const C_LN_TC: f64 = 0.6759;
const C_TC_INC: f64 = 0.1859;
const OFFSET: f64 = 0.25;

// upper end is 15+10, the slowest control checked against real rapid games
const LN_TC_RANGE: (f64, f64) = (5.2, 7.2);
const OPENING_PLIES: usize = 12;
const MIN_PAUSE: f64 = 0.6;
const MAX_PAUSE: f64 = 30.0;
const MAX_CLOCK_SHARE: f64 = 0.2;

// residual quantiles from 5-fold cross-validation, sampled so pauses are skewed like real ones
const QUANTILES: [f64; 9] = [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99];
const RESIDUALS: [f64; 9] = [-2.415, -1.606, -1.088, -0.507, 0.028, 0.564, 1.064, 1.379, 1.986];

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct ClockInfo {
    pub remaining_ms: f64,
    pub base_ms: f64,
    pub inc_ms: f64,
}

struct Cues {
    ply: usize,
    recapture: bool,
    endgame: bool,
}

fn is_capture(board: &Board, mv: ChessMove) -> bool {
    let (src, dest) = (mv.get_source(), mv.get_dest());
    board.piece_on(dest).is_some() || (board.piece_on(src) == Some(Piece::Pawn) && src.get_file() != dest.get_file())
}

fn cues(start_fen: &str, moves: &[String]) -> Option<Cues> {
    let mut board = Board::from_str(start_fen).ok()?;
    let mut last_capture_on = None;
    for uci in moves {
        let mv = ChessMove::from_str(uci).ok()?;
        last_capture_on = is_capture(&board, mv).then(|| mv.get_dest());
        board = board.make_move_new(mv);
    }
    let recapture = last_capture_on.is_some_and(|sq| MoveGen::new_legal(&board).any(|m| m.get_dest() == sq && is_capture(&board, m)));
    Some(Cues { ply: moves.len(), recapture, endgame: board.combined().popcnt() <= 10 })
}

// entropy of the policy in nats, which is ln(effective moves), and the top move's share
fn spread(policy: &HashMap<String, f64>) -> Option<(f64, f64)> {
    let total: f64 = policy.values().filter(|p| **p > 0.0).sum();
    if total <= 0.0 {
        return None;
    }
    let (mut entropy, mut top) = (0.0, 0.0_f64);
    for p in policy.values().filter(|p| **p > 0.0).map(|p| p / total) {
        entropy -= p * p.ln();
        top = top.max(p);
    }
    Some((entropy, top))
}

fn median_ln(cues: &Cues, ln_neff: f64, top: f64, clock: ClockInfo) -> Option<f64> {
    let (base, inc) = (clock.base_ms / 1000.0, clock.inc_ms / 1000.0);
    if !(base > 0.0) {
        return None;
    }
    let left = (clock.remaining_ms / 1000.0).max(0.0);
    let fr = (left / base).min(1.2);
    let ln_tc = (base + 40.0 * inc + 1.0).ln().clamp(LN_TC_RANGE.0, LN_TC_RANGE.1);
    let ln_ply = (cues.ply as f64 + 1.0).ln();
    let flag = |b: bool| if b { 1.0 } else { 0.0 };
    Some(
        INTERCEPT
            + C_NEFF * ln_neff
            + C_TOP * top
            + C_NEFF_TC * ln_neff * ln_tc
            + C_RECAPTURE * flag(cues.recapture)
            + C_OPENING * flag(cues.ply < OPENING_PLIES)
            + C_ENDGAME * flag(cues.endgame)
            + C_LN_PLY * ln_ply
            + C_LN_PLY2 * ln_ply * ln_ply
            + C_FR_LO * fr.min(0.25)
            + C_FR_HI * (fr - 0.7).max(0.0)
            + C_LN_TC * ln_tc
            + C_TC_INC * flag(inc > 0.0),
    )
}

fn residual(u: f64) -> f64 {
    let u = u.clamp(QUANTILES[0], QUANTILES[QUANTILES.len() - 1]);
    let i = QUANTILES.iter().rposition(|&q| q <= u).unwrap_or(0).min(QUANTILES.len() - 2);
    let t = (u - QUANTILES[i]) / (QUANTILES[i + 1] - QUANTILES[i]);
    RESIDUALS[i] + t * (RESIDUALS[i + 1] - RESIDUALS[i])
}

fn pause_secs(median_ln: f64, u: f64, left_secs: f64) -> f64 {
    ((median_ln + residual(u)).exp() - OFFSET).clamp(MIN_PAUSE, MAX_PAUSE).min(left_secs * MAX_CLOCK_SHARE)
}

// splitmix64 over the clock and a counter; std only, so no new dependency
pub(crate) fn random_unit() -> f64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos() as u64);
    let mut z = nanos ^ COUNTER.fetch_add(0x9E37_79B9_7F4A_7C15, Ordering::Relaxed);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    ((z ^ (z >> 31)) >> 11) as f64 / (1u64 << 53) as f64
}

/// How long a human of this rating might sit on the position; `None` leaves the bot's reply instant.
pub fn think_pause(start_fen: &str, moves: &[String], policy: &HashMap<String, f64>, clock: ClockInfo) -> Option<Duration> {
    let (ln_neff, top) = spread(policy)?;
    let median = median_ln(&cues(start_fen, moves)?, ln_neff, top, clock)?;
    Some(Duration::from_secs_f64(pause_secs(median, random_unit(), (clock.remaining_ms / 1000.0).max(0.0))))
}

#[cfg(test)]
mod tests {
    use super::*;

    const START: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

    fn clock(left_secs: f64) -> ClockInfo {
        ClockInfo { remaining_ms: left_secs * 1000.0, base_ms: 300_000.0, inc_ms: 0.0 }
    }

    fn quiet(ply: usize) -> Cues {
        Cues { ply, recapture: false, endgame: false }
    }

    fn uci(moves: &[&str]) -> Vec<String> {
        moves.iter().map(|m| m.to_string()).collect()
    }

    #[test]
    fn wider_policies_pause_longer() {
        let wide = median_ln(&quiet(20), 10f64.ln(), 0.15, clock(150.0)).unwrap();
        let narrow = median_ln(&quiet(20), 2f64.ln(), 0.7, clock(150.0)).unwrap();
        assert!(wide > narrow);
    }

    #[test]
    fn recaptures_and_the_opening_are_quicker() {
        let base = median_ln(&quiet(20), 3f64.ln(), 0.5, clock(150.0)).unwrap();
        let recapture = Cues { ply: 20, recapture: true, endgame: false };
        assert!(median_ln(&recapture, 3f64.ln(), 0.5, clock(150.0)).unwrap() < base);
        assert!(median_ln(&quiet(4), 3f64.ln(), 0.5, clock(150.0)).unwrap() < base);
    }

    #[test]
    fn finds_recaptures() {
        let after_capture = cues(START, &uci(&["e2e4", "d7d5", "e4d5"])).unwrap();
        assert!(after_capture.recapture);
        assert!(!cues(START, &uci(&["e2e4", "d7d5"])).unwrap().recapture);
        let start = cues(START, &[]).unwrap();
        assert_eq!((start.ply, start.recapture, start.endgame), (0, false, false));
    }

    #[test]
    fn en_passant_counts_as_a_capture() {
        let moves = uci(&["e2e4", "a7a6", "e4e5", "d7d5", "e5d6"]);
        assert!(cues(START, &moves).unwrap().recapture);
    }

    #[test]
    fn residual_runs_through_the_table() {
        assert_eq!(residual(0.0), RESIDUALS[0]);
        assert_eq!(residual(1.0), RESIDUALS[8]);
        assert!((residual(0.5) - RESIDUALS[4]).abs() < 1e-9);
        assert!((0..=100).map(|i| residual(i as f64 / 100.0)).collect::<Vec<_>>().windows(2).all(|w| w[1] >= w[0]));
    }

    #[test]
    fn pause_stays_inside_its_bounds() {
        assert_eq!(pause_secs(-5.0, 0.5, 100.0), MIN_PAUSE);
        assert_eq!(pause_secs(9.0, 0.99, 1000.0), MAX_PAUSE);
        assert!(pause_secs(5.0, 0.99, 2.0) <= 0.4 + 1e-9);
        assert_eq!(pause_secs(5.0, 0.99, 0.0), 0.0);
    }

    #[test]
    fn untimed_games_get_no_pause() {
        let untimed = ClockInfo { remaining_ms: 0.0, base_ms: 0.0, inc_ms: 0.0 };
        let policy = HashMap::from([("e2e4".to_string(), 0.6), ("d2d4".to_string(), 0.4)]);
        assert!(think_pause(START, &[], &policy, untimed).is_none());
        assert!(think_pause(START, &[], &HashMap::new(), clock(100.0)).is_none());
        assert!(think_pause(START, &[], &policy, clock(100.0)).is_some());
    }

    #[test]
    fn longer_time_controls_think_longer() {
        let at = |base: f64, inc: f64| {
            let c = ClockInfo { remaining_ms: base * 1000.0 * 0.5, base_ms: base * 1000.0, inc_ms: inc * 1000.0 };
            median_ln(&quiet(24), 10f64.ln(), 0.4, c).unwrap()
        };
        assert!(at(180.0, 0.0) < at(300.0, 0.0));
        assert!(at(300.0, 0.0) < at(600.0, 0.0));
        assert!(at(600.0, 0.0) < at(900.0, 10.0));
        assert_eq!(at(7200.0, 30.0), at(1800.0, 30.0));
    }

    #[test]
    fn typical_pauses_look_human() {
        let u = |q: f64| q;
        let mid = median_ln(&quiet(24), 10f64.ln(), 0.4, clock(150.0)).unwrap();
        let median = pause_secs(mid, u(0.5), 150.0);
        assert!((3.0..12.0).contains(&median), "median {median}");
        assert!(pause_secs(mid, u(0.1), 150.0) < median && median < pause_secs(mid, u(0.9), 150.0));
    }
}
