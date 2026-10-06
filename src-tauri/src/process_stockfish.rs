use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const QUIT_GRACE: Duration = Duration::from_secs(3);

pub struct ProcessStockfish {
    child: Child,
    stdin: ChildStdin,
    reader: Option<JoinHandle<()>>,
}

pub fn start(path: &Path) -> Result<(ProcessStockfish, Receiver<String>), String> {
    let mut command = Command::new(path);
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW, otherwise a console flashes up
        command.creation_flags(0x0800_0000);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", path.display()))?;
    let stdin = child.stdin.take().ok_or("Stockfish has no stdin")?;
    let stdout = child.stdout.take().ok_or("Stockfish has no stdout")?;

    let (tx, rx) = mpsc::channel();
    let reader = thread::Builder::new()
        .name("stockfish-out".into())
        .spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        })
        .map_err(|e| format!("could not start the Stockfish reader: {e}"))?;

    Ok((ProcessStockfish { child, stdin, reader: Some(reader) }, rx))
}

impl ProcessStockfish {
    pub fn write(&mut self, line: &str) -> Result<(), String> {
        writeln!(self.stdin, "{line}")
            .and_then(|_| self.stdin.flush())
            .map_err(|e| format!("could not write to Stockfish: {e}"))
    }
}

impl Drop for ProcessStockfish {
    fn drop(&mut self) {
        let deadline = Instant::now() + QUIT_GRACE;
        while Instant::now() < deadline && matches!(self.child.try_wait(), Ok(None)) {
            thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
