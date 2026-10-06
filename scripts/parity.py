#!/usr/bin/env python3
"""Compares the Python and Rust Maia engines on the same positions.

usage: parity.py <model.onnx> <maia3_onnx_uci.py> <maia-uci binary>
"""
import json
import random
import subprocess
import sys

import chess

ELOS = [1100, 1500, 1900]


def run(cmd, lines):
    try:
        p = subprocess.run(cmd, input="\n".join(lines + ["quit"]) + "\n", capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired as e:
        err = e.stderr.decode(errors="replace") if isinstance(e.stderr, bytes) else (e.stderr or "")
        print(err[-2000:])
        raise SystemExit(f"{cmd[0]} timed out")
    if p.returncode != 0:
        print(p.stderr[-2000:])
        raise SystemExit(f"{cmd[0]} exited with {p.returncode}")
    return p.stdout.splitlines()


def pick(out, prefix):
    return [l for l in out if l.startswith(prefix)]


def random_game(rng, plies):
    b = chess.Board()
    moves = []
    for _ in range(plies):
        if b.is_game_over():
            break
        m = rng.choice(list(b.legal_moves))
        moves.append(m.uci())
        b.push(m)
    return moves


def main():
    model, py_script, rust_bin = sys.argv[1:4]
    flags = ["--history", "8", "--use-uci-history"]
    py = [sys.executable, py_script, "--onnx", model] + flags
    rs = [rust_bin, "--onnx", model] + flags

    rng = random.Random(1234)
    cases = []
    for n in range(40):
        moves = random_game(rng, rng.randint(0, 70))
        cases.append(("startpos", moves))
    for fen in [
        "r3k2r/pppq1ppp/2npbn2/2b1p3/2B1P3/2NP1N2/PPPQ1PPP/R3K2R w KQkq - 4 8",   # castling both sides
        "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3",          # en passant available
        "8/P6k/8/8/8/8/p6K/8 w - - 0 1",                                          # promotions
        "8/P6k/8/8/8/8/p6K/8 b - - 0 1",
    ]:
        cases.append(("fen " + fen, []))

    mismatches, soft = 0, 0
    for idx, (base, moves) in enumerate(cases):
        pos = f"position {base}" + (" moves " + " ".join(moves) if moves else "")
        script = ["uci", "isready", "setoption name Elo value 1500", pos, "go nodes 1", "insights " + " ".join(map(str, ELOS))]
        if moves:
            script.append("estimate " + ",".join(str(i) for i in range(len(moves))) + " " + " ".join(map(str, ELOS)))
        a, b = run(py, script), run(rs, script)

        ba, bb = pick(a, "bestmove"), pick(b, "bestmove")
        if ba != bb:
            # near ties can flip on float noise, so check the policy gap first
            ia = json.loads(pick(a, "insights ")[0][len("insights "):])
            pol = ia["policies"][1] if ia["policies"] else {}
            ma, mb = ba[0].split()[1], bb[0].split()[1]
            gap = abs(pol.get(ma, 0) - pol.get(mb, 0))
            if gap < 0.01:
                soft += 1
                print(f"[{idx}] near-tie flip {ma} vs {mb} (policy gap {gap:.4f})")
            else:
                mismatches += 1
                print(f"[{idx}] BESTMOVE MISMATCH {ba} vs {bb}  ({pos[:90]})")

        ja = json.loads(pick(a, "insights ")[0][len("insights "):])
        jb = json.loads(pick(b, "insights ")[0][len("insights "):])
        for k in range(len(ja["policies"])):
            for mv, p in ja["policies"][k].items():
                q = jb["policies"][k].get(mv, 0.0)
                if abs(p - q) > 0.01:
                    mismatches += 1
                    print(f"[{idx}] policy {ELOS[k]} {mv}: {p} vs {q}")
            if abs(ja["winProb"][k] - jb["winProb"][k]) > 0.01:
                mismatches += 1
                print(f"[{idx}] winProb {ELOS[k]}: {ja['winProb'][k]} vs {jb['winProb'][k]}")

        if moves:
            ea = json.loads(pick(a, "estimate ")[0][len("estimate "):])["plies"]
            eb = json.loads(pick(b, "estimate ")[0][len("estimate "):])["plies"]
            if [e["ply"] for e in ea] != [e["ply"] for e in eb]:
                mismatches += 1
                print(f"[{idx}] estimate ply lists differ")
            else:
                for x, y in zip(ea, eb):
                    if any(abs(u - v) > 0.02 for u, v in zip(x["logp"], y["logp"])):
                        mismatches += 1
                        print(f"[{idx}] estimate ply {x['ply']}: {x['logp']} vs {y['logp']}")

    print(f"{len(cases)} positions, {mismatches} mismatches, {soft} near-tie flips")
    return 1 if mismatches else 0


if __name__ == "__main__":
    sys.exit(main())
