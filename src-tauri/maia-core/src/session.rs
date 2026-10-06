//! ONNX Runtime is loaded at run time: the desktop app sets ORT_DYLIB_PATH from its pip install, Android finds it in the APK.
use ort::session::{builder::GraphOptimizationLevel, Session as OrtSession};
use ort::value::Tensor;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub enum ModelSource {
    File(PathBuf),
    Bytes(Vec<u8>),
    // lets the game and insights engines share one copy of the weights
    Shared(Arc<Session>),
}

pub struct Session {
    // ort's run() takes &mut self
    inner: Mutex<OrtSession>,
    history_dim: usize,
}

fn e2s<E: std::fmt::Display>(e: E) -> String {
    format!("{e}")
}

impl Session {
    /// Batch is pinned to 1; callers loop.
    pub fn load(source: &ModelSource, history: usize) -> Result<Self, String> {
        if let ModelSource::Shared(_) = source {
            return Err("a shared session is already loaded".into());
        }
        let history_dim = 12 * history;
        // phones care more about peak RAM than a few ms per move
        let (opt_level, threads) = if cfg!(target_os = "android") {
            (GraphOptimizationLevel::Level1, 2)
        } else {
            (GraphOptimizationLevel::Level3, 4)
        };
        let mut builder = OrtSession::builder()
            .map_err(|e| format!("could not start ONNX Runtime (is libonnxruntime available?): {e}"))?
            .with_optimization_level(opt_level)
            .map_err(e2s)?
            .with_intra_threads(threads)
            .map_err(e2s)?;
        #[cfg(target_os = "android")]
        {
            builder = builder
                .with_inter_threads(1)
                .map_err(e2s)?
                .with_parallel_execution(false)
                .map_err(e2s)?
                .with_memory_pattern(false)
                .map_err(e2s)?;
        }
        let session = match source {
            ModelSource::File(path) => builder
                .commit_from_file(path)
                .map_err(|e| format!("could not load {}: {e}", path.display()))?,
            ModelSource::Bytes(bytes) => builder
                .commit_from_memory(bytes)
                .map_err(|e| format!("could not load the bundled model: {e}"))?,
            ModelSource::Shared(_) => unreachable!(),
        };
        Ok(Session {
            inner: Mutex::new(session),
            history_dim,
        })
    }

    pub fn history(&self) -> usize {
        self.history_dim / 12
    }

    pub fn run(&self, tokens: &[f32], self_elo: f32, oppo_elo: f32) -> Result<(Vec<f32>, Vec<f32>), String> {
        let t = Tensor::from_array((vec![1i64, 64, self.history_dim as i64], tokens.to_vec())).map_err(e2s)?;
        let a = Tensor::from_array((vec![1i64], vec![self_elo])).map_err(e2s)?;
        let b = Tensor::from_array((vec![1i64], vec![oppo_elo])).map_err(e2s)?;

        let mut session = self.inner.lock().map_err(|_| "ONNX Runtime session lock poisoned".to_string())?;
        let outputs = session
            .run(ort::inputs![
                "tokens" => t,
                "self_elos" => a,
                "oppo_elos" => b,
            ])
            .map_err(e2s)?;

        let moves = outputs["logits_move"].try_extract_tensor::<f32>().map_err(e2s)?.1.to_vec();
        let value = outputs["logits_value"].try_extract_tensor::<f32>().map_err(e2s)?.1.to_vec();
        Ok((moves, value))
    }
}
