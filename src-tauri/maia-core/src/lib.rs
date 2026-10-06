//! Rust port of maia3_onnx_uci.py, same text protocol. Runs Maia in-process on every platform.

mod session;

use chess::{Board, BoardStatus, ChessMove, Color, MoveGen, Piece, ALL_SQUARES};
use serde_json::json;
pub use session::{ModelSource, Session};
use std::sync::Arc;
use std::collections::VecDeque;
use std::path::Path;
use std::str::FromStr;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;

// Layout must match maia3.utils.get_all_possible_moves.
const N_BASE_MOVES: usize = 4096;

fn sq_from_bytes(file: u8, rank: u8) -> Option<usize> {
    if (b'a'..=b'h').contains(&file) && (b'1'..=b'8').contains(&rank) {
        Some((rank - b'1') as usize * 8 + (file - b'a') as usize)
    } else {
        None
    }
}

fn move_index(uci: &str) -> Option<usize> {
    let b = uci.as_bytes();
    if b.len() < 4 {
        return None;
    }
    let from = sq_from_bytes(b[0], b[1])?;
    let to = sq_from_bytes(b[2], b[3])?;
    if b.len() == 4 {
        return Some(from * 64 + to);
    }
    // the vocabulary only has promotions as a7a8-style moves
    if b[1] != b'7' || b[3] != b'8' {
        return None;
    }
    let piece = match b[4] {
        b'q' => 0,
        b'r' => 1,
        b'b' => 2,
        b'n' => 3,
        _ => return None,
    };
    Some(N_BASE_MOVES + ((b[0] - b'a') as usize * 8 + (b[2] - b'a') as usize) * 4 + piece)
}

fn mirror_move(uci: &str) -> String {
    let mut bytes: Vec<u8> = uci.bytes().collect();
    for i in [1usize, 3] {
        if i < bytes.len() && (b'1'..=b'8').contains(&bytes[i]) {
            bytes[i] = b'1' + (b'8' - bytes[i]);
        }
    }
    String::from_utf8(bytes).unwrap_or_default()
}

fn legal_moves(board: &Board) -> Vec<(usize, ChessMove)> {
    let black = board.side_to_move() == Color::Black;
    let mut out: Vec<(usize, ChessMove)> = MoveGen::new_legal(board)
        .filter_map(|mv| {
            let uci = mv.to_string();
            let framed = if black { mirror_move(&uci) } else { uci };
            move_index(&framed).map(|i| (i, mv))
        })
        .collect();
    out.sort_by_key(|(i, _)| *i);
    out
}

fn piece_num(p: Piece) -> usize {
    match p {
        Piece::Pawn => 1,
        Piece::Knight => 2,
        Piece::Bishop => 3,
        Piece::Rook => 4,
        Piece::Queen => 5,
        Piece::King => 6,
    }
}

fn tokenize_board(board: &Board) -> Vec<f32> {
    let flip = board.side_to_move() == Color::Black;
    let mut t = vec![0f32; 64 * 12];
    for sq in ALL_SQUARES.iter() {
        let (Some(piece), Some(color)) = (board.piece_on(*sq), board.color_on(*sq)) else {
            continue;
        };
        let (idx, color) = if flip {
            (sq.to_index() ^ 56, if color == Color::White { Color::Black } else { Color::White })
        } else {
            (sq.to_index(), color)
        };
        let token = piece_num(piece) + if color == Color::Black { 6 } else { 0 };
        t[idx * 12 + token - 1] = 1.0;
    }
    t
}

/// Short history is padded with the oldest position, like the Python script.
fn historical_tokens(hist: &[&[f32]], history_len: usize) -> Vec<f32> {
    let mut frames: Vec<&[f32]> = Vec::with_capacity(history_len);
    if hist.len() < history_len {
        for _ in 0..(history_len - hist.len()) {
            frames.push(hist[0]);
        }
    }
    frames.extend_from_slice(hist);
    let width = 12 * history_len;
    let mut out = vec![0f32; 64 * width];
    for sq in 0..64 {
        for (j, frame) in frames.iter().enumerate() {
            out[sq * width + j * 12..sq * width + j * 12 + 12].copy_from_slice(&frame[sq * 12..sq * 12 + 12]);
        }
    }
    out
}

