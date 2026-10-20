use super::*;

struct Cleanup(PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
struct Fixture {
    directory: PathBuf,
    store: SpeechStore,
    _cleanup: Cleanup,
}
impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!("speech-cast-{}", uuid().unwrap()));
        let store = SpeechStore::open(directory.join("store")).unwrap();
        let cleanup = Cleanup(directory.clone());
        Self {
            directory,
            store,
            _cleanup: cleanup,
        }
    }
    fn project() -> Value {
        json!({"id":"book","title":"Scenes","source":"# Chapter\nHello.","cast":[{"id":"speaker","name":"Narrator","voiceId":"base","referenceAssetIds":[],"direction":"","sceneOverrides":[{"sceneId":"scope","voiceId":"scene","referenceAssetIds":[],"direction":"quiet"}]}],"profileId":null,"revisionId":"","parentRevisionId":null,"createdAt":"","updatedAt":"","archived":false,"location":null,"timeline":[],"selectedTakes":{},"bookmarks":[],"variants":[]})
    }
}

#[test]
fn scene_override_reference_dependencies_are_saved_bundled_and_imported() {
    let mut fixture = Fixture::new();
    let source = fixture.directory.join("recording.wav");
    let mut writer = hound::WavWriter::create(
        &source,
        hound::WavSpec {
            channels: 1,
            sample_rate: 24000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )
    .unwrap();
    for _ in 0..240 {
        writer.write_sample(100i16).unwrap();
    }
    writer.finalize().unwrap();
    let asset = fixture
        .store
        .put_asset(&source, "audio/wav", 0.01, 24000, 1)
        .unwrap();
    fixture
        .store
        .connection
        .execute(
            "INSERT INTO speech_references VALUES(?1,?2,?3)",
            params![
                asset["id"].as_str(),
                "Synthetic recording",
                "Own synthetic test"
            ],
        )
        .unwrap();
    let mut project = Fixture::project();
    project["cast"][0]["sceneOverrides"][0]
        .as_object_mut()
        .unwrap()
        .remove("voiceId");
    project["cast"][0]["sceneOverrides"][0]["referenceAssetIds"] = json!([asset["id"]]);
    let saved = fixture
        .store
        .execute(
            "saveProject",
            &json!({"project":project,"expectedRevisionId":null}),
        )
        .unwrap();
    let count: i64 = fixture
        .store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM revision_assets WHERE revision_id=?1",
            [saved["revisionId"].as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    let archive = fixture
        .store
        .portable_snapshot("book", saved["revisionId"].as_str().unwrap())
        .unwrap();
    assert_eq!(
        archive["references"][asset["id"].as_str().unwrap()]["rightsEvidence"],
        "Own synthetic test"
    );
    let restored = fixture.store.commit_portable_snapshot(&archive).unwrap();
    assert_eq!(restored["cast"], saved["cast"]);
}

#[test]
fn malformed_override_bindings_rollback_before_saving_a_project() {
    let mut fixture = Fixture::new();
    let base = Fixture::project();
    let mut duplicate = base.clone();
    duplicate["cast"][0]["sceneOverrides"]
        .as_array_mut()
        .unwrap()
        .push(base["cast"][0]["sceneOverrides"][0].clone());
    let mut ambiguous = base.clone();
    ambiguous["cast"][0]["sceneOverrides"][0]["referenceAssetIds"] = json!(["a".repeat(64)]);
    let mut missing = base.clone();
    missing["cast"][0]["sceneOverrides"][0]
        .as_object_mut()
        .unwrap()
        .remove("voiceId");
    missing["cast"][0]["sceneOverrides"][0]["referenceAssetIds"] = json!(["a".repeat(64)]);
    for project in [duplicate, ambiguous, missing] {
        assert!(fixture
            .store
            .execute(
                "saveProject",
                &json!({"project":project,"expectedRevisionId":null})
            )
            .is_err());
    }
    assert_eq!(
        fixture.store.execute("listProjects", &json!({"offset":0,"limit":20})).unwrap()["projects"],
        json!([])
    );
}
