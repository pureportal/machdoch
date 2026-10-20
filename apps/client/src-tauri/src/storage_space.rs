use std::path::Path;

#[cfg(windows)]
pub(crate) fn available_storage_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut path: Vec<u16> = path.as_os_str().encode_wide().collect();
    if path.contains(&0) {
        return None;
    }
    path.push(0);
    let mut available = 0u64;
    if unsafe {
        GetDiskFreeSpaceExW(
            path.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } == 0
    {
        None
    } else {
        Some(available)
    }
}

#[cfg(unix)]
pub(crate) fn available_storage_bytes(path: &Path) -> Option<u64> {
    use std::{ffi::CString, mem::MaybeUninit, os::unix::ffi::OsStrExt};
    let path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut storage = MaybeUninit::<libc::statvfs>::uninit();
    if unsafe { libc::statvfs(path.as_ptr(), storage.as_mut_ptr()) } != 0 {
        return None;
    }
    let storage = unsafe { storage.assume_init() };
    Some((storage.f_bavail as u64).saturating_mul(storage.f_frsize as u64))
}