fn softmax(x: &[f64]) -> Vec<f64> {
    let max = x.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let exps: Vec<f64> = x.iter().map(|v| (v - max).exp()).collect();
    let sum: f64 = exps.iter().sum();
    exps.into_iter().map(|e| e / sum).collect()
}

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed ^ 0x9E37_79B9_7F4A_7C15)
    }
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn choice(&mut self, probs: &[f64]) -> usize {
        let r = self.next_f64();
        let mut acc = 0.0;
        for (i, p) in probs.iter().enumerate() {
            acc += p;
            if r < acc {
                return i;
            }
        }
        probs.len().saturating_sub(1)
    }
}

/// logits are for legal moves only; returns an index into them.
fn sample_from_logits(logits: &[f64], temperature: f64, top_p: f64, rng: &mut Rng) -> usize {
    if temperature <= 0.0 {
        let mut best = 0;
        for (i, v) in logits.iter().enumerate() {
            if *v > logits[best] {
                best = i;
            }
        }
        return best;
    }
    let scaled: Vec<f64> = logits.iter().map(|l| l / temperature).collect();
    let probs = softmax(&scaled);

    if top_p < 1.0 {
        let mut order: Vec<usize> = (0..probs.len()).collect();
        order.sort_by(|a, b| probs[*b].total_cmp(&probs[*a]));
        let mut kept: Vec<usize> = Vec::new();
        let mut before = 0.0;
        for (rank, &i) in order.iter().enumerate() {
            // keep the move that crosses top_p, like the Python version
            if rank == 0 || before < top_p {
                kept.push(i);
            }
            before += probs[i];
        }
        let total: f64 = kept.iter().map(|i| probs[*i]).sum();
        let kept_probs: Vec<f64> = kept.iter().map(|i| probs[*i] / total).collect();
        return kept[rng.choice(&kept_probs)];
    }
    rng.choice(&probs)
}

fn wdl_from_value_logits(v: &[f32]) -> (i32, i32, i32) {
    if v.len() < 3 {
        return (0, 1000, 0);
    }
    // model outputs [loss, draw, win]
    let p = softmax(&[v[0] as f64, v[1] as f64, v[2] as f64]);
    let probs = [p[2], p[1], p[0]];
    let scaled: Vec<f64> = probs.iter().map(|x| x.max(0.0) * 1000.0).collect();
    let mut ints: Vec<i32> = scaled.iter().map(|x| *x as i32).collect();
    let remainder = 1000 - ints.iter().sum::<i32>();
    let mut order: Vec<usize> = (0..3).collect();
    order.sort_by(|a, b| (scaled[*b] - ints[*b] as f64).total_cmp(&(scaled[*a] - ints[*a] as f64)));
    for i in order.into_iter().take(remainder.max(0) as usize) {
        ints[i] += 1;
    }
    (ints[0], ints[1], ints[2])
}

fn round_to(x: f64, places: i32) -> f64 {
    let m = 10f64.powi(places);
    (x * m).round() / m
}

#[derive(Clone, Debug)]
pub struct Config {
    pub history: usize,
    pub use_uci_history: bool,
    pub elo: u32,
    pub temperature: f64,
    pub top_p: f64,
    pub multipv: usize,
    pub seed: u64,
    pub opening_moves: u32,
}

impl Default for Config {
    fn default() -> Self {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(1);
        Config {
            history: 8,
            use_uci_history: false,
            elo: 1500,
            temperature: 0.0,
            top_p: 1.0,
            multipv: 5,
            seed,
            opening_moves: 0,
        }
    }
}

