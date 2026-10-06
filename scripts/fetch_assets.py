#!/usr/bin/env python3
"""Pulls everything the desktop build bundles: ONNX Runtime, the Maia models and the Stockfish binary.

usage: fetch_assets.py [--ort] [--stockfish] [--models ID ...]   (no flags = all three)
Models come from the "models" release; gh needs GH_TOKEN, set automatically in Actions.
"""
import argparse
import io
import os
import pathlib
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / "src-tauri" / "resources" / "models"
ORT_DIR = ROOT / "src-tauri" / "resources" / "ort"
SF_DIR = ROOT / "src-tauri" / "resources" / "stockfish"

ORT_VERSION = os.environ.get("ORT_VERSION", "1.30.0")
SF_TAG = os.environ.get("STOCKFISH_TAG")


def get(url: str) -> bytes:
    print(f"GET {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "maia-chess-build"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.read()


def clear(dest: pathlib.Path, keep: str = "README.txt") -> None:
    dest.mkdir(parents=True, exist_ok=True)
    for f in dest.iterdir():
        if f.is_file() and f.name != keep:
            f.unlink()


def fetch_ort() -> None:
    machine = platform.machine().lower()
    arm = machine in ("arm64", "aarch64")
    system = platform.system()
    if system == "Windows":
        name, ext = f"onnxruntime-win-{'arm64' if arm else 'x64'}-{ORT_VERSION}", "zip"
    elif system == "Linux":
        name, ext = f"onnxruntime-linux-{'aarch64' if arm else 'x64'}-{ORT_VERSION}", "tgz"
    else:
        sys.exit(f"no ONNX Runtime package wired up for {system}")

    data = get(f"https://github.com/microsoft/onnxruntime/releases/download/v{ORT_VERSION}/{name}.{ext}")
    clear(ORT_DIR)
    if ext == "zip":
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for member in z.namelist():
                base = pathlib.PurePosixPath(member).name
                if "/lib/" in member and base in ("onnxruntime.dll", "onnxruntime_providers_shared.dll"):
                    (ORT_DIR / base).write_bytes(z.read(member))
    else:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as t:
            for member in t.getmembers():
                base = pathlib.PurePosixPath(member.name).name
                # the symlinks point at this real file, so skip them
                if member.isfile() and base.startswith("libonnxruntime.so"):
                    (ORT_DIR / base).write_bytes(t.extractfile(member).read())
    if not any(f.name.startswith(("onnxruntime.dll", "libonnxruntime.so")) for f in ORT_DIR.iterdir()):
        sys.exit(f"no ONNX Runtime library found in {name}.{ext}")
    print("ORT:", sorted(f.name for f in ORT_DIR.iterdir()))


def fetch_models(ids: list[str]) -> None:
    clear(MODELS_DIR)
    for model in ids:
        r = subprocess.run(
            ["gh", "release", "download", "models", "--pattern", f"{model}.onnx", "--dir", str(MODELS_DIR), "--clobber"]
        )
        if r.returncode:
            sys.exit(f"couldn't download {model}.onnx; run the Models workflow first and make sure it published")
    print("models:", sorted(f.name for f in MODELS_DIR.iterdir()))


def fetch_stockfish() -> None:
    system = platform.system()
    arm = platform.machine().lower() in ("arm64", "aarch64")
    arch = "arm64" if arm else "x86-64"
    if system == "Windows":
        name, ext = f"stockfish-windows-{arch}-universal", "zip"
    elif system == "Linux":
        name, ext = f"stockfish-linux-{arch}-universal", "tar.gz"
    else:
        sys.exit(f"no Stockfish package wired up for {system}")

    base = "releases/latest/download" if not SF_TAG else f"releases/download/{SF_TAG}"
    data = get(f"https://github.com/official-stockfish/Stockfish/{base}/{name}.{ext}")

    # the archive also holds docs and sources, so take the biggest file that looks like the engine
    exe = "stockfish.exe" if system == "Windows" else "stockfish"
    is_engine = lambda n: n.lower().startswith("stockfish") and (n.lower().endswith(".exe") if system == "Windows" else "." not in n)
    best, best_size = None, -1
    if ext == "zip":
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for info in z.infolist():
                if is_engine(pathlib.PurePosixPath(info.filename).name) and info.file_size > best_size:
                    best, best_size = z.read(info), info.file_size
    else:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as t:
            for member in t.getmembers():
                if member.isfile() and is_engine(pathlib.PurePosixPath(member.name).name) and member.size > best_size:
                    best, best_size = t.extractfile(member).read(), member.size
    if best is None:
        sys.exit(f"no Stockfish executable found in {name}.{ext}")

    clear(SF_DIR)
    (SF_DIR / exe).write_bytes(best)
    (SF_DIR / exe).chmod(0o755)
    print("stockfish:", sorted(f.name for f in SF_DIR.iterdir()))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ort", action="store_true")
    ap.add_argument("--stockfish", action="store_true")
    ap.add_argument("--models", nargs="*")
    args = ap.parse_args()
    everything = not (args.ort or args.stockfish or args.models is not None)

    if args.ort or everything:
        fetch_ort()
    if args.stockfish or everything:
        fetch_stockfish()
    if args.models is not None or everything:
        fetch_models(args.models or os.environ.get("MODELS", "maia3-23m").split())
    return 0


if __name__ == "__main__":
    shutil.which("gh") or print("warning: gh not found, model download will fail")
    sys.exit(main())
