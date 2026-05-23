use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::access_log::{self, AccessLogChunk, AccessLogEntry};

/// Streams currently emitting `access-log:<id>` events. Polled stream — not a
/// child process — so we only need to track the join handle + a cancel flag.
#[derive(Default)]
pub struct AccessLogStreams {
    inner: Arc<Mutex<HashMap<String, AccessLogStreamHandle>>>,
}

struct AccessLogStreamHandle {
    cancel: Arc<std::sync::atomic::AtomicBool>,
    task: JoinHandle<()>,
}

#[derive(Serialize, Clone)]
pub struct AccessLogStreamEvent {
    pub entries: Vec<AccessLogEntry>,
}

#[tauri::command]
pub fn tail_access_log(app_id: String, from_offset: u64) -> Result<AccessLogChunk, String> {
    access_log::tail(&app_id, from_offset).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_access_log(app_id: String) -> Result<(), String> {
    access_log::clear(&app_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn live_access_log_start(
    app: AppHandle,
    state: State<'_, AccessLogStreams>,
    app_id: String,
) -> Result<String, String> {
    let stream_id = format!(
        "{}-{}",
        app_id.replace(|c: char| !c.is_ascii_alphanumeric(), "_"),
        chrono::Utc::now().timestamp_millis()
    );
    let event_name = format!("access-log:{}", stream_id);

    // Skip pre-existing lines so live tail only emits new traffic.
    let mut offset = access_log::current_offset(&app_id);

    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let cancel_task = cancel.clone();
    let app_handle = app.clone();
    let app_id_task = app_id.clone();
    let event_name_task = event_name.clone();

    let task = tokio::spawn(async move {
        // Poll cadence: 250 ms feels live for HTTP traffic and is cheap (just
        // a metadata + read on a local file).
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(250));
        loop {
            if cancel_task.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            interval.tick().await;

            match access_log::tail(&app_id_task, offset) {
                Ok(chunk) => {
                    offset = chunk.next_offset;
                    if !chunk.entries.is_empty() {
                        let _ = app_handle.emit(
                            &event_name_task,
                            AccessLogStreamEvent { entries: chunk.entries },
                        );
                    }
                }
                Err(e) => {
                    eprintln!("[access_log] tail {}: {}", app_id_task, e);
                }
            }
        }
    });

    state
        .inner
        .lock()
        .await
        .insert(stream_id.clone(), AccessLogStreamHandle { cancel, task });

    Ok(stream_id)
}

#[tauri::command]
pub async fn live_access_log_stop(
    state: State<'_, AccessLogStreams>,
    stream_id: String,
) -> Result<(), String> {
    let mut map = state.inner.lock().await;
    if let Some(handle) = map.remove(&stream_id) {
        handle.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        handle.task.abort();
    }
    Ok(())
}