impl Config {
    pub fn from_args(args: &[String]) -> Config {
        let mut c = Config::default();
        let mut i = 0;
        while i < args.len() {
            let next = args.get(i + 1);
            match args[i].as_str() {
                "--use-uci-history" => c.use_uci_history = true,
                "--history" => {
                    if let Some(v) = next.and_then(|s| s.parse().ok()) {
                        c.history = v;
                    }
                    i += 1;
                }
                "--elo" => {
                    if let Some(v) = next.and_then(|s| s.parse().ok()) {
                        c.elo = v;
                    }
                    i += 1;
                }
                "--temperature" => {
                    if let Some(v) = next.and_then(|s| s.parse().ok()) {
                        c.temperature = v;
                    }
                    i += 1;
                }
                "--top-p" => {
                    if let Some(v) = next.and_then(|s| s.parse().ok()) {
                        c.top_p = v;
                    }
                    i += 1;
                }
                "--multipv" => {
                    if let Some(v) = next.and_then(|s| s.parse().ok()) {
                        c.multipv = v;
                    }
                    i += 1;
                }
                "--seed" => {
                    if let Some(v) = next.and_then(|s| s.parse().ok()) {
                        c.seed = v;
                    }
                    i += 1;
                }
                "--opening-moves" => {
                    if let Some(v) = next.and_then(|s| s.parse().ok()) {
                        c.opening_moves = v;
                    }
                    i += 1;
                }
                "--onnx" | "--threads" => i += 1,
                _ => {}
            }
            i += 1;
        }
        c.multipv = c.multipv.clamp(1, 20);
        c.history = c.history.max(1);
        c
    }
}

struct TopMove {
    mv: ChessMove,
    wdl: (i32, i32, i32),
}

pub struct MaiaEngine {
    session: Arc<Session>,
    history_len: usize,
    use_uci_history: bool,
    self_elo: f32,
    oppo_elo: f32,
    temperature: f64,
    top_p: f64,
    opening_moves: u32,
    multipv: usize,
    rng: Rng,

    board: Board,
    fullmove: u32,
    history: VecDeque<Vec<f32>>,
    pending_bestmove: Option<ChessMove>,
    pending_search: bool,
    game_start: Board,
    game_moves: Vec<String>,
}

fn parse_fen(fen: &str) -> Option<Board> {
    if let Ok(b) = Board::from_str(fen) {
        return Some(b);
    }
    // the chess crate and UCI disagree on the en passant square; retry without it
    let mut fields: Vec<&str> = fen.split_whitespace().collect();
    if fields.len() >= 4 {
        fields[3] = "-";
        return Board::from_str(&fields.join(" ")).ok();
    }
    None
}

impl MaiaEngine {
    pub fn new(onnx: &Path, cfg: Config) -> Result<Self, String> {
        Self::from_source(&ModelSource::File(onnx.to_path_buf()), cfg)
    }

    pub fn from_source(source: &ModelSource, cfg: Config) -> Result<Self, String> {
        let session = match source {
            ModelSource::Shared(s) => {
                if s.history() != cfg.history {
                    return Err(format!(
                        "shared model was loaded with history {} but {} was requested",
                        s.history(),
                        cfg.history
                    ));
                }
                s.clone()
            }
            other => Arc::new(Session::load(other, cfg.history)?),
        };
        let board = Board::default();
        let mut e = MaiaEngine {
            session,
            history_len: cfg.history,
            use_uci_history: cfg.use_uci_history,
            self_elo: cfg.elo as f32,
            oppo_elo: cfg.elo as f32,
            temperature: cfg.temperature,
            top_p: cfg.top_p,
            opening_moves: cfg.opening_moves,
            multipv: cfg.multipv,
            rng: Rng::new(cfg.seed),
            board,
            fullmove: 1,
            history: VecDeque::new(),
            pending_bestmove: None,
            pending_search: false,
            game_start: board,
            game_moves: Vec::new(),
        };
        e.reset_history();
        Ok(e)
    }

    fn reset_history(&mut self) {
        self.history.clear();
        self.history.push_back(tokenize_board(&self.board));
    }

    fn tokens_from(&self, hist: &[&[f32]]) -> Vec<f32> {
        historical_tokens(hist, self.history_len)
    }

    fn current_tokens(&self) -> Vec<f32> {
        let frames: Vec<&[f32]> = self.history.iter().map(|v| v.as_slice()).collect();
        self.tokens_from(&frames)
    }

