use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use tauri::{
    AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow,
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::MAIN_WINDOW_LABEL;

pub(crate) const DISPLAY_LAYOUT_CHANGED_EVENT: &str = "machdoch://display-layout-changed";

#[derive(Default)]
pub(crate) struct DisplayLayoutState {
    wake: Arc<Notify>,
    stop: CancellationToken,
    changed_windows: Arc<Mutex<BTreeMap<String, bool>>>,
}

impl DisplayLayoutState {
    pub(crate) fn refresh(&self) {
        self.wake.notify_one();
    }
    pub(crate) fn shutdown(&self) {
        self.stop.cancel();
    }
    pub(crate) fn window_changed(&self, label: &str, scale_changed: bool) {
        if let Ok(mut windows) = self.changed_windows.lock() {
            *windows.entry(label.to_string()).or_default() |= scale_changed;
        }
        self.refresh();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Bounds {
    x: i64,
    y: i64,
    width: u32,
    height: u32,
}

impl Bounds {
    fn right(self) -> i64 {
        self.x + i64::from(self.width)
    }
    fn bottom(self) -> i64 {
        self.y + i64::from(self.height)
    }
    fn overlap(self, other: Self) -> u64 {
        (self.right().min(other.right()) - self.x.max(other.x)).max(0) as u64
            * (self.bottom().min(other.bottom()) - self.y.max(other.y)).max(0) as u64
    }
    fn distance(self, other: Self) -> i128 {
        let dx = i128::from((other.x - self.right()).max(self.x - other.right()).max(0));
        let dy = i128::from(
            (other.y - self.bottom())
                .max(self.y - other.bottom())
                .max(0),
        );
        dx * dx + dy * dy
    }
}

fn work_area(monitor: &Monitor) -> Option<Bounds> {
    if monitor.size().width == 0 || monitor.size().height == 0 {
        return None;
    }
    let work = monitor.work_area();
    let (position, size) = if work.size.width > 0 && work.size.height > 0 {
        (&work.position, &work.size)
    } else {
        (monitor.position(), monitor.size())
    };
    let area = Bounds {
        x: i64::from(position.x),
        y: i64::from(position.y),
        width: size.width,
        height: size.height,
    };
    let screen = Bounds {
        x: i64::from(monitor.position().x),
        y: i64::from(monitor.position().y),
        width: monitor.size().width,
        height: monitor.size().height,
    };
    if area.overlap(screen) == 0 {
        return Some(screen);
    }
    Some(Bounds {
        x: area.x.max(screen.x),
        y: area.y.max(screen.y),
        width: (area.right().min(screen.right()) - area.x.max(screen.x)) as u32,
        height: (area.bottom().min(screen.bottom()) - area.y.max(screen.y)) as u32,
    })
}

fn fit_bounds(window: Bounds, areas: &[Bounds]) -> Option<(Bounds, usize)> {
    let (index, area) = areas.iter().enumerate().max_by(|(_, a), (_, b)| {
        window
            .overlap(**a)
            .cmp(&window.overlap(**b))
            .then_with(|| window.distance(**b).cmp(&window.distance(**a)))
    })?;
    let width = window.width.max(1).min(area.width);
    let height = window.height.max(1).min(area.height);
    Some((
        Bounds {
            x: window.x.clamp(area.x, area.right() - i64::from(width)),
            y: window.y.clamp(area.y, area.bottom() - i64::from(height)),
            width,
            height,
        },
        index,
    ))
}

fn titlebar_reachable(window: Bounds, areas: &[Bounds]) -> bool {
    let titlebar = Bounds {
        height: window.height.min(32),
        ..window
    };
    areas.iter().any(|area| {
        titlebar.overlap(*area) >= u64::from(window.width.min(128)) * u64::from(titlebar.height)
    })
}

pub(crate) fn recover_window<R: Runtime>(
    window: &WebviewWindow<R>,
    monitors: &[Monitor],
    fit_visible: bool,
) -> tauri::Result<()> {
    // Minimized windows can report sentinel coordinates. Recover them when revealed.
    if window.is_minimized()? {
        return Ok(());
    }
    let position = window.outer_position()?;
    let outer = window.outer_size()?;
    let inner = window.inner_size()?;
    let current = Bounds {
        x: i64::from(position.x),
        y: i64::from(position.y),
        width: outer.width,
        height: outer.height,
    };
    let valid: Vec<_> = monitors
        .iter()
        .filter_map(|monitor| work_area(monitor).map(|area| (monitor, area)))
        .collect();
    let areas: Vec<_> = valid.iter().map(|(_, area)| *area).collect();
    let Some((_, index)) = fit_bounds(current, &areas) else {
        return Ok(());
    };
    let fullscreen = window.is_fullscreen()?;
    let maximized = window.is_maximized()?;
    // Focus after taskbar restore must rescue an unreachable window without
    // snapping an intentionally straddled, still-usable window to one monitor.
    if !fit_visible && titlebar_reachable(current, &areas) {
        return Ok(());
    }
    let frame_width = outer.width.saturating_sub(inner.width);
    let frame_height = outer.height.saturating_sub(inner.height);
    if window.label() == MAIN_WINDOW_LABEL {
        let scale = valid[index].0.scale_factor();
        let scale = if scale.is_finite() && scale > 0.0 {
            scale
        } else {
            1.0
        };
        // The usual minimum must yield to the actual usable screen at high DPI.
        window.set_min_size(Some(PhysicalSize::new(
            ((960.0 * scale).round() as u32)
                .min(areas[index].width.saturating_sub(frame_width))
                .max(1),
            ((720.0 * scale).round() as u32)
                .min(areas[index].height.saturating_sub(frame_height))
                .max(1),
        )))?;
    }
    if fullscreen || maximized {
        if current.overlap(areas[index]) > 0 {
            return Ok(());
        }
        // Rescue stale bounds while retaining the user's fullscreen/maximized mode.
        if fullscreen {
            window.set_fullscreen(false)?;
        } else {
            window.unmaximize()?;
        }
    }
    let recovered = fit_window_to_area(window, areas[index]);
    let restored = if fullscreen {
        window.set_fullscreen(true)
    } else if maximized {
        window.maximize()
    } else {
        Ok(())
    };
    recovered.and(restored)
}

fn read_bounds<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<Bounds> {
    let position = window.outer_position()?;
    let size = window.outer_size()?;
    Ok(Bounds {
        x: i64::from(position.x),
        y: i64::from(position.y),
        width: size.width,
        height: size.height,
    })
}

fn fit_window_to_area<R: Runtime>(window: &WebviewWindow<R>, area: Bounds) -> tauri::Result<()> {
    let before = read_bounds(window)?;
    let (target, _) = fit_bounds(before, &[area]).expect("one valid work area");
    if before.x != target.x || before.y != target.y {
        window.set_position(PhysicalPosition::new(target.x as i32, target.y as i32))?;
    }
    // Moving across DPI boundaries may resize the window. Preserve that logical
    // size when it fits; use the new frame metrics when it needs to shrink.
    let actual = read_bounds(window)?;
    let (target, _) = fit_bounds(actual, &[area]).expect("one valid work area");
    if actual.width != target.width || actual.height != target.height {
        let inner = window.inner_size()?;
        let frame_width = actual.width.saturating_sub(inner.width);
        let frame_height = actual.height.saturating_sub(inner.height);
        window.set_size(PhysicalSize::new(
            target.width.saturating_sub(frame_width).max(1),
            target.height.saturating_sub(frame_height).max(1),
        ))?;
    }
    if actual.x != target.x || actual.y != target.y {
        window.set_position(PhysicalPosition::new(target.x as i32, target.y as i32))?;
    }
    Ok(())
}

pub(crate) fn recover_on_reveal<R: Runtime>(window: &WebviewWindow<R>) {
    if let Ok(monitors) = window.available_monitors() {
        if let Err(error) = recover_window(window, &monitors, true) {
            eprintln!(
                "Failed to recover window {} on an active display: {error}",
                window.label()
            );
        }
    }
}

pub(crate) fn initialize<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<DisplayLayoutState>();
    let stop = state.stop.clone();
    let wake = state.wake.clone();
    let changed_windows = state.changed_windows.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut previous = Vec::new();
        let mut displays_unavailable = false;
        loop {
            if stop.is_cancelled() {
                break;
            }
            if let Ok(monitors) = app.available_monitors() {
                let mut topology: Vec<_> = monitors
                    .iter()
                    .filter_map(|monitor| {
                        work_area(monitor).map(|area| {
                            (
                                monitor.name().cloned(),
                                *monitor.position(),
                                *monitor.size(),
                                area,
                                monitor.scale_factor().to_bits(),
                            )
                        })
                    })
                    .collect();
                topology.sort_by_key(|entry| (entry.3, entry.4, entry.0.clone()));
                // Empty/error snapshots are common during docking; retain the last good layout.
                if !topology.is_empty() {
                    let changed = displays_unavailable || topology != previous;
                    let pending = changed_windows
                        .lock()
                        .map(|mut labels| std::mem::take(&mut *labels))
                        .unwrap_or_default();
                    let mut recovered = true;
                    for window in app.webview_windows().values() {
                        if !changed && !pending.contains_key(window.label()) {
                            continue;
                        }
                        let fit_visible =
                            changed || pending.get(window.label()).copied().unwrap_or(false);
                        if recover_window(window, &monitors, fit_visible).is_err() {
                            recovered = false;
                            if let Ok(mut labels) = changed_windows.lock() {
                                *labels.entry(window.label().to_string()).or_default() |=
                                    fit_visible;
                            }
                        }
                    }
                    if recovered {
                        previous = topology;
                        displays_unavailable = false;
                    }
                    if changed {
                        let _ = app.emit(DISPLAY_LAYOUT_CHANGED_EVENT, ());
                    }
                } else {
                    displays_unavailable = true;
                }
            } else {
                displays_unavailable = true;
            }
            tokio::select! {
                _ = stop.cancelled() => break,
                _ = wake.notified() => {
                    tokio::select! {
                        _ = stop.cancelled() => break,
                        _ = tokio::time::sleep(Duration::from_millis(150)) => {}
                    }
                },
                _ = tokio::time::sleep(Duration::from_secs(5)) => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bounds(x: i64, y: i64, width: u32, height: u32) -> Bounds {
        Bounds {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn unplugged_monitor_recovers_to_nearest_remaining_work_area() {
        let areas = [bounds(-1920, -120, 1920, 1040), bounds(0, 40, 1280, 680)];
        assert_eq!(
            fit_bounds(bounds(3000, 300, 1440, 960), &areas),
            Some((bounds(0, 40, 1280, 680), 1))
        );
    }

    #[test]
    fn preserves_valid_negative_positions_and_selects_largest_overlap() {
        let areas = [bounds(-1920, 0, 1920, 1040), bounds(0, 0, 1920, 1040)];
        let current = bounds(-1800, 20, 1200, 800);
        assert_eq!(fit_bounds(current, &areas), Some((current, 0)));
        assert_eq!(
            fit_bounds(bounds(-200, 20, 1200, 800), &areas),
            Some((bounds(0, 20, 1200, 800), 1))
        );
    }

    #[test]
    fn gaps_taskbars_and_resolution_reductions_do_not_count_as_usable_space() {
        let areas = [bounds(0, 40, 800, 560), bounds(1000, -900, 600, 900)];
        let (target, index) = fit_bounds(bounds(850, 100, 900, 700), &areas).unwrap();
        assert_eq!(
            target.overlap(areas[index]),
            u64::from(target.width) * u64::from(target.height)
        );
        assert_eq!(
            fit_bounds(bounds(0, 0, 800, 600), &areas[..1]),
            Some((bounds(0, 40, 800, 560), 0))
        );
    }

    #[test]
    fn no_displays_and_extreme_coordinates_are_safe() {
        assert_eq!(fit_bounds(bounds(0, 0, 100, 100), &[]), None);
        let area = bounds(i64::from(i32::MIN), 0, 100, 100);
        assert_eq!(
            fit_bounds(bounds(i64::from(i32::MAX), 0, u32::MAX, u32::MAX), &[area]),
            Some((area, 0))
        );
    }

    #[test]
    fn focus_recovery_distinguishes_straddled_windows_from_unreachable_titlebars() {
        let areas = [bounds(0, 40, 1280, 680), bounds(1280, 40, 1280, 680)];
        assert!(titlebar_reachable(bounds(900, 100, 900, 500), &areas));
        assert!(!titlebar_reachable(bounds(3000, 100, 900, 500), &areas));
        assert!(!titlebar_reachable(bounds(0, -100, 900, 500), &areas));
    }
}
