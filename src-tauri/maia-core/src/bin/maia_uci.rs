//! Stand-alone UCI front end, used by CI to compare against the Python script.
use std::io::{BufRead, Write};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let onnx = match args.iter().position(|a| a == "--onnx").and_then(|i| args.get(i + 1)) {
        Some(p) => std::path::PathBuf::from(p),
        None => {
            eprintln!("usage: maia-uci --onnx model.onnx [--history 8] [--use-uci-history] [--elo N] [--temperature T] [--top-p P] [--multipv N] [--seed N] [--opening-moves N]");
            std::process::exit(2);
        }
    };
    let cfg = maia_core::Config::from_args(&args);
    let mut engine = match maia_core::MaiaEngine::new(&onnx, cfg) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("failed to load model: {e}");
            std::process::exit(1);
        }
    };

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let mut out = stdout.lock();
        let keep_going = engine.handle_line(&line, &mut |s: String| {
            let _ = writeln!(out, "{s}");
            let _ = out.flush();
        });
        if !keep_going {
            break;
        }
    }
}