    fn history_after(&self, mv: ChessMove) -> Vec<Vec<f32>> {
        let after = self.board.make_move_new(mv);
        let t = tokenize_board(&after);
        if self.use_uci_history {
            let mut h: Vec<Vec<f32>> = self.history.iter().cloned().collect();
            h.push(t);
            while h.len() > self.history_len {
                h.remove(0);
            }
            h
        } else {
            vec![t]
        }
    }

    fn is_over(&self) -> bool {
        self.board.status() != BoardStatus::Ongoing
    }

    fn score_moves(&mut self) -> Result<(Option<ChessMove>, Vec<TopMove>), String> {
        if self.is_over() {
            return Ok((None, Vec::new()));
        }
        let legal = legal_moves(&self.board);
        if legal.is_empty() {
            return Ok((None, Vec::new()));
        }

        let tokens = self.current_tokens();
        let (logits_move, _) = self.session.run(&tokens, self.self_elo, self.oppo_elo)?;
        let logits: Vec<f64> = legal.iter().map(|(i, _)| logits_move[*i] as f64).collect();

        // at low temperature the first move would always be the same, so open it up
        let in_opening = self.temperature > 0.0 && self.fullmove <= self.opening_moves;
        let (temperature, top_p) = if in_opening { (1.0, 1.0) } else { (self.temperature, self.top_p) };
        let pick = sample_from_logits(&logits, temperature, top_p, &mut self.rng);
        let chosen = legal[pick].1;

        let probs = softmax(&logits);
        let mut order: Vec<usize> = (0..legal.len()).collect();
        order.sort_by(|a, b| probs[*b].total_cmp(&probs[*a]));
        order.truncate(self.multipv.min(legal.len()));

        let mut top: Vec<TopMove> = order
            .into_iter()
            .map(|k| TopMove { mv: legal[k].1, wdl: (0, 1000, 0) })
            .collect();

        for item in top.iter_mut() {
            let hist = self.history_after(item.mv);
            let frames: Vec<&[f32]> = hist.iter().map(|v| v.as_slice()).collect();
            let toks = self.tokens_from(&frames);
            // after our move the opponent is to move: swap Elos, then flip the WDL back
            let (_, value) = self.session.run(&toks, self.oppo_elo, self.self_elo)?;
            let (w, d, l) = wdl_from_value_logits(&value);
            item.wdl = (l, d, w);
        }
        Ok((Some(chosen), top))
    }

    fn cmd_uci(&self, out: &mut dyn FnMut(String)) {
        out("id name Maia3-Rust".into());
        out("id author CSSLab (Rust/ONNX Runtime port)".into());
        out(format!("option name Elo type spin default {} min 0 max 5000", self.self_elo as i32));
        out(format!("option name SelfElo type spin default {} min 0 max 5000", self.self_elo as i32));
        out(format!("option name OppoElo type spin default {} min 0 max 5000", self.oppo_elo as i32));
        out(format!("option name Temperature type string default {}", self.temperature));
        out(format!("option name TopP type string default {}", self.top_p));
        out(format!("option name MultiPV type spin default {} min 1 max 20", self.multipv));
        out("uciok".into());
    }

    fn cmd_setoption(&mut self, line: &str) {
        let Some((_, after_name)) = line.split_once("name") else { return };
        let (name, value) = match after_name.split_once("value") {
            Some((n, v)) => (n.trim().to_lowercase(), v.trim().to_string()),
            None => (after_name.trim().to_lowercase(), String::new()),
        };
        match name.as_str() {
            "elo" => {
                if let Ok(v) = value.parse::<i64>() {
                    self.self_elo = v as f32;
                    self.oppo_elo = v as f32;
                }
            }
            "selfelo" => {
                if let Ok(v) = value.parse::<i64>() {
                    self.self_elo = v as f32;
                }
            }
            "oppoelo" => {
                if let Ok(v) = value.parse::<i64>() {
                    self.oppo_elo = v as f32;
                }
            }
            "temperature" => {
                if let Ok(v) = value.parse::<f64>() {
                    self.temperature = v;
                }
            }
            "topp" => {
                if let Ok(v) = value.parse::<f64>() {
                    self.top_p = v;
                }
            }
            "multipv" => {
                if let Ok(v) = value.parse::<usize>() {
                    self.multipv = v.clamp(1, 20);
                }
            }
            _ => {}
        }
    }

