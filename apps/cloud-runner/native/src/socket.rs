use std::{
    ffi::OsString,
    fs,
    io::{self, Read, Write},
    net::Shutdown,
    os::windows::{ffi::OsStrExt, fs::MetadataExt},
    path::Path,
    thread,
    time::{Duration, Instant},
};
use uds_windows::UnixStream;
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{LocalFree, HLOCAL},
        Security::{
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
            },
            PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
        },
        Storage::FileSystem::CreateDirectoryW,
    },
};

fn prepare_directory(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("The socket directory must be absolute".to_string());
    }
    for parent in path
        .parent()
        .ok_or("Missing socket directory parent")?
        .ancestors()
    {
        let metadata = fs::symlink_metadata(parent).map_err(|error| error.to_string())?;
        if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0 {
            return Err("The socket directory cannot use redirected parents".to_string());
        }
    }
    let path: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            w!("D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)"),
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )
    }
    .map_err(|error| error.to_string())?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: false.into(),
    };
    let result = unsafe { CreateDirectoryW(PCWSTR(path.as_ptr()), Some(&attributes)) };
    unsafe {
        let _ = LocalFree(Some(HLOCAL(descriptor.0)));
    }
    result.map_err(|error| error.to_string())
}

fn proxy() -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut socket = loop {
        match UnixStream::connect("agent.sock") {
            Ok(socket) => break socket,
            Err(error)
                if matches!(error.raw_os_error(), Some(2 | 10061)) && Instant::now() < deadline =>
            {
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => return Err(format!("Cannot connect to the VM socket: {error}")),
        }
    };
    let mut writer = socket.try_clone().map_err(|error| error.to_string())?;
    thread::spawn(move || {
        let _ = io::copy(&mut io::stdin().lock(), &mut writer);
        let _ = writer.shutdown(Shutdown::Both);
    });
    let mut bytes = [0; 65536];
    let mut output = io::stdout().lock();
    loop {
        let count = socket.read(&mut bytes).map_err(|error| error.to_string())?;
        if count == 0 {
            return Ok(());
        }
        output
            .write_all(&bytes[..count])
            .and_then(|_| output.flush())
            .map_err(|error| error.to_string())?;
    }
}

pub fn command(arguments: &[OsString]) -> Result<(), String> {
    match arguments {
        [mode, path] if mode == "--socket-directory" => prepare_directory(Path::new(path)),
        [mode] if mode == "--socket-proxy" => proxy(),
        _ => Err("Unexpected supervisor arguments".to_string()),
    }
}
