use crate::storage_mount;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    os::windows::fs::MetadataExt,
    path::{Component, Path, Prefix},
};
use windows::{
    core::{GUID, PCWSTR, PWSTR},
    Win32::{
        Foundation::{CloseHandle, ERROR_DEV_NOT_EXIST, ERROR_SUCCESS, HANDLE, WIN32_ERROR},
        Storage::Vhd::*,
    },
};

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Create,
    Inspect,
    Attach,
    Detach,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    action: Action,
    image: String,
    id: String,
    bytes: u64,
    #[serde(rename = "volumeId")]
    volume_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    id: String,
    bytes: u64,
    physical_bytes: u64,
    physical_path: Option<String>,
    mount_volume_id: Option<String>,
}

struct Disk(HANDLE);
impl Drop for Disk {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn checked(status: WIN32_ERROR) -> Result<(), String> {
    if status == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!(
            "Virtual disk operation failed: {}",
            std::io::Error::from_raw_os_error(status.0 as i32)
        ))
    }
}

fn storage_type() -> VIRTUAL_STORAGE_TYPE {
    VIRTUAL_STORAGE_TYPE {
        DeviceId: VIRTUAL_STORAGE_TYPE_DEVICE_VHDX,
        VendorId: VIRTUAL_STORAGE_TYPE_VENDOR_MICROSOFT,
    }
}

fn identity(value: &str) -> Result<GUID, String> {
    if value.len() != 36
        || !value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
    {
        return Err("Invalid volume identity".to_string());
    }
    let number =
        u128::from_str_radix(&value.replace('-', ""), 16).map_err(|_| "Invalid volume identity")?;
    if number == 0 {
        return Err("Invalid volume identity".to_string());
    }
    Ok(GUID::from_u128(number))
}

