use chess::{Board, BoardStatus, ChessMove, Color, MoveGen, Piece, Square};
use serde::Serialize;
use std::collections::HashMap;
use std::str::FromStr;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GameState {
    pub fen: String,
    pub turn: String,
    pub in_check: bool,
    pub status: String,          // "ongoing" | "checkmate" | "stalemate" | "draw"
    pub winner: Option<String>,  // "white" | "black" | null
    pub last_move: Option<[String; 2]>,
    pub san_history: Vec<String>,
    pub legal_move_count: usize,
    pub can_undo: bool,
}

struct Snapshot {
    board: Board,
    last_move: Option<(Square, Square)>,
    repetitions: HashMap<String, u8>,
    halfmove: u16,
}

pub struct Game {
    board: Board,
    start_fen: String,
    uci_moves: Vec<String>,
    san_history: Vec<String>,
    last_move: Option<(Square, Square)>,
    repetitions: HashMap<String, u8>,
    /// `chess::Board` doesn't track the clock, so it lives here.
    halfmove: u16,
    history: Vec<Snapshot>,
}

impl Game {
    pub fn new() -> Self {
        let board = Board::default();
        let mut repetitions = HashMap::new();
        repetitions.insert(repetition_key(&board), 1);
        Game {
            start_fen: format!("{board}"),
            board,
            uci_moves: Vec::new(),
            san_history: Vec::new(),
            last_move: None,
            repetitions,
            halfmove: 0,
            history: Vec::new(),
        }
    }

    pub fn from_fen(fen: &str) -> Result<Self, String> {
        let fen = sanitize_castle_rights(fen);
        let board = Board::from_str(&fen).map_err(|e| format!("invalid FEN: {e}"))?;
        let halfmove = fen.split_whitespace().nth(4).and_then(|s| s.parse().ok()).unwrap_or(0);
        let mut repetitions = HashMap::new();
        repetitions.insert(repetition_key(&board), 1);
        Ok(Game {
            start_fen: format!("{board}"),
            board,
            uci_moves: Vec::new(),
            san_history: Vec::new(),
            last_move: None,
            repetitions,
            halfmove,
            history: Vec::new(),
        })
    }

    pub fn fen(&self) -> String {
        format!("{}", self.board)
    }

    pub fn legal_targets(&self, from: Square) -> Vec<String> {
        MoveGen::new_legal(&self.board)
            .filter(|m| m.get_source() == from)
            .map(|m| m.get_dest().to_string())
            .collect()
    }

    pub fn try_move(&mut self, from: Square, to: Square, promotion: Option<Piece>) -> Result<(), String> {
        let candidate = ChessMove::new(from, to, promotion);
        if !self.board.legal(candidate) {
            return Err("illegal move".into());
        }
        self.history.push(Snapshot {
            board: self.board.clone(),
            last_move: self.last_move,
            repetitions: self.repetitions.clone(),
            halfmove: self.halfmove,
        });
        let san = move_to_san(&self.board, candidate);
        let is_pawn = self.board.piece_on(from) == Some(Piece::Pawn);
        let is_capture = self.board.piece_on(to).is_some() || (is_pawn && from.get_file() != to.get_file());
        self.halfmove = if is_pawn || is_capture { 0 } else { self.halfmove.saturating_add(1) };
        self.board = self.board.make_move_new(candidate);
        self.uci_moves.push(candidate.to_string());
        self.san_history.push(san);
        self.last_move = Some((from, to));
        *self.repetitions.entry(repetition_key(&self.board)).or_insert(0) += 1;
        Ok(())
    }

    pub fn undo(&mut self) -> Result<(), String> {
        let snap = self.history.pop().ok_or("nothing to undo")?;
        self.board = snap.board;
        self.last_move = snap.last_move;
        self.repetitions = snap.repetitions;
        self.halfmove = snap.halfmove;
        self.uci_moves.pop();
        self.san_history.pop();
        Ok(())
    }

