use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

/// One `go depth N` result line. Scores are from the side to move's perspective.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PvLine {
    pub multipv: u32,
    pub depth: u32,
    pub score_cp: Option<i32>,
    /// Signed: positive means the side to move mates.
    pub mate: Option<i32>,
    pub pv: Vec<String>,
}

fn parse_info_line(line: &str) -> Option<PvLine> {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    let mut multipv = 1u32;
    let mut depth = 0u32;
    let mut score_cp = None;
    let mut mate = None;
    let mut pv: Vec<String> = Vec::new();

    let mut i = 0;
    while i < tokens.len() {
        match tokens[i] {
            "multipv" => {
                multipv = tokens.get(i + 1)?.parse().ok()?;
                i += 2;
            }
            "depth" => {
                depth = tokens.get(i + 1).and_then(|s| s.parse().ok()).unwrap_or(0);
                i += 2;
            }
            "score" => match tokens.get(i + 1).copied() {
                Some("cp") => {
                    score_cp = tokens.get(i + 2).and_then(|s| s.parse().ok());
                    i += 3;
                }
                Some("mate") => {
                    mate = tokens.get(i + 2).and_then(|s| s.parse().ok());
                    i += 3;
                }
                _ => i += 1,
            },
            "pv" => {
                pv = tokens[i + 1..].iter().map(|s| s.to_string()).collect();
                break;
            }
            _ => i += 1,
        }
    }

    if pv.is_empty() {
        None
    } else {
        Some(PvLine {
            multipv,
            depth,
            score_cp,
            mate,
            pv,
        })
    }
}

/// Generic UCI client: Maia-3's console scripts speak plain UCI, same as Stockfish.
pub struct Engine {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<String>,
}

impl Engine {
    pub fn spawn(command: &str, args: &[String]) -> Result<Self, String> {
        let mut child = Command::new(command)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("failed to launch '{command}': {e}"))?;

        let stdin = child.stdin.take().ok_or("no stdin handle")?;
        let stdout = child.stdout.take().ok_or("no stdout handle")?;

        let (tx, rx) = mpsc::channel::<String>();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        if tx.send(l).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let mut engine = Engine { child, stdin, rx };

        engine.send("uci")?;
        // Should answer before the checkpoint loads.
        if engine.wait_for("uciok", Duration::from_secs(15)).is_none() {
            return Err("engine did not respond to 'uci' (uciok not received)".into());
        }

        engine.send("isready")?;
        // Slow: the checkpoint may need to download or load from disk on first use.
        if engine
            .wait_for("readyok", Duration::from_secs(180))
            .is_none()
        {
            return Err(
                "engine did not respond to 'isready' - it may still be downloading the model"
                    .into(),
            );
        }

        Ok(engine)
    }

    pub fn send(&mut self, line: &str) -> Result<(), String> {
        writeln!(self.stdin, "{line}").map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())
    }

    pub fn wait_for(&self, prefix: &str, timeout: Duration) -> Option<String> {
        let deadline = Instant::now() + timeout;
        loop {
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            match self.rx.recv_timeout(deadline - now) {
                Ok(line) => {
                    if line.starts_with(prefix) {
                        return Some(line);
                    }
                }
                Err(_) => return None,
            }
        }
    }

    /// Elo applies to both sides; Maia-3 also has SelfElo and OppoElo options.
    pub fn set_elo(&mut self, elo: u32) -> Result<(), String> {
        self.send(&format!("setoption name Elo value {elo}"))
    }

    /// `go nodes 1` on purpose: Maia is a single forward pass, so a deeper search wouldn't change its move.
    pub fn best_move(&mut self, fen: &str, timeout: Duration) -> Result<String, String> {
        self.send(&format!("position fen {fen}"))?;
        self.send("go nodes 1")?;
        let line = self
            .wait_for("bestmove", timeout)
            .ok_or("timed out waiting for bestmove")?;
        line.split_whitespace()
            .nth(1)
            .map(|s| s.to_string())
            .ok_or_else(|| format!("could not parse bestmove line: {line}"))
    }

    pub fn set_multipv(&mut self, n: u32) -> Result<(), String> {
        self.send(&format!("setoption name MultiPV value {n}"))
    }

    /// Fixed-depth search for Stockfish-style engines; keeps the latest info line per multipv index until bestmove.
    pub fn analyze(
        &mut self,
        fen: &str,
        depth: u32,
        multipv: u32,
        timeout: Duration,
    ) -> Result<Vec<PvLine>, String> {
        self.set_multipv(multipv.max(1))?;
        self.send(&format!("position fen {fen}"))?;
        self.send(&format!("go depth {depth}"))?;

        let deadline = Instant::now() + timeout;
        let mut lines: HashMap<u32, PvLine> = HashMap::new();

        loop {
            let now = Instant::now();
            if now >= deadline {
                return Err("timed out waiting for analysis".into());
            }
            match self.rx.recv_timeout(deadline - now) {
                Ok(line) => {
                    if line.starts_with("bestmove") {
                        break;
                    } else if line.starts_with("info") {
                        if let Some(pv) = parse_info_line(&line) {
                            lines.insert(pv.multipv, pv);
                        }
                    }
                }
                Err(_) => return Err("engine closed unexpectedly during analysis".into()),
            }
        }

        if lines.is_empty() {
            return Err("engine returned no analysis lines".into());
        }
        let mut result: Vec<PvLine> = lines.into_values().collect();
        result.sort_by_key(|l| l.multipv);
        Ok(result)
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.send("quit");
        std::thread::sleep(Duration::from_millis(50));
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