    fn cmd_ucinewgame(&mut self) {
        self.board = Board::default();
        self.fullmove = 1;
        self.pending_bestmove = None;
        self.pending_search = false;
        self.reset_history();
    }

    fn cmd_position(&mut self, line: &str) {
        let toks: Vec<&str> = line.split_whitespace().collect();
        if toks.len() < 2 {
            return;
        }
        let mut i = 1;
        let board: Board;
        let mut fullmove: u32 = 1;
        if toks[i] == "startpos" {
            board = Board::default();
            i += 1;
        } else if toks[i] == "fen" {
            if toks.len() < i + 7 {
                return;
            }
            match parse_fen(&toks[i + 1..i + 7].join(" ")) {
                Some(b) => board = b,
                None => return,
            }
            fullmove = toks[i + 6].parse().unwrap_or(1);
            i += 7;
        } else {
            return;
        }

        let moves: Vec<String> = if i < toks.len() && toks[i] == "moves" {
            toks[i + 1..].iter().map(|s| s.to_string()).collect()
        } else {
            Vec::new()
        };
        let start_board = board;
        self.pending_bestmove = None;
        self.pending_search = false;

        // commit only if every move is legal, like the Python script
        let mut replay = board;
        let mut fm = fullmove;
        let mut hist: VecDeque<Vec<f32>> = VecDeque::new();
        hist.push_back(tokenize_board(&replay));
        for m in &moves {
            let Ok(mv) = ChessMove::from_str(m) else { return };
            if !replay.legal(mv) {
                return;
            }
            if replay.side_to_move() == Color::Black {
                fm += 1;
            }
            replay = replay.make_move_new(mv);
            hist.push_back(tokenize_board(&replay));
            while hist.len() > self.history_len {
                hist.pop_front();
            }
        }

        self.board = replay;
        self.fullmove = fm;
        if self.use_uci_history {
            self.history = hist;
        } else {
            self.reset_history();
        }
        self.game_start = start_board;
        self.game_moves = moves;
    }

    fn cmd_go(&mut self, line: &str, out: &mut dyn FnMut(String)) {
        let (mv, top) = match self.score_moves() {
            Ok(r) => r,
            Err(e) => {
                out(format!("info string error: {e}"));
                out("bestmove 0000".into());
                return;
            }
        };
        for (rank, item) in top.iter().enumerate() {
            let (w, d, l) = item.wdl;
            out(format!(
                "info depth 1 multipv {} score cp {} wdl {} {} {} pv {}",
                rank + 1,
                w - l,
                w,
                d,
                l,
                item.mv
            ));
        }
        if line.split_whitespace().any(|t| t == "infinite") {
            self.pending_bestmove = mv;
            self.pending_search = true;
            return;
        }
        out(bestmove_line(mv));
    }

    fn cmd_stop(&mut self, out: &mut dyn FnMut(String)) {
        if !self.pending_search {
            return;
        }
        out(bestmove_line(self.pending_bestmove));
        self.pending_bestmove = None;
        self.pending_search = false;
    }

    fn cmd_insights(&mut self, line: &str, out: &mut dyn FnMut(String)) {
        let elos: Vec<u32> = line.split_whitespace().skip(1).map_while(|s| s.parse().ok()).collect();
        let legal = if self.is_over() { Vec::new() } else { legal_moves(&self.board) };
        if elos.is_empty() || legal.is_empty() {
            out(format!("insights {}", json!({"ratings": elos, "policies": [], "winProb": []})));
            return;
        }

        let tokens = self.current_tokens();
        let mut policies = Vec::new();
        let mut win_prob = Vec::new();
        for elo in &elos {
            let e = *elo as f32;
            let (lm, lv) = match self.session.run(&tokens, e, e) {
                Ok(r) => r,
                Err(err) => {
                    out(format!("info string error: {err}"));
                    out(format!("insights {}", json!({"ratings": elos, "policies": [], "winProb": []})));
                    return;
                }
            };
            let logits: Vec<f64> = legal.iter().map(|(i, _)| lm[*i] as f64).collect();
            let probs = softmax(&logits);
            let mut map = serde_json::Map::new();
            for ((_, mv), p) in legal.iter().zip(probs.iter()) {
                // drop the tail to keep the payload small
                if *p >= 0.0005 {
                    map.insert(mv.to_string(), json!(round_to(*p, 5)));
                }
            }
            policies.push(serde_json::Value::Object(map));

            let vp = softmax(&[lv[0] as f64, lv[1] as f64, lv[2] as f64]);
            win_prob.push(round_to(vp[2] + 0.5 * vp[1], 4));
        }
        out(format!("insights {}", json!({"ratings": elos, "policies": policies, "winProb": win_prob})));
    }

