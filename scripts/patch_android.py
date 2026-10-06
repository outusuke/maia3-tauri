#!/usr/bin/env python3
"""Run after `cargo tauri android init`. Packs the native libs into jniLibs and the models into assets.

usage: patch_android.py <libmultistockfish_light.so> [abi, default arm64-v8a] --ort path/to/libonnxruntime.so [--model path/to/maia3-5m.onnx ...]

--ort is libonnxruntime.so from the onnxruntime-android AAR (1.28.x; the ort crate accepts 1.17 or newer).
The Stockfish library comes from lichess-org/dart-multistockfish (see the Android workflow).
Models end up in assets/models/<id>.onnx and are read straight out of the APK.
"""
import pathlib
import re
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP = ROOT / "src-tauri" / "gen" / "android" / "app"


def main() -> int:
    args = sys.argv[1:]
    models: list[pathlib.Path] = []
    ort_lib: pathlib.Path | None = None
    if "--ort" in args:
        i = args.index("--ort")
        if i + 1 >= len(args):
            print(__doc__)
            return 2
        ort_lib = pathlib.Path(args[i + 1])
        del args[i : i + 2]
    while "--model" in args:
        i = args.index("--model")
        if i + 1 >= len(args):
            print(__doc__)
            return 2
        models.append(pathlib.Path(args[i + 1]))
        del args[i : i + 2]
    if not args:
        print(__doc__)
        return 2
    lib = pathlib.Path(args[0])
    abi = args[1] if len(args) > 1 else "arm64-v8a"
    if not lib.is_file():
        print(f"missing {lib}")
        return 1
    if not APP.is_dir():
        print(f"{APP} not found - run `cargo tauri android init` first")
        return 1

    dest_dir = APP / "src" / "main" / "jniLibs" / abi
    dest_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(lib, dest_dir / "libmultistockfish_light.so")
    print(f"copied {lib} -> {dest_dir / 'libmultistockfish_light.so'}")

    if ort_lib is None:
        print("missing --ort: the app needs libonnxruntime.so to run Maia")
        return 2
    if not ort_lib.is_file():
        print(f"missing {ort_lib}")
        return 1
    shutil.copy2(ort_lib, dest_dir / "libonnxruntime.so")
    print(f"copied {ort_lib} -> {dest_dir / 'libonnxruntime.so'}")

    assets_dir = APP / "src" / "main" / "assets" / "models"
    for model in models:
        if not model.is_file():
            print(f"missing {model}")
            return 1
        assets_dir.mkdir(parents=True, exist_ok=True)
        target = assets_dir / f"{model.stem}.onnx"
        shutil.copy2(model, target)
        print(f"copied {model} -> {target}")

    icons = ROOT / "src-tauri" / "icons" / "android"
    if icons.is_dir():
        shutil.copytree(icons, APP / "src" / "main" / "res", dirs_exist_ok=True)
        print(f"copied launcher icons {icons} -> res/")
    else:
        print("no src-tauri/icons/android - run scripts/gen_android_icons.py")

    gradle = APP / "build.gradle.kts"
    text = gradle.read_text()
    if "noCompress" in text:
        print("build.gradle.kts already patched")
        return 0
    patched, n = re.subn(
        r"^android\s*\{\s*$",
        'android {\n    androidResources {\n        noCompress += "onnx"\n    }',
        text,
        count=1,
        flags=re.MULTILINE,
    )
    if n != 1:
        print("could not find the `android {` block in build.gradle.kts - add this by hand:")
        print('    androidResources { noCompress += "onnx" }')
        return 1
    gradle.write_text(patched)
    print('patched build.gradle.kts (noCompress += "onnx")')
    return 0


if __name__ == "__main__":
    sys.exit(main())
