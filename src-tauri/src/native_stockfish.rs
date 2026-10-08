use libloading::Library;
use std::ffi::{c_char, c_int, CStr, CString};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::thread::{self, JoinHandle};
use std::time::Duration;

pub const LIBRARY: &str = "libmultistockfish_light.so";

const QUIT_GRACE: Duration = Duration::from_secs(5);

// the library keeps one global instance, so a second init on a live one must be refused
static RUNNING: AtomicBool = AtomicBool::new(false);

type InitFn = unsafe extern "C" fn() -> c_int;
type WriteFn = unsafe extern "C" fn(*mut c_char) -> isize;
type ReadFn = unsafe extern "C" fn() -> *mut c_char;
type ErrorFn = unsafe extern "C" fn(*mut c_char, c_int) -> c_int;

struct Api {
    init: InitFn,
    run: InitFn,
    stdin_write: WriteFn,
    stdout_read: ReadFn,
    last_error: ErrorFn,
}

macro_rules! symbol {
    ($lib:expr, $name:literal, $ty:ty) => {
        *$lib
            .get::<$ty>(concat!($name, "\0").as_bytes())
            .map_err(|e| format!("{LIBRARY} is missing {}: {e}", $name))?
    };
}

fn load() -> Result<Api, String> {
    unsafe {
        let lib = Library::new(LIBRARY).map_err(|e| format!("could not load {LIBRARY}: {e}"))?;
        let api = Api {
            init: symbol!(lib, "stockfish_light_init", InitFn),
            run: symbol!(lib, "stockfish_light_main", InitFn),
            stdin_write: symbol!(lib, "stockfish_light_stdin_write", WriteFn),
            stdout_read: symbol!(lib, "stockfish_light_stdout_read", ReadFn),
            last_error: symbol!(lib, "stockfish_light_last_error", ErrorFn),
        };
        std::mem::forget(lib);
        Ok(api)
    }
}

fn api() -> Result<&'static Api, String> {
    static API: OnceLock<Result<Api, String>> = OnceLock::new();
    API.get_or_init(load).as_ref().map_err(Clone::clone)
}

fn last_error(api: &Api) -> String {
    let mut buf = [0 as c_char; 512];
    unsafe {
        (api.last_error)(buf.as_mut_ptr(), buf.len() as c_int);
        CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned()
    }
}

fn pump(api: &Api, tx: Sender<String>) {
    let mut pending = String::new();
    loop {
        let chunk = unsafe { (api.stdout_read)() };
        if chunk.is_null() {
            break;
        }
        pending.push_str(&unsafe { CStr::from_ptr(chunk) }.to_string_lossy());
        while let Some(end) = pending.find('\n') {
            let line: String = pending.drain(..=end).collect();
            let _ = tx.send(line.trim_end().to_string());
        }
    }
}

pub struct NativeStockfish {
    api: &'static Api,
    exited: Receiver<()>,
    reader: Option<JoinHandle<()>>,
}

pub fn start() -> Result<(NativeStockfish, Receiver<String>), String> {
    let api = api()?;
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("the previous Stockfish is still shutting down".into());
    }
    let code = unsafe { (api.init)() };
    if code != 0 {
        RUNNING.store(false, Ordering::SeqCst);
        return Err(format!("Stockfish init failed ({code}): {}", last_error(api)));
    }

    let (exit_tx, exited) = mpsc::channel();
    thread::Builder::new()
        .name("stockfish".into())
        .stack_size(16 * 1024 * 1024)
        .spawn(move || {
            let code = unsafe { (api.run)() };
            if code != 0 {
                eprintln!("[stockfish] exited with {code}: {}", last_error(api));
            }
            RUNNING.store(false, Ordering::SeqCst);
            let _ = exit_tx.send(());
        })
        .map_err(|e| {
            RUNNING.store(false, Ordering::SeqCst);
            format!("could not start the Stockfish thread: {e}")
        })?;

    let (tx, rx) = mpsc::channel();
    let reader = thread::Builder::new()
        .name("stockfish-out".into())
        .spawn(move || pump(api, tx))
        .map_err(|e| format!("could not start the Stockfish reader: {e}"))?;

    Ok((NativeStockfish { api, exited, reader: Some(reader) }, rx))
}

impl NativeStockfish {
    pub fn write(&self, line: &str) -> Result<(), String> {
        let command = CString::new(format!("{line}\n")).map_err(|e| e.to_string())?;
        let written = unsafe { (self.api.stdin_write)(command.as_ptr() as *mut c_char) };
        if written < 0 {
            return Err(format!("could not write to Stockfish ({written}): {}", last_error(self.api)));
        }
        Ok(())
    }
}

impl Drop for NativeStockfish {
    fn drop(&mut self) {
        match self.exited.recv_timeout(QUIT_GRACE) {
            Err(RecvTimeoutError::Timeout) => {
                eprintln!("[stockfish] still running after quit, leaving it");
            }
            _ => {
                if let Some(reader) = self.reader.take() {
                    let _ = reader.join();
                }
            }
        }
    }
}
