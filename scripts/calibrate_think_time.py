#!/usr/bin/env python3
"""Fits the bot's think-time model to how long real Lichess blitz players think.

Streams a monthly dump, asks maia-uci for its policy at each sampled position, and regresses
ln(think time) on Maia's move spread (A), plus position cues (B), plus chosen-move cues (C).
Scores are on held-out games.

usage: calibrate_think_time.py --maia PATH --onnx MODEL [--ort LIBRARY] [--positions 6000] [--url URL | --pgn FILE]
needs: pip install chess zstandard numpy
"""
import argparse
import io
import json
import math
import os
import random
import re
import statistics
import subprocess
import sys
import time
import urllib.request

import chess
import chess.pgn
import numpy as np

DEFAULT_URL = "https://database.lichess.org/standard/lichess_db_standard_rated_2025-09.pgn.zst"
BANDS = [(0, 1200), (1200, 1600), (1600, 2000), (2000, 4000)]
OPENING_PLIES = 12
MIN_CLOCK = 5.0
PER_GAME = 3
OFFSET = 0.25  # keeps ln() finite for near-instant moves
QUANTILES = (0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95)

# current values in timing.rs
OLD_BASE, OLD_PER_NAT, OLD_OPENING = 0.3, 1.5, 0.5

FEATURES_A = ["ln_neff"]
FEATURES_B = FEATURES_A + ["top_prob", "ln_legal", "forced", "recapture", "in_check", "last_capture",
                           "opening", "endgame", "ln_clock", "low_clock", "ln_tc", "rating"]
FEATURES_C = FEATURES_B + ["ln_p_move", "move_capture", "move_check"]


def band_of(rating):
    for i, (lo, hi) in enumerate(BANDS):
        if lo <= rating < hi:
            return i
    return None


def keep_headers(h):
    if "Blitz" not in h.get("Event", "") or "FEN" in h:
        return False
    if "BOT" in (h.get("WhiteTitle"), h.get("BlackTitle")):
        return False
    return h.get("WhiteElo", "?").isdigit() and h.get("BlackElo", "?").isdigit() and bool(re.fullmatch(r"\d+\+\d+", h.get("TimeControl", "")))


class SkippingBuilder(chess.pgn.GameBuilder):
    def end_headers(self):
        return None if keep_headers(self.game.headers) else chess.pgn.SKIP


def open_source(args):
    if args.pgn:
        raw = open(args.pgn, "rb")
        name = args.pgn
    else:
        request = urllib.request.Request(args.url, headers={"User-Agent": "maia3-calibrate"})
        raw = urllib.request.urlopen(request)
        name = args.url
    if name.endswith(".zst"):
        import zstandard
        raw = zstandard.ZstdDecompressor().stream_reader(raw)
    return io.TextIOWrapper(raw, encoding="utf-8", errors="replace")


def games(handle):
    while True:
        game = chess.pgn.read_game(handle, Visitor=SkippingBuilder)
        if game is None:
            return
        if keep_headers(game.headers):
            yield game


def samples_from(game, game_no, rng, quota_left):
    base, inc = (int(x) for x in game.headers["TimeControl"].split("+"))
    nodes = list(game.mainline())
    clocks = [n.clock() for n in nodes]
    if len(nodes) < 24 or any(c is None for c in clocks):
        return []
    ucis = [n.move.uci() for n in nodes]
    ratings = (int(game.headers["WhiteElo"]), int(game.headers["BlackElo"]))
    picks = []
    for i in rng.sample(range(2, len(nodes)), PER_GAME):
        rating = ratings[i % 2]
        band = band_of(rating)
        before = clocks[i - 2]
        if band is None or quota_left[band] <= 0 or before < MIN_CLOCK:
            continue
        think = max(0.0, before + inc - clocks[i])
        picks.append({"game": game_no, "ply": i, "rating": rating, "band": band, "clock": before, "think": think,
                      "base": base, "inc": inc, "ucis": ucis[:i], "move": ucis[i]})
    return picks


