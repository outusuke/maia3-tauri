use chess::{BitBoard, Board, BoardStatus, ChessMove, Color, MoveGen, Piece, Square, ALL_SQUARES};

pub(crate) struct BrilliantInput<'a> {
    pub before: &'a Board,
    pub after: &'a Board,
    pub mv: ChessMove,
    pub mover: Color,
    pub eval_before_cp: i32,
    pub eval_after_cp: i32,
    pub max_eval_before_cp: i32,
    pub min_eval_after_cp: i32,
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

// Null move to hand over the turn; fails if that side is in check.
fn board_for_side(board: &Board, side: Color) -> Option<Board> {
    if board.side_to_move() == side {
        Some(*board)
    } else {
        board.null_move()
    }
}

fn captures_on(board: &Board, sq: Square, side: Color) -> Vec<ChessMove> {
    let Some(b) = board_for_side(board, side) else {
        return Vec::new();
    };
    let mut gen = MoveGen::new_legal(&b);
    gen.set_iterator_mask(BitBoard::from_square(sq));
    gen.collect()
}

// Standard SEE, cheapest attacker first.
fn see_on_square(board: &Board, sq: Square, side: Color) -> i32 {
    let Some(b) = board_for_side(board, side) else {
        return 0;
    };
    let Some(captured) = b.piece_on(sq) else {
        return 0;
    };
    let cheapest = captures_on(&b, sq, side)
        .into_iter()
        .filter_map(|mv| b.piece_on(mv.get_source()).map(|p| (mv, piece_value(p))))
        .min_by_key(|(_, value)| *value);
    let Some((mv, _)) = cheapest else {
        return 0;
    };
    let reply = see_on_square(&b.make_move_new(mv), sq, !side);
    (piece_value(captured) - reply).max(0)
}

// Equal trades on the moved piece's square don't count as unsafe.
fn unsafe_pieces(board: &Board, color: Color, played: Option<(ChessMove, i32)>) -> Vec<Square> {
    ALL_SQUARES
        .iter()
        .copied()
        .filter(|&sq| {
            let Some(piece) = board.piece_on(sq) else {
                return false;
            };
            if board.color_on(sq) != Some(color) || matches!(piece, Piece::Pawn | Piece::King) {
                return false;
            }
            if let Some((mv, captured_value)) = played {
                if mv.get_dest() == sq && captured_value >= piece_value(piece) {
                    return false;
                }
            }
            see_on_square(board, sq, !color) > 0
        })
        .collect()
}

// Taking the piece must always allow mate or an equal-or-bigger capture back.
fn has_counter_threat(board: &Board, sq: Square, color: Color) -> bool {
    let Some(piece) = board.piece_on(sq) else {
        return false;
    };
    let value = piece_value(piece);
    let takes = captures_on(board, sq, !color);
    if takes.is_empty() {
        return false;
    }
    takes.into_iter().all(|take| {
        let b = board.make_move_new(take);
        MoveGen::new_legal(&b).any(|reply| {
            let next = b.make_move_new(reply);
            if next.status() == BoardStatus::Checkmate {
                return true;
            }
            let target = reply.get_dest();
            target != sq
                && b.piece_on(target).is_some()
                && see_on_square(&b, target, color) >= value
        })
    })
}

fn is_trapped(board: &Board, sq: Square, color: Color) -> bool {
    let Some(b) = board_for_side(board, color) else {
        return false;
    };
    MoveGen::new_legal(&b)
        .filter(|mv| mv.get_source() == sq)
        .all(|mv| {
            let after = b.make_move_new(mv);
            let gained = b.piece_on(mv.get_dest()).map(piece_value).unwrap_or(0);
            see_on_square(&after, mv.get_dest(), !color) > gained
        })
}

pub(crate) fn is_brilliant(input: &BrilliantInput) -> bool {
    let BrilliantInput { before, after, mv, mover, .. } = *input;

    if input.eval_after_cp < input.min_eval_after_cp
        || input.eval_before_cp >= input.max_eval_before_cp
        || mv.get_promotion().is_some()
        || MoveGen::new_legal(before).count() <= 1
    {
        return false;
    }

    let captured_value = before.piece_on(mv.get_dest()).map(piece_value).unwrap_or(0);
    let previous_unsafe = unsafe_pieces(before, mover, None);
    let unsafe_now = unsafe_pieces(after, mover, Some((mv, captured_value)));

    if after.checkers().popcnt() == 0 && unsafe_now.len() < previous_unsafe.len() {
        return false;
    }

    if unsafe_now.iter().all(|&sq| has_counter_threat(after, sq, mover)) {
        return false;
    }

    let previous_trapped: Vec<Square> = previous_unsafe
        .iter()
        .copied()
        .filter(|&sq| is_trapped(before, sq, mover))
        .collect();
    let trapped_now = unsafe_now.iter().filter(|&&sq| is_trapped(after, sq, mover)).count();
    let moved_piece_was_trapped = previous_trapped.contains(&mv.get_source());

    if trapped_now == unsafe_now.len()
        || moved_piece_was_trapped
        || trapped_now < previous_trapped.len()
    {
        return false;
    }

    !unsafe_now.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn check(fen: &str, uci: &str, eval_before: i32, eval_after: i32) -> bool {
        let before = Board::from_str(fen).unwrap();
        let mv = ChessMove::from_str(uci).unwrap();
        let after = before.make_move_new(mv);
        is_brilliant(&BrilliantInput {
            before: &before,
            after: &after,
            mv,
            mover: before.side_to_move(),
            eval_before_cp: eval_before,
            eval_after_cp: eval_after,
            max_eval_before_cp: 300,
            min_eval_after_cp: 0,
        })
    }

    fn fen_after(sans: &str) -> String {
        let mut board = Board::default();
        for san in sans.split(' ') {
            board = board.make_move_new(ChessMove::from_san(&board, san).unwrap());
        }
        format!("{board}")
    }

    #[test]
    fn knight_fork_that_just_trades_is_not_brilliant() {
        let fen = fen_after("e4 c6 Nc3 d5 Nf3 Bg4 h3 Bh5 exd5 Nf6 d4 cxd5 Bg5 e6 Bxf6 Qxf6 Bd3 Bd6 Qe2 Nc6 g4 Bg6 Bxg6 Qxg6 O-O-O O-O Ne5 Qg5+ Kb1 Nxe5 dxe5 Bxe5 Rhf1 a6 f4 Bxf4 Qf2 Bd6 Qb6 Qe7 Rfe1 Rac8 Nxd5 Qd7");
        assert!(!check(&fen, "d5f6", 0, 0));
        assert!(!check(&fen, "d5f6", 0, -140));
    }

    #[test]
    fn legals_mate_sacrifice() {
        let fen = fen_after("e4 e5 Nf3 d6 Bc4 Bg4 Nc3 g6");
        assert!(check(&fen, "f3e5", 30, 40));
        assert!(!check(&fen, "f3e5", 30, -150));
        assert!(!check(&fen, "f3e5", 400, 400));
    }
}
