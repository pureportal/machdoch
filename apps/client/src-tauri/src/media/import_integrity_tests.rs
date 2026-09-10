use super::*;

const PNG: &[u8] = &[
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0,
    0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100, 248, 15, 0, 1, 5, 1, 1,
    39, 24, 227, 102, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];

#[derive(Clone, Copy, Debug)]
enum StoredContent {
    Valid,
    Corrupt,
    Truncated,
    Missing,
    Directory,
}

struct Fixture {
    root: PathBuf,
    source: PathBuf,
    paths: MediaRuntimePaths,
    digest: String,
    relative_path: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "machdoch-import-integrity-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.png");
        fs::write(&source, PNG).unwrap();
        let paths = MediaRuntimePaths {
            database: root.join("runtime/media.sqlite3"),
            blobs: root.join("runtime/blobs"),
        };
        database::ensure_initialized(&paths).unwrap();
        let digest = format!("{:x}", Sha256::digest(PNG));
        let relative_path = transform::cas_relative_path(&digest);
        Self {
            root,
            source,
            paths,
            digest,
            relative_path,
        }
    }

    fn destination(&self) -> PathBuf {
        self.paths.blobs.join(&self.relative_path)
    }

    fn set_content(&self, content: StoredContent) {
        let destination = self.destination();
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        if destination.is_file() {
            fs::remove_file(&destination).unwrap();
        }
        match content {
            StoredContent::Valid => fs::write(destination, PNG).unwrap(),
            StoredContent::Corrupt => fs::write(destination, vec![0x5a; PNG.len()]).unwrap(),
            StoredContent::Truncated => fs::write(destination, &PNG[..PNG.len() - 1]).unwrap(),
            StoredContent::Missing => (),
            StoredContent::Directory => fs::create_dir(destination).unwrap(),
        }
    }

    fn assert_content(&self, content: StoredContent) {
        let destination = self.destination();
        match content {
            StoredContent::Valid => assert_eq!(fs::read(destination).unwrap(), PNG),
            StoredContent::Corrupt => {
                assert_eq!(fs::read(destination).unwrap(), vec![0x5a; PNG.len()])
            }
            StoredContent::Truncated => {
                assert_eq!(fs::read(destination).unwrap(), &PNG[..PNG.len() - 1])
            }
            StoredContent::Missing => assert!(fs::symlink_metadata(destination).is_err()),
            StoredContent::Directory => {
                assert!(fs::symlink_metadata(destination).unwrap().is_dir())
            }
        }
    }

    fn register(&self) -> MediaResult<MediaImageImportResult> {
        database::record_imported_asset(
            &self.paths,
            database::ImportedAssetRegistration {
                digest: &self.digest,
                relative_path: &self.relative_path.to_string_lossy(),
                byte_size: PNG.len() as u64,
                mime_type: "image/png",
                width: 1,
                height: 1,
                import_kind: database::LocalImportKind::Raster,
            },
        )
    }

    fn assert_success(&self, result: &MediaImageImportResult) {
        assert_eq!(result.asset.digest, self.digest);
        assert_eq!(result.asset.byte_size, PNG.len() as u64);
        let metadata = fs::symlink_metadata(self.destination()).unwrap();
        assert!(metadata.file_type().is_file());
        assert_eq!(metadata.len(), PNG.len() as u64);
        assert_eq!(
            format!(
                "{:x}",
                Sha256::digest(fs::read(self.destination()).unwrap())
            ),
            self.digest
        );
        assert_eq!(database::list_assets(&self.paths, 10).unwrap().len(), 1);
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

fn duplicate_import(content: StoredContent) {
    let fixture = Fixture::new();
    let original = import_image(&fixture.paths, fixture.source.to_str().unwrap()).unwrap();
    fixture.set_content(content);
    let result = import_image(&fixture.paths, fixture.source.to_str().unwrap());
    fixture.assert_content(content);
    assert_eq!(database::list_assets(&fixture.paths, 10).unwrap().len(), 1);
    assert!(fs::read_dir(fixture.paths.blobs.join(".staging"))
        .unwrap()
        .next()
        .is_none());
    if matches!(content, StoredContent::Valid) {
        let result = result.unwrap();
        assert!(result.deduplicated);
        assert_eq!(result.asset.id, original.asset.id);
        fixture.assert_success(&result);
    } else {
        assert!(result
            .unwrap_err()
            .to_ascii_lowercase()
            .contains("integrity"));
    }
}

fn duplicate_registration(content: StoredContent) {
    let fixture = Fixture::new();
    fixture.set_content(StoredContent::Valid);
    let original = fixture.register().unwrap();
    fixture.set_content(content);
    let result = fixture.register();
    fixture.assert_content(content);
    assert_eq!(database::list_assets(&fixture.paths, 10).unwrap().len(), 1);
    if matches!(content, StoredContent::Valid) {
        let result = result.unwrap();
        assert!(result.deduplicated);
        assert_eq!(result.asset.id, original.asset.id);
        fixture.assert_success(&result);
    } else {
        assert!(result
            .unwrap_err()
            .to_ascii_lowercase()
            .contains("integrity"));
    }
}

fn publication(content: StoredContent) {
    let fixture = Fixture::new();
    let staged = stage_and_hash(&fixture.paths, &fixture.source).unwrap();
    validate_staged_image(&staged.path).unwrap();
    fixture.set_content(content);
    let result = promote_to_cas(&fixture.paths, &staged);
    assert!(database::list_assets(&fixture.paths, 10)
        .unwrap()
        .is_empty());
    if matches!(content, StoredContent::Valid | StoredContent::Missing) {
        assert_eq!(result.unwrap(), fixture.relative_path);
        fixture.assert_content(StoredContent::Valid);
        assert!(!staged.path.exists());
    } else {
        fixture.assert_content(content);
        assert_eq!(fs::read(&staged.path).unwrap(), PNG);
        assert!(result
            .unwrap_err()
            .to_ascii_lowercase()
            .contains("integrity"));
    }
}

macro_rules! integrity_case {
    ($name:ident, $scenario:ident, $content:ident) => {
        #[test]
        #[ignore = "Pending engine-frozen baseline/candidate verification before production changes"]
        fn $name() {
            $scenario(StoredContent::$content);
        }
    };
}

integrity_case!(import_valid, duplicate_import, Valid);
integrity_case!(import_corrupt, duplicate_import, Corrupt);
integrity_case!(import_truncated, duplicate_import, Truncated);
integrity_case!(import_missing, duplicate_import, Missing);
integrity_case!(import_directory, duplicate_import, Directory);
integrity_case!(record_valid, duplicate_registration, Valid);
integrity_case!(record_corrupt, duplicate_registration, Corrupt);
integrity_case!(record_truncated, duplicate_registration, Truncated);
integrity_case!(record_missing, duplicate_registration, Missing);
integrity_case!(record_directory, duplicate_registration, Directory);
integrity_case!(publish_valid, publication, Valid);
integrity_case!(publish_corrupt, publication, Corrupt);
integrity_case!(publish_truncated, publication, Truncated);
integrity_case!(publish_new, publication, Missing);
integrity_case!(publish_directory, publication, Directory);
