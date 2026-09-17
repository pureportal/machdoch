use super::*;

fn test_directory() -> PathBuf {
    let mut nonce = [0_u8; 16];
    getrandom::fill(&mut nonce).unwrap();
    let root =
        std::env::temp_dir().join(format!("machdoch-codex-images-{:x}", Sha256::digest(nonce)));
    fs::create_dir_all(&root).unwrap();
    root.canonicalize().unwrap()
}

fn manifest(images: Vec<PathBuf>) -> ImageManifest {
    ImageManifest {
        images,
        error: None,
    }
}

#[test]
fn retrieves_only_decodable_images_from_the_reported_session() {
    let root = test_directory();
    let session = root.join("session-1");
    fs::create_dir(&session).unwrap();
    let image = session.join("image.png");
    image::RgbaImage::new(32, 24).save(&image).unwrap();
    let result = collect_images(manifest(vec![image.clone()]), &session, 1).unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(
        provider_images::validate_image(&result[0], "png", 0)
            .unwrap()
            .width,
        32
    );
    assert!(
        collect_images(manifest(vec![image.clone(), image]), &session, 2)
            .unwrap_err()
            .contains("duplicate")
    );
    let unrelated = root.join("another-session.png");
    image::RgbaImage::new(32, 24).save(&unrelated).unwrap();
    assert!(collect_images(manifest(vec![unrelated]), &session, 1)
        .unwrap_err()
        .contains("outside this session"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn rejects_missing_corrupt_and_incomplete_outputs() {
    let root = test_directory();
    assert!(collect_images(manifest(vec![]), &root, 1)
        .unwrap_err()
        .contains("after requesting 1"));
    assert!(
        collect_images(manifest(vec![PathBuf::from("relative.png")]), &root, 1)
            .unwrap_err()
            .contains("absolute")
    );
    assert!(
        collect_images(manifest(vec![root.join("missing.png")]), &root, 1)
            .unwrap_err()
            .contains("not saved")
    );
    let corrupt = root.join("corrupt.png");
    fs::write(&corrupt, b"not an image").unwrap();
    assert!(collect_images(manifest(vec![corrupt]), &root, 1).is_err());
    let failed = ImageManifest {
        images: vec![],
        error: Some("Image generation tool unavailable".into()),
    };
    assert!(collect_images(failed, &root, 1)
        .unwrap_err()
        .contains("tool unavailable"));
    let oversized = root.join("oversized.json");
    fs::write(&oversized, vec![b'x'; MAX_MANIFEST_BYTES + 1]).unwrap();
    assert!(read_bounded_file(&oversized, MAX_MANIFEST_BYTES).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn reads_session_identity_from_cli_events_without_scraping_messages() {
    assert_eq!(thread_id("{\"type\":\"thread.started\",\"thread_id\":\"session-1\"}\n{\"type\":\"turn.completed\"}").unwrap(), "session-1");
    assert!(thread_id("{\"type\":\"thread.started\",\"thread_id\":\"../other\"}").is_err());
    assert!(thread_id("{\"type\":\"item.completed\",\"item\":{\"text\":\"session-1\"}}").is_err());
}
