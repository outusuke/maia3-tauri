// Sacrifice check ported from En Croissant (src-tauri/src/chess.rs, GPL-3.0).

use chess::{Board, BoardStatus, ChessMove, MoveGen, Piece};

const MATE_SCORE: i32 = 10_000;
const SACRIFICE_MARGIN: i32 = 100;

fn piece_value(piece: Piece) -> i32 {
    match piece {
        Piece::Pawn => 90,
        Piece::Knight | Piece::Bishop => 300,
        Piece::Rook => 500,
        Piece::Queen => 1000,
        Piece::King => 0,
    }
}

fn material_for_side_to_move(board: &Board) -> i32 {
    if board.status() == BoardStatus::Checkmate {
        return -MATE_SCORE;
    }
    let me = board.side_to_move();
    [Piece::Pawn, Piece::Knight, Piece::Bishop, Piece::Rook, Piece::Queen]
        .into_iter()
        .map(|piece| {
            let mine = (board.pieces(piece) & *board.color_combined(me)).popcnt() as i32;
            let theirs = (board.pieces(piece) & *board.color_combined(!me)).popcnt() as i32;
            piece_value(piece) * (mine - theirs)
        })
        .sum()
}

fn captured_piece(board: &Board, mv: ChessMove) -> Option<Piece> {
    board.piece_on(mv.get_dest()).or_else(|| {
        // a pawn changing file onto an empty square can only be en passant
        let en_passant = board.piece_on(mv.get_source()) == Some(Piece::Pawn)
            && mv.get_source().get_file() != mv.get_dest().get_file();
        en_passant.then_some(Piece::Pawn)
    })
}

fn qsearch(board: &Board, mut alpha: i32, beta: i32) -> i32 {
    let stand_pat = material_for_side_to_move(board);
    if stand_pat >= beta {
        return beta;
    }
    alpha = alpha.max(stand_pat);

    let mut captures: Vec<(ChessMove, Piece)> = MoveGen::new_legal(board)
        .filter_map(|mv| captured_piece(board, mv).map(|piece| (mv, piece)))
        .collect();
    captures.sort_by_key(|(_, piece)| -piece_value(*piece));

    for (mv, _) in captures {
        let score = -qsearch(&board.make_move_new(mv), -beta, -alpha);
        if score >= beta {
            return beta;
        }
        alpha = alpha.max(score);
    }
    alpha
}

fn naive_eval(board: &Board) -> i32 {
    MoveGen::new_legal(board)
        .map(|mv| -qsearch(&board.make_move_new(mv), i32::MIN, i32::MAX))
        .max()
        .unwrap_or(i32::MIN)
}

// Mover's capture-only outlook drops by more than a pawn.
pub(crate) fn is_sacrifice(before: &Board, after: &Board) -> bool {
    if after.status() != BoardStatus::Ongoing {
        return false;
    }
    naive_eval(before) > -naive_eval(after) + SACRIFICE_MARGIN
}
