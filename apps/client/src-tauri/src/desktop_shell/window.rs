use super::{
    QuickVoiceStartPayload, MAIN_WINDOW_LABEL, QUICK_VOICE_START_EVENT, QUICK_VOICE_WINDOW_LABEL,
    TRAY_MENU_WINDOW_LABEL,
};
use tauri::{
    AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window,
    WindowEvent,
};

pub(crate) fn handle_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if let Some(state) = window
        .app_handle()
        .try_state::<super::display_layout::DisplayLayoutState>()
    {
        match event {
            WindowEvent::ScaleFactorChanged { .. } => state.window_changed(window.label(), true),
            WindowEvent::Focused(true) => state.refresh(),
            WindowEvent::Moved(_) | WindowEvent::Resized(_)
                if window.label() == MAIN_WINDOW_LABEL =>
            {
                state.refresh();
            }
            _ => {}
        }
    }
    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }

    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };

    api.prevent_close();
    if let Some(webview) = window.app_handle().get_webview_window(MAIN_WINDOW_LABEL) {
        super::placement::capture(&webview);
    }
    let transfer_state = window
        .app_handle()
        .state::<crate::settings_transfer::SettingsTransferState>();
    transfer_state.request_stop(
        window.app_handle(),
        "Settings sharing stopped when the main window was closed.",
    );
    hide_transient_assistant_windows(window);
    let _ = window.hide();
    let _ = window.set_skip_taskbar(true);
}

pub(crate) fn ensure_assistant_window<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
) -> Result<WebviewWindow<R>, String> {
    if let Some(window) = app.get_webview_window(label) {
        return Ok(window);
    }

    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .visible(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .decorations(false)
        .transparent(true)
        .shadow(false);

    match label {
        QUICK_VOICE_WINDOW_LABEL => builder
            .title("machdoch Quick Voice")
            .inner_size(380.0, 220.0)
            .build()
            .map_err(|error| error.to_string()),
        _ => Err(format!("Unsupported assistant window label `{label}`.")),
    }
}

pub(super) fn ensure_tray_menu_window<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<WebviewWindow<R>, String> {
    if let Some(window) = app.get_webview_window(TRAY_MENU_WINDOW_LABEL) {
        return Ok(window);
    }

    WebviewWindowBuilder::new(
        app,
        TRAY_MENU_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("machdoch")
    .inner_size(324.0, 252.0)
    .visible(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .build()
    .map_err(|error| error.to_string())
}

pub(crate) fn show_quick_voice_window<R: Runtime>(
    app: &AppHandle<R>,
    source_window_label: Option<&str>,
) -> Result<(), String> {
    let window = ensure_assistant_window(app, QUICK_VOICE_WINDOW_LABEL)?;

    let _ = window.show();
    let _ = window.unminimize();
    super::display_layout::recover_on_reveal(&window);
    let _ = window.set_focus();
    let _ = app.emit_to(
        QUICK_VOICE_WINDOW_LABEL,
        QUICK_VOICE_START_EVENT,
        QuickVoiceStartPayload {
            source_window_label: source_window_label.map(str::to_string),
        },
    );

    Ok(())
}

pub(super) fn hide_transient_assistant_windows<R: Runtime, M: Manager<R>>(app: &M) {
    if let Some(window) = app.get_webview_window(QUICK_VOICE_WINDOW_LABEL) {
        let _ = window.destroy();
    }
}

pub(super) fn hide_to_tray<R: Runtime>(app: &AppHandle<R>) {
    hide_transient_assistant_windows(app);

    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };

    super::placement::capture(&window);
    let _ = window.hide();
    let _ = window.set_skip_taskbar(true);
}

pub(super) fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if !app.state::<super::StartupState>().request_reveal() {
        return;
    }
    hide_transient_assistant_windows(app);

    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };

    let was_visible = match window.is_visible() {
        Ok(visible) => visible,
        Err(error) => {
            eprintln!("Failed to inspect main window visibility: {error}");
            return;
        }
    };
    let was_minimized = match window.is_minimized() {
        Ok(minimized) => minimized,
        Err(error) => {
            eprintln!("Failed to inspect main window minimized state: {error}");
            return;
        }
    };
    if was_visible && !was_minimized {
        if let Err(error) = window.set_focus() {
            eprintln!("Failed to focus the main window: {error}");
        }
        return;
    }

    if let Err(error) = window.set_skip_taskbar(false) {
        eprintln!("Failed to show the main window in the taskbar: {error}");
    }
    if was_minimized {
        if let Err(error) = window.unminimize() {
            eprintln!("Failed to restore the minimized main window: {error}");
        }
    }
    super::display_layout::recover_on_reveal(&window);
    if let Err(error) = window.show() {
        eprintln!("Failed to show the main window: {error}");
        return;
    }
    super::placement::apply_saved_mode(&window, !was_visible);
    if let Err(error) = window.set_focus() {
        eprintln!("Failed to focus the main window: {error}");
    }
}
