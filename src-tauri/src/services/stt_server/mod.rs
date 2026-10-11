mod manager;
mod spec;

use manager::SttServerManager;
use serde::Serialize;
use tauri::{
    command,
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, RunEvent, Runtime, State,
};

const SCRIPT: &str = include_str!("../../../stt-server/stt_server.py");

#[derive(Serialize)]
struct StatusDto {
    phase: String,
    message: String,
    log: String,
}

#[command]
fn start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SttServerManager>,
    engine: String,
    model: Option<String>,
    language: Option<String>,
    port: u16,
) -> Result<(), String> {
    let base = tauri::api::path::app_local_data_dir(&app.config())
        .ok_or_else(|| "Could not find the app data folder.".to_string())?;
    let data_dir = base.join("stt-server");
    let spec = spec::build_spec(
        &data_dir,
        SCRIPT,
        &engine,
        model.as_deref().unwrap_or(""),
        language.as_deref().unwrap_or(""),
        port,
        std::process::id(),
    )?;
    state.start(spec)
}

#[command]
fn stop(state: State<'_, SttServerManager>) {
    state.stop();
}

#[command]
fn status(state: State<'_, SttServerManager>) -> StatusDto {
    let s = state.status();
    StatusDto { phase: s.phase.to_string(), message: s.message, log: s.log }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("stt_server")
        .invoke_handler(tauri::generate_handler![start, stop, status])
        .setup(|app| {
            app.manage(SttServerManager::default());
            Ok(())
        })
        .on_event(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(m) = app.try_state::<SttServerManager>() {
                    m.stop();
                }
            }
        })
        .build()
}
