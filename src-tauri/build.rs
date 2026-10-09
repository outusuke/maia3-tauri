fn main() {
    // The About screen shows the repo's VERSION file, so a local `cargo tauri dev`
    // never shows a stale number from tauri.conf.json / Cargo.toml.
    println!("cargo:rerun-if-changed=../VERSION");
    let version = std::fs::read_to_string("../VERSION")
        .map(|v| v.trim().to_string())
        .unwrap_or_else(|_| std::env::var("CARGO_PKG_VERSION").unwrap_or_default());
    println!("cargo:rustc-env=MAIA_VERSION={version}");
    tauri_build::build()
}
