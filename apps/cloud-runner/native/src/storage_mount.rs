use std::{fs, os::windows::fs::MetadataExt, path::Path};
use windows::{
    core::PCWSTR,
    Win32::Storage::FileSystem::{DeleteVolumeMountPointW, GetVolumeNameForVolumeMountPointW},
};

fn mount_path(path: &Path) -> Result<Vec<u16>, String> {
    let text = path.to_str().ok_or("The mount path is not Unicode")?;
    Ok(format!("{}\\", text.trim_end_matches('\\'))
        .encode_utf16()
        .chain([0])
        .collect())
}

pub fn volume_at(path: &Path) -> Result<Option<String>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_attributes() & 0x10 == 0 {
        return Err("The owned mount path must be a directory".to_string());
    }
    if metadata.file_attributes() & 0x400 == 0 {
        return Ok(None);
    }
    let name = mount_path(path)?;
    let mut volume = [0u16; 128];
    unsafe { GetVolumeNameForVolumeMountPointW(PCWSTR(name.as_ptr()), &mut volume) }
        .map_err(|error| format!("Cannot identify the owned mount point: {error}"))?;
    let end = volume
        .iter()
        .position(|value| *value == 0)
        .ok_or("Invalid mount identity")?;
    let id = String::from_utf16(&volume[..end]).map_err(|_| "Invalid mount identity")?;
    Ok(Some(id))
}

pub fn remove_owned(path: &Path, expected: Option<&str>) -> Result<(), String> {
    let Some(actual) = volume_at(path)? else {
        return Ok(());
    };
    if !expected.is_some_and(|id| id.eq_ignore_ascii_case(&actual)) {
        return Err(
            "The mount point belongs to another volume. Preserve it for recovery.".to_string(),
        );
    }
    let name = mount_path(path)?;
    unsafe { DeleteVolumeMountPointW(PCWSTR(name.as_ptr())) }
        .map_err(|error| format!("Cannot remove the owned mount point: {error}"))?;
    if volume_at(path)?.is_some() {
        return Err("The owned mount point is still present".to_string());
    }
    Ok(())
}
