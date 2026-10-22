use super::super::{
    model_addon, model_storage, ImportMediaLocalModelRequest, ImportMediaModelAddonRequest,
};
use super::*;

struct Library {
    root: PathBuf,
    models: PathBuf,
}

impl Library {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "machdoch-model-library-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let models = root.join("shared-models");
        fs::create_dir_all(&models).unwrap();
        Self { root, models }
    }

    fn instance(&self, name: &str) -> MediaRuntimePaths {
        let root = self.root.join(name);
        let paths = MediaRuntimePaths {
            database: root.join("media.sqlite3"),
            blobs: root.join("blobs/sha256"),
            _storage_lease: None,
        };
        database::initialize(&paths).unwrap();
        model_storage::select(&root, &self.models).unwrap();
        paths
    }
}

impl Drop for Library {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

fn write_checkpoint(path: &Path, title: &str) {
    let header = serde_json::to_vec(&serde_json::json!({
        "__metadata__": { "modelspec.title": title, "modelspec.architecture": "stable-diffusion-xl-v1-base" },
        "conditioner.embedders.1.model.weight": { "dtype": "F32", "shape": [1], "data_offsets": [0, 4] }
    })).unwrap();
    let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
    bytes.extend(header);
    bytes.extend([0, 0, 0, 0]);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn configure(
    paths: &MediaRuntimePaths,
    source: &Path,
) -> super::super::MediaLocalModelImportResult {
    let inspection = model_import::inspect(source.to_str().unwrap()).unwrap();
    model_import::import_reviewed(
        paths,
        &ImportMediaLocalModelRequest {
            source_path: inspection.source_path,
            review_token: inspection.review_token,
            display_name: "Shared XL".into(),
            architecture: "stable-diffusion-xl".into(),
            source_url: None,
            license_name: None,
            commercial_use: None,
        },
    )
    .unwrap()
}

#[test]
fn selected_folder_discovers_copied_files_without_a_workspace_and_skips_internal_files() {
    let library = Library::new();
    let paths = library.instance("dev");
    for relative in [
        "nested/model.safetensors",
        "staging/partial.safetensors",
        "trash/deleted.safetensors",
        "components/encoder.safetensors",
        "addons/trash/removed.safetensors",
        ".cache/cached.safetensors",
    ] {
        write_checkpoint(&library.models.join(relative), "Copied XL");
    }
    fs::write(
        library.models.join("incomplete.safetensors"),
        b"partial copy",
    )
    .unwrap();
    let found = discover(&paths, None).unwrap();
    assert_eq!(found.entries.len(), 2);
    assert!(found
        .entries
        .iter()
        .any(|entry| entry.display_name == "Copied XL" && entry.status == "importable"));
    assert!(found
        .entries
        .iter()
        .any(|entry| entry.status == "unsupported"));
    fs::remove_file(library.models.join("nested/model.safetensors")).unwrap();
    assert_eq!(discover(&paths, None).unwrap().entries.len(), 1);
}

#[test]
fn unmanaged_installations_do_not_block_discovery_or_the_model_catalog() {
    let library = Library::new();
    let paths = library.instance("dev");
    let source = library.root.join("source.safetensors");
    write_checkpoint(&source, "Shared XL");
    let imported = configure(&paths, &source);
    write_checkpoint(&library.models.join("new.safetensors"), "New XL");
    let unmanaged_id = "local:flux-1-schnell";
    assert!(!model_install::has_manifest(unmanaged_id));
    database::open(&paths)
        .unwrap()
        .execute(
            "INSERT INTO media_model_installations(
                model_id, revision, status, manifest_digest, bytes_on_disk, updated_at
             ) VALUES (?1, 'unmanaged-revision', 'installed', 'unmanaged-digest', 1024, ?2)",
            rusqlite::params![unmanaged_id, database::now()],
        )
        .unwrap();

    let discovery = discover(&paths, None).unwrap();
    assert_eq!(discovery.entries.len(), 1);
    assert_eq!(discovery.entries[0].display_name, "New XL");
    assert_eq!(discovery.entries[0].status, "importable");

    let snapshot = database::get_model_catalog(&paths, &HashSet::new()).unwrap();
    let model = snapshot
        .models
        .iter()
        .find(|model| model.id == unmanaged_id)
        .unwrap();
    assert!(!model.installed);
    assert!(!model.configured);
    assert_eq!(model.installation_status, "not-installed");
    assert!(model.installed_revision.is_none());
    assert!(snapshot
        .models
        .iter()
        .any(|model| model.id == imported.model_id && model.installed));
}

#[test]
fn managed_installations_still_reject_invalid_package_paths() {
    let library = Library::new();
    let paths = library.instance("dev");
    let source = library.root.join("source.safetensors");
    write_checkpoint(&source, "Shared XL");
    let imported = configure(&paths, &source);
    database::open(&paths)
        .unwrap()
        .execute(
            "UPDATE media_model_installations SET relative_path = '../outside' WHERE model_id = ?1",
            [&imported.model_id],
        )
        .unwrap();

    let error = available_models(&paths).unwrap_err();
    assert_eq!(error, "the installed model path is not a managed package path");
}

#[test]
fn missing_and_truncated_models_disappear_and_restored_models_keep_their_configuration() {
    let library = Library::new();
    let paths = library.instance("dev");
    let source = library.root.join("source.safetensors");
    write_checkpoint(&source, "Shared XL");
    let model = configure(&paths, &source);
    let stored = model_install::library_path(&paths, &model.model_id)
        .unwrap()
        .join("checkpoint.safetensors");
    let bytes = fs::read(&stored).unwrap();
    assert!(database::get_model_catalog(&paths, &HashSet::new())
        .unwrap()
        .models
        .iter()
        .any(|entry| entry.id == model.model_id && entry.installed));
    fs::write(&stored, b"partial").unwrap();
    assert!(!database::get_model_catalog(&paths, &HashSet::new())
        .unwrap()
        .models
        .iter()
        .any(|entry| entry.id == model.model_id));
    fs::remove_file(&stored).unwrap();
    assert!(!database::get_model_catalog(&paths, &HashSet::new())
        .unwrap()
        .models
        .iter()
        .any(|entry| entry.id == model.model_id));
    fs::write(&stored, bytes).unwrap();
    let restored = database::get_model_catalog(&paths, &HashSet::new()).unwrap();
    assert!(restored
        .models
        .iter()
        .any(|entry| entry.id == model.model_id
            && entry.display_name == "Shared XL"
            && entry.installed));
}

#[test]
fn shared_packages_are_discovered_and_configured_without_copying_them_again() {
    let library = Library::new();
    let prod = library.instance("prod");
    let dev = library.instance("dev");
    let source = library.root.join("source.safetensors");
    write_checkpoint(&source, "Shared XL");
    let model = configure(&prod, &source);
    let stored = model_install::library_path(&prod, &model.model_id)
        .unwrap()
        .join("checkpoint.safetensors");
    let modified = fs::metadata(&stored).unwrap().modified().unwrap();
    assert!(discover(&prod, None).unwrap().entries.is_empty());
    let found = discover(&dev, None).unwrap();
    assert_eq!(found.entries.len(), 1);
    assert_eq!(found.entries[0].display_name, "Shared XL");
    assert_eq!(found.entries[0].status, "importable");
    assert_eq!(
        configure(&dev, Path::new(&found.entries[0].path)).model_id,
        model.model_id
    );
    assert_eq!(fs::metadata(&stored).unwrap().modified().unwrap(), modified);
    assert!(discover(&dev, None).unwrap().entries.is_empty());
    assert!(fs::read_dir(library.models.join("staging"))
        .unwrap()
        .next()
        .is_none());
}

#[test]
fn configuring_a_copied_file_hides_its_source_until_that_file_changes() {
    let library = Library::new();
    let paths = library.instance("dev");
    let source = library.models.join("my-model.safetensors");
    write_checkpoint(&source, "Shared XL");
    configure(&paths, &source);
    assert!(discover(&paths, None).unwrap().entries.is_empty());
    let other = library.instance("prod");
    assert_eq!(discover(&other, None).unwrap().entries.len(), 1);
    write_checkpoint(&source, "Replacement XL");
    let found = discover(&paths, None).unwrap();
    assert_eq!(found.entries.len(), 1);
    assert_eq!(found.entries[0].display_name, "Replacement XL");
}

#[test]
fn missing_addons_disappear_and_return_when_restored() {
    let library = Library::new();
    let paths = library.instance("dev");
    let source = library.models.join("embedding.safetensors");
    let header = br#"{"emb_params":{"dtype":"F32","shape":[1,768],"data_offsets":[0,4]}}"#;
    let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
    bytes.extend(header);
    bytes.extend([0, 0, 0, 0]);
    fs::write(&source, bytes).unwrap();
    let inspection = model_addon::inspect(source.to_str().unwrap()).unwrap();
    let request = ImportMediaModelAddonRequest {
        source_path: inspection.source_path,
        review_token: inspection.review_token,
        display_name: "Style".into(),
        kind: "textual-inversion".into(),
        architecture: "stable-diffusion-1".into(),
        trigger_words: Vec::new(),
        token: Some("style".into()),
        source_url: None,
        license_name: None,
        commercial_use: None,
    };
    let addon = model_addon::import_reviewed_with_source(&paths, &request, None).unwrap();
    let stored = library
        .models
        .join(format!("addons/sha256/{}/addon.safetensors", addon.digest));
    let bytes = fs::read(&stored).unwrap();
    assert_eq!(
        database::get_model_catalog(&paths, &HashSet::new())
            .unwrap()
            .addons
            .len(),
        1
    );
    assert!(discover(&paths, None).unwrap().entries.is_empty());
    fs::remove_file(&stored).unwrap();
    assert!(database::get_model_catalog(&paths, &HashSet::new())
        .unwrap()
        .addons
        .is_empty());
    assert!(
        model_addon::inspect_for_import(&paths, source.to_str().unwrap())
            .unwrap()
            .duplicate
            .is_none()
    );
    assert_eq!(
        model_addon::import_reviewed_with_source(&paths, &request, None)
            .unwrap()
            .addon_id,
        addon.addon_id
    );
    assert_eq!(fs::read(&stored).unwrap(), bytes);
    fs::remove_file(&stored).unwrap();
    fs::write(&stored, bytes).unwrap();
    assert_eq!(
        database::get_model_catalog(&paths, &HashSet::new())
            .unwrap()
            .addons
            .len(),
        1
    );
}

#[test]
fn configuring_an_existing_checkpoint_repairs_missing_and_truncated_weights() {
    let library = Library::new();
    let paths = library.instance("dev");
    let source = library.root.join("source.safetensors");
    write_checkpoint(&source, "Shared XL");
    let model = configure(&paths, &source);
    let stored = model_install::library_path(&paths, &model.model_id)
        .unwrap()
        .join("checkpoint.safetensors");
    let expected = fs::read(&stored).unwrap();
    fs::remove_file(&stored).unwrap();
    assert_eq!(configure(&paths, &source).model_id, model.model_id);
    assert_eq!(fs::read(&stored).unwrap(), expected);
    fs::write(&stored, b"partial").unwrap();
    assert_eq!(configure(&paths, &source).model_id, model.model_id);
    assert_eq!(fs::read(&stored).unwrap(), expected);
}

#[test]
fn changing_model_folders_updates_the_library_without_deleting_settings() {
    let library = Library::new();
    let paths = library.instance("dev");
    let source = library.root.join("source.safetensors");
    write_checkpoint(&source, "Shared XL");
    let model = configure(&paths, &source);
    let empty = library.root.join("empty-models");
    fs::create_dir(&empty).unwrap();
    model_storage::select(paths.database.parent().unwrap(), &empty).unwrap();
    assert!(!database::get_model_catalog(&paths, &HashSet::new())
        .unwrap()
        .models
        .iter()
        .any(|entry| entry.id == model.model_id));
    model_storage::select(paths.database.parent().unwrap(), &library.models).unwrap();
    assert!(database::get_model_catalog(&paths, &HashSet::new())
        .unwrap()
        .models
        .iter()
        .any(|entry| entry.id == model.model_id && entry.installed));
}

#[test]
fn disconnecting_the_model_folder_hides_models_and_reconnection_restores_them() {
    let library = Library::new();
    let paths = library.instance("dev");
    let source = library.root.join("source.safetensors");
    write_checkpoint(&source, "Shared XL");
    let model = configure(&paths, &source);
    let disconnected = library.root.join("disconnected-models");
    fs::rename(&library.models, &disconnected).unwrap();
    assert!(!database::get_model_catalog(&paths, &HashSet::new())
        .unwrap()
        .models
        .iter()
        .any(|entry| entry.id == model.model_id));
    assert!(discover(&paths, None).is_err());
    fs::rename(&disconnected, &library.models).unwrap();
    assert!(database::get_model_catalog(&paths, &HashSet::new())
        .unwrap()
        .models
        .iter()
        .any(|entry| entry.id == model.model_id && entry.installed));
}