    fn cmd_estimate(&mut self, line: &str, out: &mut dyn FnMut(String)) {
        // format: estimate <ply,ply,...> <elo> <elo>...
        let parts: Vec<&str> = line.split_whitespace().collect();
        let parsed: Option<(Vec<usize>, Vec<u32>)> = (|| {
            let wanted = parts
                .get(1)?
                .split(',')
                .filter(|s| !s.is_empty())
                .map(|s| s.parse().ok())
                .collect::<Option<Vec<usize>>>()?;
            let elos = parts[2..].iter().map(|s| s.parse().ok()).collect::<Option<Vec<u32>>>()?;
            Some((wanted, elos))
        })();
        let (wanted, elos) = parsed.unwrap_or_default();
        if elos.is_empty() {
            out(format!("estimate {}", json!({"plies": []})));
            return;
        }

        let mut boards: Vec<Board> = vec![self.game_start];
        let mut toks: Vec<Vec<f32>> = vec![tokenize_board(&self.game_start)];
        let mut cur = self.game_start;
        for m in &self.game_moves {
            let Ok(mv) = ChessMove::from_str(m) else { break };
            if !cur.legal(mv) {
                break;
            }
            cur = cur.make_move_new(mv);
            boards.push(cur);
            toks.push(tokenize_board(&cur));
        }

        let mut plies = Vec::new();
        for &i in wanted.iter().filter(|w| **w < self.game_moves.len() && **w < boards.len() - 1) {
            let b = &boards[i];
            let legal = legal_moves(b);
            if legal.len() < 2 {
                continue;
            }
            let uci = if b.side_to_move() == Color::White {
                self.game_moves[i].clone()
            } else {
                mirror_move(&self.game_moves[i])
            };
            let Some(played) = move_index(&uci) else { continue };
            let Some(local) = legal.iter().position(|(idx, _)| *idx == played) else { continue };

            let frames: Vec<&[f32]> = if self.use_uci_history {
                toks[(i + 1).saturating_sub(self.history_len)..=i].iter().map(|v| v.as_slice()).collect()
            } else {
                vec![toks[i].as_slice()]
            };
            let tokens = self.tokens_from(&frames);

            let mut logp = Vec::new();
            for elo in &elos {
                let e = *elo as f32;
                let lm = match self.session.run(&tokens, e, e) {
                    Ok((lm, _)) => lm,
                    Err(err) => {
                        out(format!("info string error: {err}"));
                        out(format!("estimate {}", json!({"plies": []})));
                        return;
                    }
                };
                let legal_logits: Vec<f64> = legal.iter().map(|(idx, _)| lm[*idx] as f64).collect();
                let peak = legal_logits.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                let lse = peak + legal_logits.iter().map(|v| (v - peak).exp()).sum::<f64>().ln();
                logp.push(round_to(legal_logits[local] - lse, 4));
            }
            plies.push(json!({"ply": i, "logp": logp}));
        }
        out(format!("estimate {}", json!({"plies": plies})));
    }

    pub fn handle_line(&mut self, raw: &str, out: &mut dyn FnMut(String)) -> bool {
        let line = raw.trim();
        if line.is_empty() {
            return true;
        }
        let cmd = line.split_whitespace().next().unwrap_or("");
        match (line, cmd) {
            ("uci", _) => self.cmd_uci(out),
            ("isready", _) => out("readyok".into()),
            ("ucinewgame", _) => self.cmd_ucinewgame(),
            ("quit", _) => return false,
            ("stop", _) => self.cmd_stop(out),
            (_, "position") => self.cmd_position(line),
            (_, "go") => self.cmd_go(line, out),
            (_, "insights") => self.cmd_insights(line, out),
            (_, "estimate") => self.cmd_estimate(line, out),
            (_, "setoption") => self.cmd_setoption(line),
            _ => {}
        }
        true
    }
}