    pub fn can_undo(&self) -> bool {
        !self.history.is_empty()
    }

    /// What a UCI `position` command needs to replay this game from scratch.
    pub fn uci_history(&self) -> (&str, &[String]) {
        (&self.start_fen, &self.uci_moves)
    }

    pub fn try_move_uci(&mut self, uci: &str) -> Result<(), String> {
        let uci = uci.trim();
        if uci.len() < 4 {
            return Err(format!("bad uci move: {uci}"));
        }
        let from = Square::from_str(&uci[0..2]).map_err(|e| e.to_string())?;
        let to = Square::from_str(&uci[2..4]).map_err(|e| e.to_string())?;
        let promotion = if uci.len() >= 5 {
            match uci.as_bytes()[4] as char {
                'q' => Some(Piece::Queen),
                'r' => Some(Piece::Rook),
                'b' => Some(Piece::Bishop),
                'n' => Some(Piece::Knight),
                _ => None,
            }
        } else {
            None
        };
        self.try_move(from, to, promotion)
    }

    pub fn state(&self) -> GameState {
        let turn = match self.board.side_to_move() {
            Color::White => "white",
            Color::Black => "black",
        };
        let in_check = self.board.checkers().popcnt() > 0;

        let is_draw_by_repetition = self.repetitions.values().any(|&c| c >= 3);
        let is_draw_by_fifty_move = self.halfmove >= 100;

        let (status, winner) = match self.board.status() {
            BoardStatus::Checkmate => {
                let winner = match self.board.side_to_move() {
                    Color::White => "black",
                    Color::Black => "white",
                };
                ("checkmate".to_string(), Some(winner.to_string()))
            }
            BoardStatus::Stalemate => ("stalemate".to_string(), None),
            BoardStatus::Ongoing => {
                if is_draw_by_repetition {
                    ("draw".to_string(), None)
                } else if is_draw_by_fifty_move || insufficient_material(&self.board) {
                    ("draw".to_string(), None)
                } else {
                    ("ongoing".to_string(), None)
                }
            }
        };

        GameState {
            fen: self.fen(),
            turn: turn.to_string(),
            in_check,
            status,
            winner,
            last_move: self
                .last_move
                .map(|(f, t)| [f.to_string(), t.to_string()]),
            san_history: self.san_history.clone(),
            legal_move_count: MoveGen::new_legal(&self.board).len(),
            can_undo: self.can_undo(),
        }
    }
}

pub fn move_to_san(board: &Board, mv: ChessMove) -> String {
    let from = mv.get_source();
    let to = mv.get_dest();
    let piece = board.piece_on(from).unwrap_or(Piece::Pawn);

    if piece == Piece::King {
        let file_delta = (to.get_file().to_index() as i8) - (from.get_file().to_index() as i8);
        if file_delta == 2 {
            return with_check_suffix(board, mv, "O-O".to_string());
        } else if file_delta == -2 {
            return with_check_suffix(board, mv, "O-O-O".to_string());
        }
    }

    let is_en_passant =
        piece == Piece::Pawn && from.get_file() != to.get_file() && board.piece_on(to).is_none();
    let is_capture = board.piece_on(to).is_some() || is_en_passant;

    let piece_letter = match piece {
        Piece::Pawn => "",
        Piece::Knight => "N",
        Piece::Bishop => "B",
        Piece::Rook => "R",
        Piece::Queen => "Q",
        Piece::King => "K",
    };

    let mut san = String::new();
    if piece == Piece::Pawn {
        if is_capture {
            san.push(file_char(from));
            san.push('x');
        }
    } else {
        san.push_str(piece_letter);
        san.push_str(&disambiguation(board, mv, piece));
        if is_capture {
            san.push('x');
        }
    }
    san.push_str(&to.to_string());

    if let Some(promo) = mv.get_promotion() {
        san.push('=');
        san.push_str(match promo {
            Piece::Queen => "Q",
            Piece::Rook => "R",
            Piece::Bishop => "B",
            Piece::Knight => "N",
            _ => "Q",
        });
    }

    with_check_suffix(board, mv, san)
}

