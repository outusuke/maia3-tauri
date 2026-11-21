#!/usr/bin/env python3
"""How often real Lichess players blunder, by clock left, using the Stockfish evals stored in the dump."""
import argparse
import io
import math
import re
import sys
import time
import urllib.request

import chess.pgn

DEFAULT_URL = "https://database.lichess.org/standard/lichess_db_standard_rated_2025-09.pgn.zst"
BANDS = [(0, 1200), (1200, 1600), (1600, 2000), (2000, 4000)]
FRACTIONS = [(0, 0.05), (0.05, 0.1), (0.1, 0.2), (0.2, 0.4), (0.4, 0.7), (0.7, 5)]
SECONDS = [(0, 5), (5, 10), (10, 20), (20, 40), (40, 90), (90, 1e9)]


def win_pct(cp):
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)


def raw_games(handle):
    chunk = []
    for line in handle:
        if line.startswith("[Event ") and chunk:
            yield "".join(chunk)
            chunk = []
        chunk.append(line)
    if chunk:
        yield "".join(chunk)


def wanted(text, event, tcs):
    if "[%eval" not in text or "[%clk" not in text or "[FEN " in text or "Title \"BOT\"" in text:
        return None
    m = re.search(r'\[Event "([^"]*)"', text)
    t = re.search(r'\[TimeControl "(\d+)\+(\d+)"', text)
    if not m or not t or event not in m.group(1):
        return None
    tc = f"{t.group(1)}+{t.group(2)}"
    return (int(t.group(1)), int(t.group(2))) if not tcs or tc in tcs else None


def moves_from(game, base, inc):
    nodes = list(game.mainline())
    if len(nodes) < 24:
        return
    cps = [n.eval().white().score(mate_score=10000) if n.eval() else None for n in nodes]
    clocks = [n.clock() for n in nodes]
    ratings = (int(game.headers.get("WhiteElo", 0) or 0), int(game.headers.get("BlackElo", 0) or 0))
    for i in range(2, len(nodes)):
        if cps[i] is None or cps[i - 1] is None or clocks[i - 2] is None:
            continue
        sign = 1 if i % 2 == 0 else -1
        before, after = win_pct(sign * cps[i - 1]), win_pct(sign * cps[i])
        if not 20 <= before <= 80:
            continue
        yield {"rating": ratings[i % 2], "ply": i, "clock": clocks[i - 2], "base": base, "loss": before - after}


def bucket(value, table):
    for k, (lo, hi) in enumerate(table):
        if lo <= value < hi:
            return k
    return None


def report(title, labels, groups):
    print(f"\n{title}")
    for label, g in zip(labels, groups):
        if len(g) >= 50:
            n = len(g)
            print(f"  {label:<14} n={n:6d}  blunder {sum(x >= 30 for x in g) / n:6.2%}  mistake {sum(20 <= x < 30 for x in g) / n:6.2%}"
                  f"  inaccuracy {sum(10 <= x < 20 for x in g) / n:6.2%}  mean loss {sum(g) / n:5.2f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--pgn", help="local .pgn or .pgn.zst instead of downloading")
    ap.add_argument("--events", default="Blitz")
    ap.add_argument("--tc", default="", help='e.g. "180+0,300+0"; blank keeps every control')
    ap.add_argument("--games", type=int, default=4000, help="analysed games to use")
    ap.add_argument("--csv")
    args = ap.parse_args()
    tcs = {t.strip() for t in args.tc.split(",") if t.strip()}

    if args.pgn:
        raw, name = open(args.pgn, "rb"), args.pgn
    else:
        raw = urllib.request.urlopen(urllib.request.Request(args.url, headers={"User-Agent": "maia3-calibrate"}))
        name = args.url
    if name.endswith(".zst"):
        import zstandard
        raw = zstandard.ZstdDecompressor().stream_reader(raw)

    rows, used, scanned, started = [], 0, 0, time.time()
    for text in raw_games(io.TextIOWrapper(raw, encoding="utf-8", errors="replace")):
        scanned += 1
        tc = wanted(text, args.events, tcs)
        if tc is None:
            continue
        game = chess.pgn.read_game(io.StringIO(text))
        found = list(moves_from(game, *tc))
        if found:
            rows += found
            used += 1
            if used % 500 == 0:
                print(f"  {used} games with evals, {scanned} scanned, {time.time() - started:.0f}s", file=sys.stderr)
        if used >= args.games:
            break
    if not rows:
        sys.exit("no games with evals and clocks matched; check --events and --tc")

    print(f"{used} analysed games, {len(rows)} moves in positions between 20% and 80% win chance")
    print("a blunder loses 30+ win-percentage points, a mistake 20-30, an inaccuracy 10-20 (Lichess's own scale)")
    for r in rows:
        r["fr"] = r["clock"] / r["base"]
    groups = lambda key, table: [[r["loss"] for r in rows if bucket(key(r), table) == k] for k in range(len(table))]
    report("By clock left, as a share of the starting time",
           [f"{lo:.0%}-{min(hi, 1.2):.0%}" for lo, hi in FRACTIONS], groups(lambda r: r["fr"], FRACTIONS))
    report("By seconds left", [f"{lo}-{'inf' if hi > 1e6 else hi}s" for lo, hi in SECONDS], groups(lambda r: r["clock"], SECONDS))
    for name_, sel in [("opening, first 24 plies", lambda r: r["ply"] < 24), ("later", lambda r: r["ply"] >= 24)]:
        sub = [r for r in rows if sel(r)]
        report(f"By clock share, {name_}", [f"{lo:.0%}-{min(hi, 1.2):.0%}" for lo, hi in FRACTIONS],
               [[r["loss"] for r in sub if bucket(r["fr"], FRACTIONS) == k] for k in range(len(FRACTIONS))])
    report("By rating", [f"{lo}-{hi}" for lo, hi in BANDS], groups(lambda r: r["rating"], BANDS))

    if args.csv:
        with open(args.csv, "w") as f:
            f.write("rating,ply,clock,base,loss\n")
            for r in rows:
                f.write(f"{r['rating']},{r['ply']},{r['clock']},{r['base']},{r['loss']:.2f}\n")


if __name__ == "__main__":
    main()
