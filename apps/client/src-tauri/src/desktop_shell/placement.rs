use std::{collections::BTreeMap, fs, io::ErrorKind, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

use super::{display_layout, MAIN_WINDOW_LABEL};

const STATE_FILENAME: &str = ".window-state.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct SavedPlacement {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    maximized: bool,
    fullscreen: bool,
}

impl SavedPlacement {
    fn update(&mut self, snapshot: Self, normal_bounds_valid: bool) {
        self.maximized = snapshot.maximized;
        self.fullscreen = snapshot.fullscreen;
        if !snapshot.maximized && !snapshot.fullscreen && normal_bounds_valid {
            self.width = snapshot.width;
            self.height = snapshot.height;
            self.x = snapshot.x;
            self.y = snapshot.y;
        }
    }
}

#[derive(Default)]
pub(crate) struct WindowPlacementState(Mutex<PlacementProgress>);

#[derive(Default)]
struct PlacementProgress {
    saved: Option<SavedPlacement>,
    mode_pending: bool,
}

pub(crate) fn restore<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let restore = || -> Result<(), Box<dyn std::error::Error>> {
        let path = window
            .app_handle()
            .path()
            .app_config_dir()?
            .join(STATE_FILENAME);
        let saved = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<BTreeMap<String, SavedPlacement>>(&bytes) {
                Ok(mut placements) => placements.remove(MAIN_WINDOW_LABEL),
                Err(error) => {
                    eprintln!("Failed to read saved window placement: {error}");
                    None
                }
            },
            Err(error) if error.kind() == ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        if let Some(saved) = saved {
            let size = PhysicalSize::new(saved.width.max(1), saved.height.max(1));
            window.set_size(size)?;
            window.set_position(PhysicalPosition::new(saved.x, saved.y))?;
            if window.inner_size()? != size {
                window.set_size(size)?;
            }
        }
        display_layout::recover_window(window, &window.available_monitors()?, false)?;
        let position = window.outer_position()?;
        let size = window.inner_size()?;
        let state = window.state::<WindowPlacementState>();
        let mut progress = state.0.lock().unwrap();
        progress.saved = Some(SavedPlacement {
            width: size.width,
            height: size.height,
            x: position.x,
            y: position.y,
            maximized: saved.is_some_and(|saved| saved.maximized),
            fullscreen: saved.is_some_and(|saved| saved.fullscreen),
        });
        progress.mode_pending = true;
        Ok(())
    };
    restore().map_err(|error| format!("Failed to restore the main window: {error}"))
}

pub(crate) fn apply_saved_mode<R: Runtime>(window: &WebviewWindow<R>, was_hidden: bool) {
    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }
    let (saved, mode_pending) = {
        let state = window.state::<WindowPlacementState>();
        let progress = state.0.lock().unwrap();
        if !progress.mode_pending && !was_hidden {
            return;
        }
        (progress.saved, progress.mode_pending)
    };
    let apply = || -> tauri::Result<()> {
        if let Some(saved) = saved {
            if saved.maximized && !window.is_maximized()? {
                window.maximize()?;
            }
            if saved.fullscreen && !window.is_fullscreen()? {
                window.set_fullscreen(true)?;
            }
        }
        Ok(())
    };
    match apply() {
        Ok(()) if mode_pending => {
            window
                .state::<WindowPlacementState>()
                .0
                .lock()
                .unwrap()
                .mode_pending = false;
        }
        Err(error) => eprintln!("Failed to restore the main window mode: {error}"),
        Ok(()) => {}
    }
}

pub(crate) fn capture<R: Runtime>(window: &WebviewWindow<R>) {
    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }
    let capture = || -> tauri::Result<()> {
        if !window.is_visible()? || window.is_minimized()? {
            return Ok(());
        }
        let maximized = window.is_maximized()?;
        let fullscreen = window.is_fullscreen()?;
        let position = window.outer_position()?;
        let size = window.inner_size()?;
        let minimum = display_layout::main_window_minimum(window)?;
        let normal_bounds_valid = size.width >= minimum.width
            && size.height >= minimum.height
            && position.x > -32000
            && position.y > -32000;
        if window.is_minimized()?
            || maximized != window.is_maximized()?
            || fullscreen != window.is_fullscreen()?
        {
            return Ok(());
        }
        let state = window.state::<WindowPlacementState>();
        let mut progress = state.0.lock().unwrap();
        if !progress.mode_pending {
            if let Some(saved) = progress.saved.as_mut() {
                saved.update(
                    SavedPlacement {
                        width: size.width,
                        height: size.height,
                        x: position.x,
                        y: position.y,
                        maximized,
                        fullscreen,
                    },
                    normal_bounds_valid,
                );
            }
        }
        Ok(())
    };
    if let Err(error) = capture() {
        eprintln!("Failed to capture the main window placement: {error}");
    }
}

pub(crate) fn save<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        capture(&window);
    }
    let saved = app.state::<WindowPlacementState>().0.lock().unwrap().saved;
    let Some(saved) = saved else { return };
    let save = || -> Result<(), Box<dyn std::error::Error>> {
        let directory = app.path().app_config_dir()?;
        fs::create_dir_all(&directory)?;
        let placements = BTreeMap::from([(MAIN_WINDOW_LABEL, saved)]);
        crate::atomic_file::write_file_atomic(
            &directory.join(STATE_FILENAME),
            &serde_json::to_vec_pretty(&placements)?,
            crate::atomic_file::AtomicWriteOptions::default(),
        )?;
        Ok(())
    };
    if let Err(error) = save() {
        eprintln!("Failed to save the main window placement: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn placement() -> SavedPlacement {
        SavedPlacement {
            width: 1200,
            height: 800,
            x: -1500,
            y: 100,
            maximized: false,
            fullscreen: false,
        }
    }

    #[test]
    fn mode_changes_preserve_normal_size_and_position() {
        for (maximized, fullscreen) in [(true, false), (false, true)] {
            let mut saved = placement();
            saved.update(
                SavedPlacement {
                    width: 2560,
                    height: 1440,
                    x: 0,
                    y: 0,
                    maximized,
                    fullscreen,
                },
                true,
            );
            assert_eq!(
                saved,
                SavedPlacement {
                    maximized,
                    fullscreen,
                    ..placement()
                }
            );
        }
    }

    #[test]
    fn invalid_geometry_does_not_replace_normal_bounds() {
        let mut saved = placement();
        saved.update(
            SavedPlacement {
                width: 176,
                height: 40,
                x: -32000,
                y: -32000,
                ..placement()
            },
            false,
        );
        assert_eq!(saved, placement());
    }

    #[test]
    fn normal_move_and_resize_are_remembered_together() {
        let mut saved = placement();
        let changed = SavedPlacement {
            width: 1500,
            height: 900,
            x: -1800,
            y: 40,
            ..saved
        };
        saved.update(changed, true);
        assert_eq!(saved, changed);
    }
}