fn bestmove_line(mv: Option<ChessMove>) -> String {
    match mv {
        Some(m) => format!("bestmove {m}"),
        None => "bestmove 0000".to_string(),
    }
}

/// Starts the engine on its own thread and returns once the model has loaded.
pub fn spawn_thread(model: ModelSource, args: Vec<String>) -> Result<(Sender<String>, Receiver<String>), String> {
    let (cmd_tx, cmd_rx) = mpsc::channel::<String>();
    let (out_tx, out_rx) = mpsc::channel::<String>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();

    thread::Builder::new()
        .name("maia".into())
        // Android's default thread stack is small
        .stack_size(32 * 1024 * 1024)
        .spawn(move || {
            let cfg = Config::from_args(&args);
            let mut engine = match MaiaEngine::from_source(&model, cfg) {
                Ok(e) => {
                    let _ = ready_tx.send(Ok(()));
                    e
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            drop(model);
            for line in cmd_rx {
                let mut emit = |s: String| {
                    let _ = out_tx.send(s);
                };
                if !engine.handle_line(&line, &mut emit) {
                    break;
                }
            }
        })
        .map_err(|e| format!("could not start the Maia thread: {e}"))?;

    match ready_rx.recv() {
        Ok(Ok(())) => Ok((cmd_tx, out_rx)),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("the Maia thread stopped while loading the model".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vocabulary_matches_python_layout() {
        assert_eq!(move_index("a1a1"), Some(0));
        assert_eq!(move_index("h8h8"), Some(4095));
        assert_eq!(move_index("e2e4"), Some((1 * 8 + 4) * 64 + (3 * 8 + 4)));
        assert_eq!(move_index("a7a8q"), Some(4096));
        assert_eq!(move_index("h7h8n"), Some(4351));
        assert_eq!(move_index("e2e1q"), None);
    }

    #[test]
    fn mirroring_is_an_involution() {
        assert_eq!(mirror_move("e2e4"), "e7e5");
        assert_eq!(mirror_move("a7a8q"), "a2a1q");
        assert_eq!(mirror_move(&mirror_move("g1f3")), "g1f3");
    }

    #[test]
    fn start_position_has_20_legal_moves_with_unique_indices() {
        let legal = legal_moves(&Board::default());
        assert_eq!(legal.len(), 20);
        let mut idx: Vec<usize> = legal.iter().map(|(i, _)| *i).collect();
        idx.dedup();
        assert_eq!(idx.len(), 20);
    }

    #[test]
    fn black_to_move_is_framed_as_white() {
        let b = Board::from_str("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1").unwrap();
        let legal = legal_moves(&b);
        assert_eq!(legal.len(), 20);
        assert!(legal.iter().any(|(i, m)| *i == move_index("e2e4").unwrap() && m.to_string() == "e7e5"));
    }

    #[test]
    fn tokens_are_side_to_move_relative() {
        let w = tokenize_board(&Board::default());
        let b = tokenize_board(&Board::from_str("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1").unwrap());
        assert_eq!(w[4 * 12 + 5], 1.0);
        assert_eq!(b[4 * 12 + 5], 1.0);
        assert_eq!(w.iter().sum::<f32>(), 32.0);
    }

    #[test]
    fn wdl_sums_to_1000() {
        let (w, d, l) = wdl_from_value_logits(&[0.3, -0.2, 1.1]);
        assert_eq!(w + d + l, 1000);
    }

    #[test]
    fn greedy_and_top_p_sampling() {
        let mut rng = Rng::new(7);
        assert_eq!(sample_from_logits(&[0.1, 3.0, 1.0], 0.0, 1.0, &mut rng), 1);
        for _ in 0..20 {
            assert_eq!(sample_from_logits(&[0.1, 3.0, 1.0], 1.0, 0.01, &mut rng), 1);
        }
    }
}
