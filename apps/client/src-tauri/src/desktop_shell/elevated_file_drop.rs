use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};
use windows::{
    core::BOOL,
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        System::{Ole::RevokeDragDrop, Threading::GetCurrentProcessId},
        UI::{
            Shell::{
                DefSubclassProc, DragAcceptFiles, DragFinish, DragQueryFileW, RemoveWindowSubclass,
                SetWindowSubclass, HDROP,
            },
            WindowsAndMessaging::{
                ChangeWindowMessageFilterEx, EnumChildWindows, GetWindowThreadProcessId,
                MSGFLT_ALLOW, WM_COPYDATA, WM_DROPFILES, WM_NCDESTROY,
            },
        },
    },
};

use super::MAIN_WINDOW_LABEL;

pub(crate) const FILE_DROP_EVENT: &str = "machdoch://file-drop";
const WM_COPYGLOBALDATA: u32 = 0x0049;
const FILE_DROP_SUBCLASS_ID: usize = 0x4D44_4644;

#[derive(Clone, Serialize)]
struct FileDropPayload {
    paths: Vec<String>,
}

pub(crate) fn enable<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let hwnd = HWND(window.hwnd().map_err(|error| error.to_string())?.0);
    unsafe {
        let _ = RevokeDragDrop(hwnd);
        let _ = EnumChildWindows(
            Some(hwnd),
            Some(revoke_own_drop_target),
            LPARAM(GetCurrentProcessId() as isize),
        );

        for message in [WM_DROPFILES, WM_COPYDATA, WM_COPYGLOBALDATA] {
            ChangeWindowMessageFilterEx(hwnd, message, MSGFLT_ALLOW, None).map_err(|error| {
                format!("Failed to allow file drop message {message:#06x}: {error}")
            })?;
        }

        let app_handle = Box::into_raw(Box::new(window.app_handle().clone()));

        if !SetWindowSubclass(
            hwnd,
            Some(handle_file_drop_message::<R>),
            FILE_DROP_SUBCLASS_ID,
            app_handle as usize,
        )
        .as_bool()
        {
            drop(Box::from_raw(app_handle));
            return Err("Failed to subclass the main window for file drops.".to_string());
        }

        DragAcceptFiles(hwnd, true);
    }

    Ok(())
}

unsafe extern "system" fn revoke_own_drop_target(hwnd: HWND, process_id: LPARAM) -> BOOL {
    let mut window_process_id = 0u32;

    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut window_process_id));

        if window_process_id as isize == process_id.0 {
            let _ = RevokeDragDrop(hwnd);
        }
    }

    BOOL(1)
}

unsafe extern "system" fn handle_file_drop_message<R: Runtime>(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    app_handle: usize,
) -> LRESULT {
    match message {
        WM_DROPFILES => {
            let app_handle = unsafe { &*(app_handle as *const AppHandle<R>) };
            let paths = unsafe { take_dropped_paths(HDROP(wparam.0 as *mut _)) };

            if !paths.is_empty() {
                if let Err(error) = app_handle.emit_to(
                    MAIN_WINDOW_LABEL,
                    FILE_DROP_EVENT,
                    FileDropPayload { paths },
                ) {
                    eprintln!("Failed to forward dropped files: {error}");
                }
            }

            LRESULT(0)
        }
        WM_NCDESTROY => unsafe {
            let _ = RemoveWindowSubclass(
                hwnd,
                Some(handle_file_drop_message::<R>),
                FILE_DROP_SUBCLASS_ID,
            );
            drop(Box::from_raw(app_handle as *mut AppHandle<R>));
            DefSubclassProc(hwnd, message, wparam, lparam)
        },
        _ => unsafe { DefSubclassProc(hwnd, message, wparam, lparam) },
    }
}

unsafe fn take_dropped_paths(hdrop: HDROP) -> Vec<String> {
    unsafe {
        let count = DragQueryFileW(hdrop, u32::MAX, None);
        let paths = (0..count)
            .filter_map(|index| {
                let length = DragQueryFileW(hdrop, index, None) as usize;

                if length == 0 {
                    return None;
                }

                let mut buffer = vec![0u16; length + 1];
                let written = DragQueryFileW(hdrop, index, Some(&mut buffer)) as usize;

                Some(String::from_utf16_lossy(&buffer[..written]))
            })
            .collect();

        DragFinish(hdrop);
        paths
    }
}