class Maia:
    def __init__(self, binary, onnx, ort):
        env = dict(os.environ)
        if ort:
            env["ORT_DYLIB_PATH"] = ort
        self.proc = subprocess.Popen(
            [binary, "--onnx", onnx, "--history", "8", "--use-uci-history", "--multipv", "0"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env, bufsize=1)
        self.send("uci")
        self.wait("uciok")
        self.send("isready")
        self.wait("readyok")

    def send(self, line):
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()

    def wait(self, prefix):
        for line in self.proc.stdout:
            if line.startswith(prefix):
                return line
        raise RuntimeError(f"maia exited before '{prefix}'")

    def policy(self, ucis, rating):
        self.send(f"position fen {chess.STARTING_FEN} moves {' '.join(ucis)}")
        self.send(f"insights {rating}")
        data = json.loads(self.wait("insights ")[len("insights "):])
        return data["policies"][0] if data["policies"] else None

    def close(self):
        try:
            self.send("quit")
        except OSError:
            pass


def effective_moves(policy):
    total = sum(p for p in policy.values() if p > 0)
    if total <= 0:
        return 1.0
    return math.exp(-sum(p / total * math.log(p / total) for p in policy.values() if p > 0))


def build_board(ucis):
    # board before the mover's move, plus the opponent's last-capture flag and square
    board = chess.Board()
    last_capture, last_to = False, None
    for u in ucis:
        m = chess.Move.from_uci(u)
        last_capture, last_to = board.is_capture(m), m.to_square
        board.push(m)
    return board, last_capture, last_to


def feature_row(s, policy):
    board, last_capture, last_to = build_board(s["ucis"])
    legal = list(board.legal_moves)
    mv = chess.Move.from_uci(s["move"])
    total = sum(p for p in policy.values() if p > 0) or 1.0
    p_move = max(1e-3, policy.get(s["move"], 0.0) / total)
    recapture = last_capture and any(m.to_square == last_to and board.is_capture(m) for m in legal)
    return {
        "ln_neff": math.log(effective_moves(policy)),
        "top_prob": max(policy.values()) / total,
        "ln_legal": math.log(max(1, len(legal))),
        "forced": float(len(legal) == 1),
        "recapture": float(recapture),
        "in_check": float(board.is_check()),
        "last_capture": float(last_capture),
        "opening": float(s["ply"] < OPENING_PLIES),
        "endgame": float(len(board.piece_map()) <= 10),
        "ln_clock": math.log(s["clock"] + 1),
        "low_clock": float(s["clock"] < 15),
        "ln_tc": math.log(s["base"] + 40 * s["inc"] + 1),
        "rating": (s["rating"] - 1500) / 500,
        "ln_p_move": math.log(p_move),
        "move_capture": float(board.is_capture(mv)),
        "move_check": float(board.gives_check(mv)),
    }


def matrix(rows, names):
    return np.array([[r["f"][n] for n in names] for r in rows], dtype=float)


def target(rows):
    return np.array([math.log(r["think"] + OFFSET) for r in rows])


def fit_ridge(X, y, lam=1.0):
    # ridge on standardised features, coefficients returned in raw units
    mu, sd = X.mean(0), X.std(0)
    sd[sd < 1e-9] = 1.0
    A = np.hstack([(X - mu) / sd, np.ones((len(X), 1))])
    reg = lam * np.eye(A.shape[1])
    reg[-1, -1] = 0.0
    w = np.linalg.solve(A.T @ A + reg, A.T @ y)
    coef = w[:-1] / sd
    return coef, float(w[-1] - (coef * mu).sum())


def to_seconds(log_pred):
    return np.maximum(0.0, np.exp(log_pred) - OFFSET)


def ranks(xs):
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    out = [0.0] * len(xs)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        for k in range(i, j + 1):
            out[order[k]] = (i + j) / 2
        i = j + 1
    return out


def pearson(xs, ys):
    xs, ys = np.asarray(xs, float), np.asarray(ys, float)
    if xs.std() == 0 or ys.std() == 0:
        return 0.0
    return float(np.corrcoef(xs, ys)[0, 1])


def score_line(label, pred_secs, rows):
    ts = np.array([r["think"] for r in rows])
    pred_secs = np.asarray(pred_secs, float)
    spear = pearson(ranks(list(pred_secs)), ranks(list(ts)))
    log_r = pearson(np.log(pred_secs + OFFSET), np.log(ts + OFFSET))
    mae = float(np.median(np.abs(pred_secs - ts)))
    print(f"  {label:<34} r(sec) {pearson(pred_secs, ts):+.3f}   spearman {spear:+.3f}   r(log) {log_r:+.3f}   median abs err {mae:.1f}s")
    return log_r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--maia", required=True, help="path to the maia-uci binary")
    ap.add_argument("--onnx", required=True, help="a Maia model, e.g. maia3-23m.onnx")
    ap.add_argument("--ort", help="libonnxruntime path if ORT_DYLIB_PATH isn't set")
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--pgn", help="read this local .pgn or .pgn.zst instead of downloading")
    ap.add_argument("--positions", type=int, default=6000)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--csv", help="also write the collected samples here")
    ap.add_argument("--json", help="also write the fitted models here")
    args = ap.parse_args()

    rng = random.Random(args.seed)
    quota_left = [args.positions // len(BANDS)] * len(BANDS)
    maia = Maia(args.maia, args.onnx, args.ort)
    rows, started, scanned, shown = [], time.time(), 0, 0
    try:
        for game in games(open_source(args)):
            scanned += 1
            for s in samples_from(game, scanned, rng, quota_left):
                if quota_left[s["band"]] <= 0:
                    continue
                policy = maia.policy(s["ucis"], max(600, min(2600, round(s["rating"] / 100) * 100)))
                if not policy:
                    continue
                s["f"] = feature_row(s, policy)
                del s["ucis"]
                rows.append(s)
                quota_left[s["band"]] -= 1
            if len(rows) // 250 > shown:
                shown = len(rows) // 250
                print(f"  {len(rows)} positions from {scanned} games, {time.time() - started:.0f}s", file=sys.stderr)
            if all(q <= 0 for q in quota_left):
                break
    finally:
        maia.close()

    if len(rows) < 200:
        sys.exit(f"only {len(rows)} usable positions; try a bigger --positions or another dump")
    if args.csv:
        names = FEATURES_C
        with open(args.csv, "w") as f:
            f.write("game,rating,ply,clock,base,inc,think," + ",".join(names) + "\n")
            for r in rows:
                f.write(f"{r['game']},{r['rating']},{r['ply']},{r['clock']:.1f},{r['base']},{r['inc']},{r['think']:.2f},"
                        + ",".join(f"{r['f'][n]:.4f}" for n in names) + "\n")

    train = [r for r in rows if r["game"] % 10 < 7]
    test = [r for r in rows if r["game"] % 10 >= 7]
    y_train, y_test = target(train), target(test)

    print(f"\n{len(rows)} positions ({len(train)} to fit, {len(test)} to check), {scanned} games read\n")

    print("Median real think time, seconds, by rating band:")
    for i, (lo, hi) in enumerate(BANDS):
        band = [r for r in rows if r["band"] == i]
        if band:
            print(f"  {lo:>4}-{hi:<4} n={len(band):<5} median {statistics.median(r['think'] for r in band):.1f}s   "
                  f"mean ln(effective moves) {sum(r['f']['ln_neff'] for r in band) / len(band):.2f}")

    print("\nShare of moves played almost instantly (under 0.5s):")
    for label, sel in (("opening (first 12 plies)", [r for r in rows if r["ply"] < OPENING_PLIES]),
                       ("middlegame and later", [r for r in rows if r["ply"] >= OPENING_PLIES]),
                       ("recapture available", [r for r in rows if r["f"]["recapture"]]),
                       ("only one legal move", [r for r in rows if r["f"]["forced"]])):
        if sel:
            print(f"  {label:<26} n={len(sel):<5} {100 * sum(r['think'] < 0.5 for r in sel) / len(sel):.0f}%")

    models = {}
    for key, names in (("A", FEATURES_A), ("B", FEATURES_B), ("C", FEATURES_C)):
        coef, icpt = fit_ridge(matrix(train, names), y_train)
        resid = y_train - (matrix(train, names) @ coef + icpt)
        models[key] = {"names": names, "coef": coef, "icpt": icpt,
                       "resid_q": {str(q): float(np.quantile(resid, q)) for q in QUANTILES}}

    def predict(key, rs):
        m = models[key]
        return matrix(rs, m["names"]) @ m["coef"] + m["icpt"]

    const = float(np.median(y_train))
    old = [(OLD_BASE + OLD_PER_NAT * r["f"]["ln_neff"]) * (OLD_OPENING if r["ply"] < OPENING_PLIES else 1.0) for r in test]

    print("\nHow well each model tracks real think times on games it was not fitted on")
    print("(for reference, the ChessMimic paper reports r about 0.41 and Allie 0.70, on their own data):")
    score_line("same time every move", np.full(len(test), float(to_seconds(const))), test)
    score_line(f"current timing.rs ({OLD_BASE} + {OLD_PER_NAT}*ln n)", old, test)
    score_line("A  Maia spread only", to_seconds(predict("A", test)), test)
    score_line("B  + position cues", to_seconds(predict("B", test)), test)
    score_line("C  + chosen-move cues", to_seconds(predict("C", test)), test)

    for key in ("B", "C"):
        m = models[key]
        sigma = float(np.std(y_test - predict(key, test)))
        print(f"\nModel {key} coefficients on ln(think + {OFFSET}); intercept {m['icpt']:+.3f}, held-out residual sigma {sigma:.2f}")
        for n, c in sorted(zip(m["names"], m["coef"]), key=lambda t: -abs(t[1])):
            print(f"  {n:<14} {c:+.3f}")

    base_case = {n: 0.0 for n in FEATURES_B}
    base_case.update({"ln_tc": math.log(301), "ln_clock": math.log(151), "top_prob": 0.4, "ln_legal": math.log(30), "ln_neff": math.log(10)})
    scenarios = [
        ("quiet middlegame, 10 plausible moves", {}),
        ("quiet middlegame, 3 plausible moves", {"ln_neff": math.log(3), "top_prob": 0.7}),
        ("quiet middlegame, 30 plausible moves", {"ln_neff": math.log(30), "top_prob": 0.15}),
        ("recapture available", {"recapture": 1.0, "last_capture": 1.0, "ln_neff": math.log(3), "top_prob": 0.7}),
        ("only legal move (in check)", {"forced": 1.0, "in_check": 1.0, "ln_legal": 0.0, "ln_neff": 0.0, "top_prob": 1.0}),
        ("in check, several replies", {"in_check": 1.0, "ln_neff": math.log(4), "top_prob": 0.5, "ln_legal": math.log(6)}),
        ("opening move 6", {"opening": 1.0, "ln_neff": math.log(6), "top_prob": 0.5}),
        ("10 seconds left", {"ln_clock": math.log(11), "low_clock": 1.0}),
        ("endgame, 10 plausible moves", {"endgame": 1.0}),
    ]
    mb = models["B"]
    print("\nModel B pause in typical situations (rating 1500, 5+0, 150s left unless stated): 10th / median / 90th percentile seconds")
    for label, delta in scenarios:
        d = dict(base_case, **delta)
        pred = sum(c * d[n] for n, c in zip(mb["names"], mb["coef"])) + mb["icpt"]
        lo, mid, hi = (float(to_seconds(pred + mb["resid_q"][str(q)])) for q in (0.1, 0.5, 0.9))
        print(f"  {label:<40} {lo:5.1f} / {mid:5.1f} / {hi:5.1f}")

    if args.json:
        with open(args.json, "w") as f:
            json.dump({"target": f"ln(think_seconds + {OFFSET})", "opening_plies": OPENING_PLIES,
                       "models": {k: {"features": v["names"], "coef": [float(c) for c in v["coef"]],
                                      "intercept": v["icpt"], "residual_quantiles": v["resid_q"]}
                                  for k, v in models.items()}}, f, indent=2)

    print("\nMODEL_JSON " + json.dumps({k: {"features": v["names"], "coef": [round(float(c), 4) for c in v["coef"]],
                                            "intercept": round(v["icpt"], 4),
                                            "residual_quantiles": {q: round(x, 3) for q, x in v["resid_q"].items()}}
                                        for k, v in models.items() if k != "A"}))


if __name__ == "__main__":
    main()
