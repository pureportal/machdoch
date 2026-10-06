use std::{fs, path::{Path, PathBuf}};

pub(super) fn context_attachment_directory() -> Result<PathBuf, String> {
    Ok(crate::runtime_snapshot::get_user_config_directory()?.join("context-attachments"))
}

fn attachment_storage_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| format!("Could not create an attachment ID: {error}"))?;
    Ok(bytes.into_iter().map(|byte| format!("{byte:02x}")).collect())
}

pub(super) fn is_stored_context_attachment(path: &Path) -> bool {
    context_attachment_directory().ok().and_then(|root| root.canonicalize().ok())
        .is_some_and(|root| path.starts_with(root))
}

pub(crate) fn persist_context_attachment(source: &Path, name: &str) -> Result<String, String> {
    persist_in_directory(source, name, &context_attachment_directory()?)
}

fn persist_in_directory(source: &Path, name: &str, root: &Path) -> Result<String, String> {
    if name.is_empty() || name.len() > 200 || name.starts_with('.')
        || name.contains(['/', '\\', ':']) || name.chars().any(char::is_control) {
        return Err("Choose a file with a valid filename.".to_owned());
    }
    if !source.is_file() { return Err("Select a file to attach.".to_owned()); }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().recursive(true).mode(0o700).create(&root).map_err(|error| error.to_string())?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let directory = root.join(attachment_storage_id()?);
    fs::create_dir(&directory).map_err(|error| error.to_string())?;
    let destination = directory.join(name);
    let result = fs::copy(source, &destination).map_err(|error| error.to_string());
    if let Err(error) = result {
        fs::remove_dir_all(&directory).map_err(|cleanup| format!("{error}; could not remove the incomplete attachment: {cleanup}"))?;
        return Err(error);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).map_err(|error| error.to_string())?;
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o600)).map_err(|error| error.to_string())?;
    }
    Ok(destination.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uploaded_attachments_survive_transfer_removal_and_keep_distinct_filenames() {
        let root = std::env::temp_dir().join(format!("machdoch-attachment-verification-{}", attachment_storage_id().unwrap()));
        fs::create_dir(&root).unwrap();
        let transfer = root.join("transfer.bin");
        fs::write(&transfer, "Fleet attachment 日本語 🛰\r\n").unwrap();
        let store = root.join("attachments");
        let first = persist_in_directory(&transfer, "notes 日本語.txt", &store).unwrap();
        let second = persist_in_directory(&transfer, "notes 日本語.txt", &store).unwrap();
        assert_ne!(first, second);
        fs::remove_file(transfer).unwrap();
        assert_eq!(fs::read_to_string(&first).unwrap(), "Fleet attachment 日本語 🛰\r\n");
        assert_eq!(fs::read_to_string(&second).unwrap(), "Fleet attachment 日本語 🛰\r\n");
        assert_eq!(Path::new(&first).file_name().unwrap(), "notes 日本語.txt");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn attachment_import_rejects_directory_sources_and_filename_traversal() {
        let root = std::env::temp_dir().join(format!("machdoch-attachment-verification-{}", attachment_storage_id().unwrap()));
        fs::create_dir(&root).unwrap();
        let source = root.join("source.bin");
        fs::write(&source, "payload").unwrap();
        let store = root.join("attachments");
        for name in ["", "../outside.txt", "folder/file.txt", "folder\\file.txt", "C:outside.txt", ".hidden", "bad\0name"] {
            assert!(persist_in_directory(&source, name, &store).is_err());
        }
        assert!(persist_in_directory(&root, "folder", &store).is_err());
        assert!(!store.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