fn validate_path(path: &Path, creating: bool) -> Result<(), String> {
    if !path.is_absolute()
        || path.extension().and_then(|value| value.to_str()) != Some("vhdx")
        || !matches!(path.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
    {
        return Err("Use an absolute local VHDX path".to_string());
    }
    for ancestor in path.parent().ok_or("Missing image directory")?.ancestors() {
        let metadata = fs::symlink_metadata(ancestor).map_err(|error| error.to_string())?;
        if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0 {
            return Err("Storage paths cannot contain reparse points".to_string());
        }
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if creating => {
            let _ = metadata;
            Err("The image already exists; preserve it for recovery".to_string())
        }
        Ok(metadata) if !metadata.is_file() || metadata.file_attributes() & 0x400 != 0 => {
            Err("The image must be a regular file".to_string())
        }
        Ok(_) => Ok(()),
        Err(error) if creating && error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

impl Disk {
    fn open(name: &[u16], information_only: bool) -> Result<Self, String> {
        let parameters = OPEN_VIRTUAL_DISK_PARAMETERS {
            Version: OPEN_VIRTUAL_DISK_VERSION_2,
            Anonymous: OPEN_VIRTUAL_DISK_PARAMETERS_0 {
                Version2: OPEN_VIRTUAL_DISK_PARAMETERS_0_1 {
                    GetInfoOnly: information_only.into(),
                    ReadOnly: information_only.into(),
                    ..Default::default()
                },
            },
        };
        let mut handle = HANDLE::default();
        checked(unsafe {
            OpenVirtualDisk(
                &storage_type(),
                PCWSTR(name.as_ptr()),
                VIRTUAL_DISK_ACCESS_NONE,
                OPEN_VIRTUAL_DISK_FLAG_NONE,
                Some(&parameters),
                &mut handle,
            )
        })?;
        Ok(Self(handle))
    }
    fn information(
        &self,
        version: GET_VIRTUAL_DISK_INFO_VERSION,
    ) -> Result<GET_VIRTUAL_DISK_INFO, String> {
        let mut value = GET_VIRTUAL_DISK_INFO {
            Version: version,
            ..Default::default()
        };
        let mut bytes = std::mem::size_of_val(&value) as u32;
        checked(unsafe { GetVirtualDiskInformation(self.0, &mut bytes, &mut value, None) })?;
        Ok(value)
    }

    fn physical_path(&self) -> Result<Option<String>, String> {
        let mut buffer = [0u16; 1024];
        let mut bytes = (buffer.len() * 2) as u32;
        let result =
            unsafe { GetVirtualDiskPhysicalPath(self.0, &mut bytes, PWSTR(buffer.as_mut_ptr())) };
        if result == ERROR_DEV_NOT_EXIST {
            return Ok(None);
        }
        checked(result)?;
        let length = buffer
            .iter()
            .position(|value| *value == 0)
            .ok_or("Invalid disk path")?;
        let value = String::from_utf16(&buffer[..length]).map_err(|_| "Invalid disk path")?;
        if value.len() <= 17
            || !value.starts_with("\\\\.\\PhysicalDrive")
            || !value[17..].bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err("Unexpected virtual disk device path".to_string());
        }
        Ok(Some(value))
    }

    fn describe(&self, expected: GUID, bytes: u64, mount: &Path) -> Result<Volume, String> {
        let id = unsafe {
            self.information(GET_VIRTUAL_DISK_INFO_VIRTUAL_DISK_ID)?
                .Anonymous
                .VirtualDiskId
        };
        let size = unsafe { self.information(GET_VIRTUAL_DISK_INFO_SIZE)?.Anonymous.Size };
        let subtype = unsafe {
            self.information(GET_VIRTUAL_DISK_INFO_PROVIDER_SUBTYPE)?
                .Anonymous
                .ProviderSubtype
        };
        if id != expected || size.VirtualSize != bytes || subtype != 2 {
            return Err(format!("The image identity, capacity or allocation type changed (id {id:?}, bytes {}, type {subtype})", size.VirtualSize));
        }
        Ok(Volume {
            id: format!("{id:?}").to_lowercase(),
            bytes: size.VirtualSize,
            physical_bytes: size.PhysicalSize,
            physical_path: self.physical_path()?,
            mount_volume_id: storage_mount::volume_at(mount)?,
        })
    }
}

pub fn execute(request: Request) -> Result<Volume, String> {
    if request.image.contains('\0')
        || !(256 * 1024 * 1024..=16 * 1024 * 1024 * 1024).contains(&request.bytes)
        || request.bytes % (1024 * 1024) != 0
    {
        return Err("Choose a volume size between 256 MiB and 16 GiB in whole MiB".to_string());
    }
    let id = identity(&request.id)?;
    let path = Path::new(&request.image);
    validate_path(path, matches!(request.action, Action::Create))?;
    let mount = path
        .parent()
        .ok_or("Missing image directory")?
        .join("mount");
    let name: Vec<u16> = request.image.encode_utf16().chain([0]).collect();
    let mut handle = HANDLE::default();
    if matches!(request.action, Action::Create) {
        let parameters = CREATE_VIRTUAL_DISK_PARAMETERS {
            Version: CREATE_VIRTUAL_DISK_VERSION_2,
            Anonymous: CREATE_VIRTUAL_DISK_PARAMETERS_0 {
                Version2: CREATE_VIRTUAL_DISK_PARAMETERS_0_1 {
                    UniqueId: id,
                    MaximumSize: request.bytes,
                    ..Default::default()
                },
            },
        };
        checked(unsafe {
            CreateVirtualDisk(
                &storage_type(),
                PCWSTR(name.as_ptr()),
                VIRTUAL_DISK_ACCESS_NONE,
                None,
                CREATE_VIRTUAL_DISK_FLAG_FULL_PHYSICAL_ALLOCATION,
                0,
                &parameters,
                None,
                &mut handle,
            )
        })?;
        return Disk(handle).describe(id, request.bytes, &mount);
    }
    let information = Disk::open(&name, true)?;
    let current = information.describe(id, request.bytes, &mount)?;
    if matches!(request.action, Action::Inspect)
        || (matches!(request.action, Action::Attach) && current.physical_path.is_some())
    {
        return Ok(current);
    }
    drop(information);
    let disk = Disk::open(&name, false)?;
    let current = disk.describe(id, request.bytes, &mount)?;
    if matches!(request.action, Action::Detach) {
        storage_mount::remove_owned(&mount, request.volume_id.as_deref())?;
    }
    match request.action {
        Action::Attach if current.physical_path.is_none() => {
            let parameters = ATTACH_VIRTUAL_DISK_PARAMETERS {
                Version: ATTACH_VIRTUAL_DISK_VERSION_1,
                ..Default::default()
            };
            checked(unsafe {
                AttachVirtualDisk(
                    disk.0,
                    None,
                    ATTACH_VIRTUAL_DISK_FLAG_NO_DRIVE_LETTER
                        | ATTACH_VIRTUAL_DISK_FLAG_PERMANENT_LIFETIME,
                    0,
                    Some(&parameters),
                    None,
                )
            })?;
        }
        Action::Detach if current.physical_path.is_some() => {
            checked(unsafe { DetachVirtualDisk(disk.0, DETACH_VIRTUAL_DISK_FLAG_NONE, 0) })?
        }
        _ => {}
    }
    disk.describe(id, request.bytes, &mount)
}
