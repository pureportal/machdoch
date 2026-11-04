use std::{
    collections::HashSet,
    env,
    ffi::{c_void, OsStr, OsString},
    io,
    os::windows::ffi::OsStringExt,
    path::{Path, PathBuf},
};

use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_SUCCESS},
        System::Registry::{
            RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ,
        },
    },
};

const PATH_VARIABLE: &str = "PATH";
const PATH_VALUE_NAME: PCWSTR = w!("Path");
const MACHINE_ENVIRONMENT_KEY: PCWSTR =
    w!(r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment");
const USER_ENVIRONMENT_KEY: PCWSTR = w!("Environment");

/// Windows Installer relaunches the app after an update with only the machine PATH, which hides
/// user-installed CLIs from every process the app spawns until it is restarted from the shell.
pub(crate) fn complete_path_from_logon_environment() -> Result<(), String> {
    let logon_paths: Vec<OsString> = [
        read_path_value(HKEY_LOCAL_MACHINE, MACHINE_ENVIRONMENT_KEY)?,
        read_path_value(HKEY_CURRENT_USER, USER_ENVIRONMENT_KEY)?,
    ]
    .into_iter()
    .flatten()
    .collect();
    let current_path = env::var_os(PATH_VARIABLE).unwrap_or_default();

    if let Some(completed_path) = append_missing_path_entries(&current_path, &logon_paths)? {
        env::set_var(PATH_VARIABLE, completed_path);
    }

    Ok(())
}

fn read_path_value(root: HKEY, subkey: PCWSTR) -> Result<Option<OsString>, String> {
    let mut buffer: Vec<u16> = Vec::new();
    let mut byte_length = 0u32;

    loop {
        let data = (!buffer.is_empty()).then(|| buffer.as_mut_ptr().cast::<c_void>());
        let status = unsafe {
            RegGetValueW(
                root,
                subkey,
                PATH_VALUE_NAME,
                RRF_RT_REG_SZ,
                None,
                data,
                Some(&mut byte_length),
            )
        };

        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }

        if status == ERROR_MORE_DATA || (status == ERROR_SUCCESS && data.is_none()) {
            buffer = vec![0; (byte_length as usize).div_ceil(2).max(1)];
            byte_length = u32::try_from(buffer.len() * 2).map_err(|error| error.to_string())?;
            continue;
        }

        if status != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(status.0 as i32).to_string());
        }

        let value = &buffer[..(byte_length as usize / 2).min(buffer.len())];
        let length = value
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(value.len());

        return Ok(Some(OsString::from_wide(&value[..length])));
    }
}

fn append_missing_path_entries(
    current_path: &OsStr,
    logon_paths: &[OsString],
) -> Result<Option<OsString>, String> {
    let mut known_entries: HashSet<String> = env::split_paths(current_path)
        .map(|entry| path_entry_key(&entry))
        .collect();
    let missing_entries: Vec<PathBuf> = logon_paths
        .iter()
        .flat_map(env::split_paths)
        .filter(|entry| {
            !entry.as_os_str().is_empty() && known_entries.insert(path_entry_key(entry))
        })
        .collect();

    if missing_entries.is_empty() {
        return Ok(None);
    }

    let mut completed_path = current_path.to_os_string();

    if !current_path.is_empty() && !current_path.to_string_lossy().ends_with(';') {
        completed_path.push(";");
    }

    completed_path.push(env::join_paths(missing_entries).map_err(|error| error.to_string())?);

    Ok(Some(completed_path))
}

fn path_entry_key(entry: &Path) -> String {
    entry
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use std::ffi::{OsStr, OsString};

    use super::append_missing_path_entries;

    fn complete(current_path: &str, logon_paths: &[&str]) -> Option<OsString> {
        let logon_paths: Vec<OsString> = logon_paths.iter().map(OsString::from).collect();

        append_missing_path_entries(OsStr::new(current_path), &logon_paths)
            .expect("PATH entries should be joinable")
    }

    #[test]
    fn appends_logon_entries_missing_from_the_inherited_path() {
        assert_eq!(
            complete(
                r"C:\Windows;C:\VS Code\bin\copilot-shim",
                &[
                    r"C:\Windows;C:\VS Code\bin\copilot-shim",
                    r"C:\Users\me\AppData\Roaming\npm;C:\Users\me\AppData\Local\Microsoft\WinGet\Links",
                ],
            ),
            Some(OsString::from(
                r"C:\Windows;C:\VS Code\bin\copilot-shim;C:\Users\me\AppData\Roaming\npm;C:\Users\me\AppData\Local\Microsoft\WinGet\Links"
            ))
        );
    }

    #[test]
    fn keeps_a_complete_path_regardless_of_case_and_trailing_separators() {
        assert_eq!(
            complete(r"C:\Tools\;c:\bin", &[r"c:\tools", r"C:\BIN\"]),
            None
        );
    }

    #[test]
    fn skips_empty_and_repeated_logon_entries() {
        assert_eq!(
            complete("", &[r"C:\a;;C:\a", r"C:\b;"]),
            Some(OsString::from(r"C:\a;C:\b"))
        );
    }

    #[test]
    fn reuses_an_existing_trailing_separator() {
        assert_eq!(
            complete(r"C:\a;", &[r"C:\b"]),
            Some(OsString::from(r"C:\a;C:\b"))
        );
    }
}
