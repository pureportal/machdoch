use std::{
    fs,
    io::Read,
    path::{Component, Path},
};

use flate2::read::GzDecoder;

use crate::atomic_file::{write_file_atomic, AtomicWriteOptions};

pub(crate) fn materialize_browser_runtime(directory: &Path, archive: &[u8]) -> Result<(), String> {
    let mut archive = tar::Archive::new(GzDecoder::new(archive));
    let entries = archive
        .entries()
        .map_err(|error| format!("Could not read the bundled browser runtime: {error}"))?;
    for entry in entries {
        let mut entry = entry
            .map_err(|error| format!("Could not read a bundled browser runtime file: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("Could not read a bundled browser runtime path: {error}"))?
            .into_owned();
        if path
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
            || !path.starts_with("node_modules/playwright-core")
        {
            return Err("The bundled browser runtime contains an invalid path.".to_string());
        }
        let target = directory.join(&path);
        let kind = entry.header().entry_type();
        if kind.is_dir() {
            fs::create_dir_all(&target)
                .map_err(|error| format!("Could not create {}: {error}", target.display()))?;
            continue;
        }
        if !kind.is_file() {
            return Err("The bundled browser runtime contains an invalid file type.".to_string());
        }
        let parent = target
            .parent()
            .ok_or_else(|| "The bundled browser runtime path has no parent.".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
        let mut contents = Vec::new();
        entry
            .read_to_end(&mut contents)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
        if fs::read(&target).is_ok_and(|current| current == contents) {
            continue;
        }
        write_file_atomic(&target, &contents, AtomicWriteOptions::default())
            .map_err(|error| format!("Could not restore {}: {error}", target.display()))?;
    }
    if !directory
        .join("node_modules/playwright-core/package.json")
        .is_file()
        || !directory
            .join("node_modules/playwright-core/index.mjs")
            .is_file()
    {
        return Err(
            "The bundled browser runtime is incomplete. Rebuild the CLI bundle.".to_string(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::materialize_browser_runtime;
    use flate2::{write::GzEncoder, Compression};
    use std::{
        fs,
        io::Cursor,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn archive(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut archive = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
        for (path, contents) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(contents.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            archive
                .append_data(&mut header, path, Cursor::new(contents))
                .unwrap();
        }
        archive.into_inner().unwrap().finish().unwrap()
    }

    fn directory() -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "machdoch-browser-runtime-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn repairs_deleted_and_corrupt_modules_without_rewriting_healthy_files() {
        let directory = directory();
        let archive = archive(&[
            ("node_modules/playwright-core/package.json", b"{}"),
            (
                "node_modules/playwright-core/index.mjs",
                b"export const chromium = {};",
            ),
            ("node_modules/playwright-core/lib/server.js", b"server"),
        ]);
        materialize_browser_runtime(&directory, &archive).unwrap();
        let package = directory.join("node_modules/playwright-core/package.json");
        let package_modified_at = fs::metadata(&package).unwrap().modified().unwrap();
        let entry = directory.join("node_modules/playwright-core/index.mjs");
        fs::remove_file(&entry).unwrap();
        let server = directory.join("node_modules/playwright-core/lib/server.js");
        fs::write(&server, b"corrupt").unwrap();
        materialize_browser_runtime(&directory, &archive).unwrap();
        assert_eq!(fs::read(&entry).unwrap(), b"export const chromium = {};");
        assert_eq!(fs::read(&server).unwrap(), b"server");
        assert_eq!(
            fs::metadata(&package).unwrap().modified().unwrap(),
            package_modified_at
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_missing_module_entry_points() {
        let directory = directory();
        let archive = archive(&[("node_modules/playwright-core/package.json", b"{}")]);
        assert!(materialize_browser_runtime(&directory, &archive)
            .unwrap_err()
            .contains("incomplete"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_files_outside_the_browser_package() {
        let directory = directory();
        let archive = archive(&[("other-package/index.mjs", b"invalid")]);
        assert!(materialize_browser_runtime(&directory, &archive)
            .unwrap_err()
            .contains("invalid path"));
        assert!(!directory.join("other-package").exists());
        fs::remove_dir_all(directory).unwrap();
    }
}
