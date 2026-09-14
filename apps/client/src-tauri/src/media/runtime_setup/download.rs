use std::{
    fs,
    io::{Cursor, Read, Write},
    path::Path,
    time::Duration,
};

use sha2::{Digest, Sha256};

use super::super::MediaResult;
use super::{InstallerArchive, SetupPhase, SetupStatus};

const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES: u64 = 256 * 1024 * 1024;

pub(super) fn install(
    root: &Path,
    version: &str,
    archive: &InstallerArchive,
    report: &impl Fn(SetupStatus),
) -> MediaResult<std::path::PathBuf> {
    let destination = root.join(if cfg!(windows) { "uv.exe" } else { "uv" });
    let archive_path = root.join(&archive.archive);
    let cached = fs::File::open(&archive_path).ok().and_then(|file| {
        let mut bytes = Vec::new();
        file.take(MAX_ARCHIVE_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        valid_digest(&bytes, &archive.sha256).then_some(bytes)
    });
    let bytes = match cached {
        Some(bytes) => bytes,
        None => {
            let url = format!(
                "https://github.com/astral-sh/uv/releases/download/{version}/{}",
                archive.archive
            );
            let client = reqwest::blocking::Client::builder()
                .connect_timeout(Duration::from_secs(30))
                .timeout(Duration::from_secs(10 * 60))
                .build()
                .map_err(|error| error.to_string())?;
            let mut response = client
                .get(url)
                .send()
                .and_then(|response| response.error_for_status())
                .map_err(|error| format!("Could not download setup tools: {error}"))?;
            let total = response.content_length().filter(|length| *length > 0);
            if total.is_some_and(|length| length > MAX_ARCHIVE_BYTES) {
                return Err("Setup download exceeds its size limit".to_string());
            }
            let mut bytes = Vec::new();
            let mut buffer = [0; 64 * 1024];
            loop {
                let count = response
                    .read(&mut buffer)
                    .map_err(|error| format!("Setup download failed: {error}"))?;
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..count]);
                if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
                    return Err("Setup download exceeds its size limit".to_string());
                }
                let mut status = SetupStatus::running(SetupPhase::Downloading);
                status.download_percent =
                    total.map(|total| ((bytes.len() as u64 * 100 / total).min(100)) as u8);
                report(status);
            }
            if !valid_digest(&bytes, &archive.sha256) {
                return Err("Setup download checksum did not match".to_string());
            }
            fs::write(&archive_path, &bytes)
                .map_err(|error| format!("Could not cache setup tools: {error}"))?;
            bytes
        }
    };
    let executable = extract_executable(&bytes, archive)?;
    let mut file = fs::File::create(&destination).map_err(|error| error.to_string())?;
    file.write_all(&executable)
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(destination)
}

fn valid_digest(bytes: &[u8], expected: &str) -> bool {
    bytes.len() as u64 <= MAX_ARCHIVE_BYTES && format!("{:x}", Sha256::digest(bytes)) == expected
}

fn extract_executable(bytes: &[u8], archive: &InstallerArchive) -> MediaResult<Vec<u8>> {
    let mut output = Vec::new();
    if archive.archive.ends_with(".zip") {
        let mut zip =
            zip::ZipArchive::new(Cursor::new(bytes)).map_err(|error| error.to_string())?;
        let file = zip
            .by_name(&archive.executable)
            .map_err(|error| error.to_string())?;
        file.take(MAX_EXECUTABLE_BYTES + 1)
            .read_to_end(&mut output)
            .map_err(|error| error.to_string())?;
    } else {
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
        for entry in tar.entries().map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            if entry.path().map_err(|error| error.to_string())?.as_ref()
                == Path::new(&archive.executable)
                && entry.header().entry_type().is_file()
            {
                entry
                    .take(MAX_EXECUTABLE_BYTES + 1)
                    .read_to_end(&mut output)
                    .map_err(|error| error.to_string())?;
                break;
            }
        }
    }
    if output.is_empty() || output.len() as u64 > MAX_EXECUTABLE_BYTES {
        return Err("Setup archive contains no valid executable".to_string());
    }
    Ok(output)
}
