use std::io::{BufRead, Write};

use serde_json::{json, Value};

pub(crate) fn run() -> Result<(), String> {
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    if cfg!(debug_assertions) {
        context.config_mut().identifier.push_str(".dev");
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(crate::sleep_inhibition::SystemSleepInhibitor::default())
        .manage(super::MediaRuntimeState::default())
        .manage(super::fleet::FleetMediaState::default())
        .manage(super::fleet_transfer::FleetTransferState::default())
        .build(context)
        .map_err(|error| error.to_string())?;
    super::storage::resume_pending(app.handle())?;
    super::fleet::initialize(app.handle());
    let app_handle = app.handle().clone();
    std::thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        let mut output = std::io::stdout().lock();
        loop {
            let mut line = String::new();
            let result = std::io::Read::take(&mut input, 2_250_002).read_line(&mut line);
            match result {
                Ok(0) => break,
                Ok(_) if line.len() <= 2_250_001 && line.ends_with('\n') => {}
                _ => break,
            }
            let response = match serde_json::from_str::<Value>(&line) {
                Ok(request) => super::fleet::handle(&app_handle, request),
                Err(error) => json!({ "state": "failed", "error": error.to_string() }),
            };
            if writeln!(output, "{response}")
                .and_then(|_| output.flush())
                .is_err()
            {
                break;
            }
        }
        app_handle.exit(0);
    });
    app.run(|_, _| {});
    Ok(())
}