fn disambiguation(board: &Board, mv: ChessMove, piece: Piece) -> String {
    let from = mv.get_source();
    let to = mv.get_dest();
    let others: Vec<Square> = MoveGen::new_legal(board)
        .filter(|m| {
            m.get_dest() == to
                && m.get_source() != from
                && board.piece_on(m.get_source()) == Some(piece)
        })
        .map(|m| m.get_source())
        .collect();

    if others.is_empty() {
        return String::new();
    }
    let same_file = others.iter().any(|s| s.get_file() == from.get_file());
    let same_rank = others.iter().any(|s| s.get_rank() == from.get_rank());
    if !same_file {
        file_char(from).to_string()
    } else if !same_rank {
        rank_char(from).to_string()
    } else {
        format!("{}{}", file_char(from), rank_char(from))
    }
}

fn with_check_suffix(board: &Board, mv: ChessMove, mut san: String) -> String {
    let after = board.make_move_new(mv);
    if after.checkers().popcnt() > 0 {
        if after.status() == BoardStatus::Checkmate {
            san.push('#');
        } else {
            san.push('+');
        }
    }
    san
}

fn file_char(sq: Square) -> char {
    (b'a' + sq.get_file().to_index() as u8) as char
}
fn rank_char(sq: Square) -> char {
    (b'1' + sq.get_rank().to_index() as u8) as char
}

pub fn scratch_legal_targets(fen: &str, from: Square) -> Result<Vec<String>, String> {
    let fen = sanitize_castle_rights(fen);
    let board = Board::from_str(&fen).map_err(|e| format!("invalid FEN: {e}"))?;
    Ok(MoveGen::new_legal(&board)
        .filter(|m| m.get_source() == from)
        .map(|m| m.get_dest().to_string())
        .collect())
}

pub fn scratch_try_move(
    fen: &str,
    from: Square,
    to: Square,
    promotion: Option<Piece>,
) -> Result<(String, String, String), String> {
    let fen = sanitize_castle_rights(fen);
    let board = Board::from_str(&fen).map_err(|e| format!("invalid FEN: {e}"))?;
    let mv = ChessMove::new(from, to, promotion);
    if !board.legal(mv) {
        return Err("illegal move".into());
    }
    let san = move_to_san(&board, mv);
    let after = board.make_move_new(mv);
    Ok((format!("{after}"), san, mv.to_string()))
}

pub fn validate_fen(fen: &str) -> Result<(), String> {
    let fen = sanitize_castle_rights(fen);
    Board::from_str(&fen).map(|_| ()).map_err(|e| format!("invalid FEN: {e}"))
}

// the chess crate rejects FENs with castling rights for a king that has moved
fn sanitize_castle_rights(fen: &str) -> String {
    let mut fields: Vec<&str> = fen.split_whitespace().collect();
    if fields.len() < 3 || fields[2] == "-" {
        return fen.to_string();
    }

    let ranks: Vec<&str> = fields[0].split('/').collect();
    if ranks.len() != 8 {
        return fen.to_string();
    }

    let king_on_e_file = |rank: &str, king_char: char| -> bool {
        let mut file = 0u8;
        for c in rank.chars() {
            match c.to_digit(10) {
                Some(skip) => file += skip as u8,
                None => {
                    if file == 4 && c == king_char {
                        return true;
                    }
                    file += 1;
                }
            }
        }
        false
    };

    let white_king_home = king_on_e_file(ranks[7], 'K');
    let black_king_home = king_on_e_file(ranks[0], 'k');

    let cleaned: String = fields[2]
        .chars()
        .filter(|c| match c {
            'K' | 'Q' => white_king_home,
            'k' | 'q' => black_king_home,
            _ => true,
        })
        .collect();

    fields[2] = if cleaned.is_empty() { "-" } else { &cleaned };
    fields.join(" ")
}

