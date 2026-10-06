use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

static SINK: Mutex<Option<Sender<String>>> = Mutex::new(None);

pub struct WebStockfish {
    app: AppHandle,
}

pub fn start(app: &AppHandle) -> (WebStockfish, Receiver<String>) {
    let (tx, rx) = mpsc::channel();
    if let Ok(mut sink) = SINK.lock() {
        *sink = Some(tx);
    }
    (WebStockfish { app: app.clone() }, rx)
}

impl WebStockfish {
    pub fn write(&self, line: &str) -> Result<(), String> {
        self.app.emit("stockfish-in", line).map_err(|e| e.to_string())
    }
}

impl Drop for WebStockfish {
    fn drop(&mut self) {
        if let Ok(mut sink) = SINK.lock() {
            *sink = None;
        }
    }
}

/// The webview batches Stockfish's output, since `info` lines arrive faster than IPC likes.
#[tauri::command]
pub fn stockfish_out(lines: Vec<String>) {
    let Ok(sink) = SINK.lock() else { return };
    if let Some(tx) = sink.as_ref() {
        for line in lines {
            let _ = tx.send(line);
        }
    }
}