// the crate only reports mate/stalemate, and Maia hangs if asked to move in a dead position
fn insufficient_material(board: &Board) -> bool {
    if board.pieces(Piece::Pawn).popcnt() > 0
        || board.pieces(Piece::Rook).popcnt() > 0
        || board.pieces(Piece::Queen).popcnt() > 0
    {
        return false;
    }
    let knights = board.pieces(Piece::Knight).popcnt();
    let bishops = *board.pieces(Piece::Bishop);
    if knights + bishops.popcnt() <= 1 {
        return true;
    }
    let square_color = |sq: Square| (sq.get_file().to_index() + sq.get_rank().to_index()) % 2;
    knights == 0 && bishops.map(square_color).collect::<std::collections::HashSet<_>>().len() == 1
}

fn repetition_key(board: &Board) -> String {
    let fen = format!("{board}");
    fen.split_whitespace()
        .take(4)
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn play(game: &mut Game, uci: &str) {
        game.try_move_uci(uci).unwrap();
    }

    #[test]
    fn fifty_move_rule_draws_at_100_plies() {
        let mut g = Game::from_fen("4k3/8/8/8/8/8/8/R3K3 w - - 98 80").unwrap();
        play(&mut g, "a1a2");
        assert_eq!(g.state().status, "ongoing");
        play(&mut g, "e8d8");
        assert_eq!(g.state().status, "draw");
    }

    #[test]
    fn pawn_moves_and_captures_reset_the_clock() {
        let mut g = Game::from_fen("4k3/8/8/3p4/4P3/8/8/R3K3 w - - 40 60").unwrap();
        play(&mut g, "e4d5");
        assert_eq!(g.halfmove, 0);
        play(&mut g, "e8d7");
        assert_eq!(g.halfmove, 1);
    }

    #[test]
    fn undo_restores_the_clock() {
        let mut g = Game::from_fen("4k3/8/8/8/8/8/8/R3K3 w - - 7 30").unwrap();
        play(&mut g, "a1a2");
        assert_eq!(g.halfmove, 8);
        g.undo().unwrap();
        assert_eq!(g.halfmove, 7);
    }

    #[test]
    fn en_passant_counts_as_a_capture() {
        let mut g = Game::from_fen("4k3/8/8/3pP3/8/8/8/4K3 w - d6 12 40").unwrap();
        play(&mut g, "e5d6");
        assert_eq!(g.halfmove, 0);
    }

    #[test]
    fn insufficient_material_cases() {
        let dead = |fen: &str| Game::from_fen(fen).unwrap().state().status == "draw";
        assert!(dead("4k3/8/8/8/8/8/8/4K3 w - - 0 1"));
        assert!(dead("4k3/8/8/8/8/8/8/3NK3 w - - 0 1"));
        assert!(!dead("4k3/8/8/8/8/8/8/3NKN2 w - - 0 1"));
        assert!(!dead("4k3/8/8/8/8/8/P7/4K3 w - - 0 1"));
        assert!(dead("4kb2/8/8/8/8/8/8/2B1K3 w - - 0 1"));
        assert!(!dead("2b1k3/8/8/8/8/8/8/2B1K3 w - - 0 1"));
    }

    #[test]
    fn threefold_repetition_draws() {
        let mut g = Game::new();
        for _ in 0..2 {
            for mv in ["g1f3", "g8f6", "f3g1", "f6g8"] {
                play(&mut g, mv);
            }
        }
        assert_eq!(g.state().status, "draw");
    }

    #[test]
    fn castling_flags_for_a_moved_king_are_ignored() {
        assert!(Game::from_fen("4k3/8/8/8/8/8/8/R2K3R w KQ - 0 1").is_ok());
    }

    #[test]
    fn san_for_common_moves() {
        let mut g = Game::new();
        play(&mut g, "e2e4");
        play(&mut g, "g8f6");
        play(&mut g, "f1c4");
        assert_eq!(g.san_history, ["e4", "Nf6", "Bc4"]);
    }
}
