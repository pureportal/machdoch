use super::*;
use std::sync::{Arc, Barrier};
use std::thread;

#[path="performance_store_tests.rs"]
mod performance;
#[path="history_page_tests.rs"]
mod history_pages;
#[path="audition_history_tests.rs"]
mod audition_history;
#[path="profile_reference_tests.rs"]
mod profile_references;
#[path="provider_response_store_tests.rs"]
mod provider_responses;
#[path="collection_history_tests.rs"]
mod collection_history;
#[path="voice_observation_tests.rs"]
mod voice_observations;
#[path="voice_mutation_tests.rs"]
mod voice_mutations;
#[path="playback_metric_tests.rs"]
mod playback_metrics;
#[path="generation_metric_tests.rs"]
mod generation_metrics;
#[path="reading_bookmark_tests.rs"]
mod reading_bookmarks;
#[path="asset_staging_tests.rs"]
mod asset_staging;
#[path="project_copy_tests.rs"]
mod project_copy;

#[test]
fn schema_failure_rolls_back_new_metadata_and_a_repaired_store_reopens_without_an_active_transaction(){
    let directory=TestDirectory::new();let root=directory.0.join("store");fs::create_dir_all(&root).unwrap();
    let connection=Connection::open(root.join("speech.sqlite3")).unwrap();
    connection.execute_batch("CREATE TABLE jobs(id TEXT PRIMARY KEY);").unwrap();drop(connection);
    assert!(SpeechStore::open(root.clone()).is_err());
    let connection=Connection::open(root.join("speech.sqlite3")).unwrap();
    let mut statement=connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").unwrap();
    let tables=statement.query_map([],|row|row.get::<_,String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
    assert_eq!(tables,vec!["jobs"]);drop(statement);
    connection.execute_batch("DROP TABLE jobs;").unwrap();drop(connection);
    let mut store=SpeechStore::open(root).unwrap();assert!(store.connection.is_autocommit());
    assert_eq!(store.execute("queue",&json!({})).unwrap(),json!({"paused":false}));
}

#[test]
fn paused_queue_survives_reopen_and_rejects_invalid_changes() {
    let directory = TestDirectory::new();
    let mut store = directory.open();
    assert_eq!(store.execute("queue", &json!({})).unwrap(), json!({"paused":false}));
    assert_eq!(store.execute("queue", &json!({"paused":true})).unwrap(), json!({"paused":true}));
    assert!(store.execute("queue", &json!({"paused":"false"})).is_err());
    drop(store);
    let mut reopened = directory.open();
    assert_eq!(reopened.execute("queue", &json!({})).unwrap(), json!({"paused":true}));
    assert_eq!(reopened.execute("queue", &json!({"paused":false})).unwrap(), json!({"paused":false}));
}

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("machdoch-speech-store-{}", uuid().unwrap()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn open(&self) -> SpeechStore {
        SpeechStore::open(self.0.join("store")).unwrap()
    }

    fn audio(&self) -> PathBuf {
        let path = self.0.join("source.wav");
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&516u32.to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&24_000u32.to_le_bytes());
        bytes.extend_from_slice(&48_000u32.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&480u32.to_le_bytes());
        bytes.resize(524, 0);
        fs::write(&path, bytes).unwrap();
        path
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn draft() -> Value {
    json!({
        "id": "project-1", "title": "Dialogue", "source": "Hello world",
        "cast": [], "profileId": null, "revisionId": "", "parentRevisionId": null,
        "createdAt": "", "updatedAt": "", "archived": false, "location": null,
        "timeline": [], "selectedTakes": {}, "bookmarks": [], "variants": []
    })
}

fn save(store: &mut SpeechStore, project: &Value, expected: Value) -> Result<Value, String> {
    store.execute("saveProject", &json!({"project": project, "expectedRevisionId": expected}))
}

fn job(project: &Value, state: &str) -> Value {
    let now = timestamp();
    json!({
        "id": "job-1", "owner": "text-to-speech", "projectId": project["id"],
        "revisionId": project["revisionId"], "state": state,
        "completedSegments": 0, "totalSegments": 1, "takeIds": [], "error": null,
        "createdAt": now, "updatedAt": now, "priority": 0, "attempt": 0, "parentJobId": null
    })
}

fn take(project: &Value, asset: &Value) -> Value {
    let now = timestamp();
    json!({
        "id": "take-1", "projectId": project["id"], "revisionId": project["revisionId"],
        "segmentId": "segment-1", "spokenText":"Sample narration.", "chapter":null, "asset": asset, "createdAt": now, "generatedAt": now, "reusedFromTakeId": null,
        "backend": "fish-cloud", "model": "drama-3", "requestHash": digest(b"request"),
        "parentTakeId": null, "favorite": false, "rating": null, "note": "", "alignment": []
    })
}

fn profile() -> Value {
    json!({
        "id": "profile-1", "name": "Drama", "backend": "fish-cloud", "model": "drama-3",
        "direction": "", "temperature": 0.7, "topP": 0.7, "chunkLength": 200,
        "minChunkLength": 50, "latency": "normal", "dictionaryIds": ["dictionary-1"],
        "playbackRate": 1.0
    })
}

#[test]
fn job_admission_rolls_back_with_its_request_snapshot() {
    let directory = TestDirectory::new();
    let mut store = directory.open();
    let project = save(&mut store, &draft(), Value::Null).unwrap();
    {
        let transaction = store.connection.transaction().unwrap();
        SpeechStore::put_job_in_transaction(&transaction, &job(&project, "queued")).unwrap();
        let count: i64 = transaction.query_row("SELECT count(*) FROM jobs", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 1);
    }
    let count: i64 = store.connection.query_row("SELECT count(*) FROM jobs", [], |row| row.get(0)).unwrap();
    assert_eq!(count, 0);
    let transaction = store.connection.transaction().unwrap();
    SpeechStore::put_job_in_transaction(&transaction, &job(&project, "queued")).unwrap();
    transaction.commit().unwrap();
    assert_eq!(store.execute("listJobs", &json!({})).unwrap().as_array().unwrap().len(), 1);
}

#[test]
fn cached_take_preserves_generation_time_and_reuse_lineage() {
    let directory = TestDirectory::new();
    let mut store = directory.open();
    let project = save(&mut store, &draft(), Value::Null).unwrap();
    let asset = store.put_asset(&directory.audio(), "audio/wav", 0.01, 24_000, 1).unwrap();
    let original = take(&project, &asset);
    store.put_take(&original).unwrap();
    let mut reused = original.clone();
    reused["id"] = json!("take-reused");
    reused["createdAt"] = json!("2099-01-01T00:00:00Z");
    reused["reusedFromTakeId"] = original["id"].clone();
    store.put_take(&reused).unwrap();
    let mut changed = reused.clone();
    changed["id"] = json!("take-forged");
    changed["generatedAt"] = json!("2098-01-01T00:00:00Z");
    assert!(store.put_take(&changed).unwrap_err().contains("generatedAt"));
    changed["generatedAt"] = original["generatedAt"].clone();
    changed["requestHash"] = json!(digest(b"different request"));
    assert!(store.put_take(&changed).unwrap_err().contains("requestHash"));
}

#[test]
fn completed_segment_and_job_progress_commit_together() {
    let directory = TestDirectory::new();
    let mut store = directory.open();
    let project = save(&mut store, &draft(), Value::Null).unwrap();
    let asset = store.put_asset(&directory.audio(), "audio/wav", 0.01, 24_000, 1).unwrap();
    let mut recorded = take(&project, &asset);
    let request = generation_request(&mut recorded);
    let initial = job(&project, "running");
    store.put_job(&initial).unwrap();
    let mut invalid = initial.clone();
    invalid["owner"] = json!("another-owner");
    invalid["takeIds"] = json!([recorded["id"]]);
    invalid["completedSegments"] = json!(1);
    assert!(store.put_completed_segment(&recorded, &invalid, &request).is_err());
    let count: i64 = store.connection.query_row("SELECT count(*) FROM takes", [], |row| row.get(0)).unwrap();
    assert_eq!(count, 0);
    let requests:i64=store.connection.query_row("SELECT count(*) FROM take_requests",[],|row|row.get(0)).unwrap();
    assert_eq!(requests,0);
    invalid["owner"] = initial["owner"].clone();
    store.put_completed_segment(&recorded, &invalid, &request).unwrap();
    assert_eq!(store.execute("listTakes", &json!({"jobId":initial["id"]})).unwrap().as_array().unwrap().len(), 1);
    assert_eq!(store.execute("takeRequest",&json!({"id":recorded["id"]})).unwrap(),request);
    assert!(store.connection.execute("UPDATE take_requests SET data='{}'",[]).is_err());
}

fn generation_request(take: &mut Value) -> Value {
    let request=json!({"segment":{"id":take["segmentId"],"text":take["spokenText"],"spokenText":take["spokenText"],"chapter":take["chapter"],"voiceIds":["voice"],"referenceAssetIds":[]},"profile":{"id":"profile","name":"Test profile","backend":take["backend"],"model":take["model"],"direction":"","temperature":0.7,"topP":0.7,"chunkLength":300,"minChunkLength":50,"latency":"normal","dictionaryIds":[],"playbackRate":1},"dictionaries":[],"references":{},"connection":{"backend":take["backend"],"model":take["model"],"url":null,"runtimeVersion":null}});
    take["requestHash"]=json!(super::super::cache::request_hash(&request["segment"],&request["profile"],&request["dictionaries"],&request["references"],&request["connection"]).unwrap());
    request
}

#[test]
fn deleting_a_project_removes_its_scripts_requests_takes_and_history_transactionally() {
    let directory=TestDirectory::new();
    let mut store=directory.open();
    let project=save(&mut store,&draft(),Value::Null).unwrap();
    let asset=store.put_asset(&directory.audio(),"audio/wav",0.01,24_000,1).unwrap();
    let mut recorded=take(&project,&asset);
    let request=generation_request(&mut recorded);
    let mut render=job(&project,"running");
    store.put_job(&render).unwrap();
    store.connection.execute("INSERT INTO speech_requests VALUES(?1,?2)",params![render["id"].as_str(),json!({"privateScript":"Hello world"}).to_string()]).unwrap();
    render["takeIds"]=json!([recorded["id"]]);render["completedSegments"]=json!(1);
    store.put_completed_segment(&recorded,&render,&request).unwrap();
    render["state"]=json!("completed");store.put_job(&render).unwrap();
    let mut edited=project.clone();edited["selectedTakes"]=json!({"segment-1":recorded["id"]});
    save(&mut store,&edited,project["revisionId"].clone()).unwrap();
    let mut other=draft();other["id"]=json!("other-project");
    save(&mut store,&other,Value::Null).unwrap();
    store.execute("deleteProject",&json!({"id":project["id"]})).unwrap();
    assert!(store.execute("getProject",&json!({"id":project["id"]})).is_err());
    for table in ["jobs","takes","take_requests","job_takes","speech_requests","revision_takes"] {
        let count:i64=store.connection.query_row(&format!("SELECT count(*) FROM {table}"),[],|row|row.get(0)).unwrap();
        assert_eq!(count,0,"{table}");
    }
    let count:i64=store.connection.query_row("SELECT count(*) FROM revisions WHERE project_id=?1",[project["id"].as_str()],|row|row.get(0)).unwrap();
    assert_eq!(count,0);
    assert!(store.connection.execute("DELETE FROM revisions",[]).is_err());
    assert!(store.execute("getProject",&json!({"id":"other-project"})).is_ok());
}

#[test]
fn deletion_preserves_running_jobs_and_cross_project_take_dependencies() {
    let directory=TestDirectory::new();
    let mut store=directory.open();
    let project=save(&mut store,&draft(),Value::Null).unwrap();
    let mut render=job(&project,"running");store.put_job(&render).unwrap();
    assert!(store.execute("deleteProject",&json!({"id":project["id"]})).unwrap_err().contains("active renders"));
    render["state"]=json!("cancelled");store.put_job(&render).unwrap();
    let asset=store.put_asset(&directory.audio(),"audio/wav",0.01,24_000,1).unwrap();
    let original=take(&project,&asset);store.put_take(&original).unwrap();
    let mut other=draft();other["id"]=json!("dependent-project");
    let other=save(&mut store,&other,Value::Null).unwrap();
    let mut reused=original.clone();reused["id"]=json!("reused-take");reused["projectId"]=other["id"].clone();reused["revisionId"]=other["revisionId"].clone();reused["reusedFromTakeId"]=original["id"].clone();
    store.put_take(&reused).unwrap();
    assert!(store.execute("deleteProject",&json!({"id":project["id"]})).unwrap_err().contains("reused elsewhere"));
    store.execute("deleteProject",&json!({"id":other["id"]})).unwrap();
    store.execute("deleteProject",&json!({"id":project["id"]})).unwrap();
}

#[test]
fn immutable_take_requests_reject_model_hash_and_secret_endpoint_changes() {
    let directory=TestDirectory::new();
    let mut store=directory.open();
    let project=save(&mut store,&draft(),Value::Null).unwrap();
    let asset=store.put_asset(&directory.audio(),"audio/wav",0.01,24_000,1).unwrap();
    let mut recorded=take(&project,&asset);
    let request=generation_request(&mut recorded);
    for (field,value) in [("model",json!("s2-pro")),("url",json!("https://server.invalid/?key=must-not-export"))] {
        let mut changed=request.clone();
        changed["connection"][field]=value;
        assert!(validate_take_request(&recorded,&changed).is_err());
    }
    let mut changed=request.clone();
    changed["profile"]["temperature"]=json!(1.5);
    assert!(validate_take_request(&recorded,&changed).is_err());
    assert!(store.execute("takeRequest",&json!({"id":"missing"})).is_err());
}

#[test]
fn project_compare_and_swap_restoration_and_revision_integrity() {
    let directory = TestDirectory::new();
    let mut store = directory.open();
    let first = save(&mut store, &draft(), Value::Null).unwrap();
    let first_revision = first["revisionId"].as_str().unwrap();
    assert_eq!(first_revision.len(), 36);
    assert_eq!(&first_revision[14..15], "4");
    assert!(matches!(&first_revision[19..20], "8" | "9" | "a" | "b"));
    assert_eq!(first["parentRevisionId"], Value::Null);
    assert!(save(&mut store, &draft(), Value::Null).unwrap_err().contains("conflict"));
    let mut changed = first.clone();
    changed["source"] = json!("A revised scene");
    changed["title"] = json!("Second title");
    let second = save(&mut store, &changed, first["revisionId"].clone()).unwrap();
    assert_ne!(first["revisionId"], second["revisionId"]);
    assert_eq!(second["parentRevisionId"], first["revisionId"]);
    assert_eq!(second["createdAt"], first["createdAt"]);
    assert!(save(&mut store, &changed, first["revisionId"].clone()).unwrap_err().contains("conflict"));
    let restored = store.execute("restoreRevision", &json!({
        "projectId": first["id"], "revisionId": first["revisionId"],
        "expectedRevisionId": second["revisionId"]
    })).unwrap();
    assert_eq!(restored["source"], first["source"]);
    assert_eq!(restored["title"], first["title"]);
    assert_eq!(restored["parentRevisionId"], second["revisionId"]);
    assert_ne!(restored["revisionId"], first["revisionId"]);
    let revisions = store.execute("revisions", &json!({"projectId": first["id"],"offset":0,"limit":20})).unwrap();
    assert_eq!(revisions["revisions"].as_array().unwrap().len(), 3);
    assert_eq!(revisions["revisions"][2]["contentHash"], digest(encode(&first).unwrap().as_bytes()));
    assert!(store.connection.execute("UPDATE revisions SET source='tampered'", []).is_err());
    assert!(store.connection.execute("DELETE FROM revisions", []).is_err());
    assert!(store.connection.execute("UPDATE projects SET revision_id='missing'", []).is_err());
    drop(store);
    let mut reopened = directory.open();
    assert_eq!(reopened.execute("getProject", &json!({"id": first["id"]})).unwrap(), restored);
    assert_eq!(reopened.execute("revisions", &json!({"projectId": first["id"],"offset":0,"limit":20})).unwrap(), revisions);
}

#[test]
fn concurrent_connections_allow_exactly_one_writer_for_a_revision() {
    let directory = TestDirectory::new();
    let mut store = directory.open();
    let project = save(&mut store, &draft(), Value::Null).unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let mut workers = Vec::new();
    for index in 0..2 {
        let root = directory.0.join("store");
        let mut changed = project.clone();
        let expected = project["revisionId"].clone();
        let barrier = Arc::clone(&barrier);
        workers.push(thread::spawn(move || {
            let mut store = SpeechStore::open(root).unwrap();
            changed["source"] = json!(format!("Writer {index}"));
            barrier.wait();
            save(&mut store, &changed, expected)
        }));
    }
    barrier.wait();
    let results: Vec<_> = workers.into_iter().map(|worker| worker.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(results.iter().filter(|result| result.as_ref().is_err_and(|error| error.contains("conflict"))).count(), 1);
    assert_eq!(store.execute("revisions", &json!({"projectId": project["id"],"offset":0,"limit":20})).unwrap()["revisions"].as_array().unwrap().len(), 2);
}

#[test]
fn restart_preserves_completed_takes_and_never_replays_uncertain_jobs() {
    let directory = TestDirectory::new();
    let mut store = directory.open();
    let project = save(&mut store, &draft(), Value::Null).unwrap();
    let asset = store.put_asset(&directory.audio(), "audio/wav", 0.01, 24_000, 1).unwrap();
    let take = take(&project, &asset);
    store.put_take(&take).unwrap();
    let mut running = job(&project, "running");
    running["takeIds"] = json!([take["id"]]);
    store.put_job(&running).unwrap();
    let mut queued = job(&project, "queued");
    queued["id"] = json!("job-queued");
    store.put_job(&queued).unwrap();
    let mut completed = job(&project, "running");
    completed["id"] = json!("job-completed");
    store.put_job(&completed).unwrap();
    completed["state"] = json!("completed");
    completed["completedSegments"] = json!(1);
    completed["takeIds"] = json!([take["id"]]);
    store.put_job(&completed).unwrap();
    drop(store);
    let mut reopened = directory.open();
    let jobs = reopened.execute("listJobs", &json!({"owner": "text-to-speech"})).unwrap();
    let recovered = jobs.as_array().unwrap().iter().find(|job| job["id"] == "job-1").unwrap();
    assert_eq!(recovered["state"], "uncertain");
    assert_eq!(recovered["takeIds"], running["takeIds"]);
    assert!(recovered["error"].as_str().unwrap().contains("billed"));
    assert_eq!(jobs.as_array().unwrap().iter().find(|job| job["id"] == "job-queued").unwrap()["state"], "queued");
    assert_eq!(jobs.as_array().unwrap().iter().find(|job| job["id"] == "job-completed").unwrap()["state"], "completed");
    let mut replay = recovered.clone();
    replay["state"] = json!("running");
    assert!(reopened.put_job(&replay).unwrap_err().contains("cannot be replayed"));
    let takes = reopened.execute("listTakes", &json!({"projectId": project["id"], "jobId": running["id"]})).unwrap();
    assert_eq!(takes, json!([take]));
    assert_eq!(reopened.execute("asset", &json!({"id": asset["id"]})).unwrap(), asset);
    reopened.recover_interrupted().unwrap();
    assert_eq!(reopened.execute("listJobs", &json!({"owner": "text-to-speech"})).unwrap(), jobs);
    assert_eq!(reopened.execute("listJobs", &json!({"owner": "different-owner"})).unwrap(), json!([]));
}

#[test]
fn content_addressed_assets_deduplicate_and_preserve_integrity_after_project_deletion() {
    let directory = TestDirectory::new();
    let mut store = directory.open();
    let input = directory.audio();
    let asset = store.put_asset(&input, "audio/wav", 0.01, 24_000, 1).unwrap();
    let id = asset["id"].as_str().unwrap();
    assert_eq!(asset["sha256"], id);
    assert_eq!(asset["bytes"], 524);
    assert_eq!(id, digest(&fs::read(&input).unwrap()));
    assert_eq!(store.put_asset(&input, "audio/wav", 0.01, 24_000, 1).unwrap(), asset);
    assert!(store.put_asset(&input, "audio/wav", 0.02, 24_000, 1).is_err());
    assert!(store.asset_path("../outside").is_err());
    assert!(store.execute("asset", &json!({"id": "a".repeat(64)})).is_err());
    let project = save(&mut store, &draft(), Value::Null).unwrap();
    let take = take(&project, &asset);
    store.put_take(&take).unwrap();
    let mut with_clip = project.clone();
    with_clip["timeline"] = json!([{
        "id": "clip-1", "takeId": take["id"], "start": 0.0, "in": 0.0, "out": 0.01,
        "gain": 1.0, "fadeIn": 0.0, "fadeOut": 0.0, "track": 0
    }]);
    save(&mut store, &with_clip, project["revisionId"].clone()).unwrap();
    store.execute("deleteProject", &json!({"id": project["id"]})).unwrap();
    assert_eq!(store.execute("listProjects", &json!({"offset":0,"limit":20})).unwrap()["projects"], json!([]));
    assert!(store.execute("getProject", &json!({"id": project["id"]})).is_err());
    assert!(save(&mut store, &draft(), Value::Null).is_err());
    assert_eq!(store.execute("listTakes", &json!({"projectId": project["id"]})).unwrap(), json!([]));
    let path = store.asset_path(id).unwrap();
    assert!(store.connection.execute("DELETE FROM assets WHERE id=?1", [id]).is_err());
    assert_eq!(store.connection.execute("DELETE FROM takes WHERE id='take-1'", []).unwrap(),0);
    assert_eq!(store.execute("asset", &json!({"id": id})).unwrap(), asset);
    let mut corrupted = fs::read(&path).unwrap();
    corrupted[100] = 1;
    fs::write(&path, &corrupted).unwrap();
    assert!(store.asset_path(id).unwrap_err().contains("SHA-256"));
    assert!(store.put_asset(&input, "audio/wav", 0.01, 24_000, 1).is_err());
    drop(store);
    let reopened = directory.open();
    assert!(reopened.asset_path(id).is_err());
    fs::write(&path, &corrupted[..100]).unwrap();
    assert!(reopened.asset_path(id).unwrap_err().contains("size"));
}

#[test]
fn dictionaries_profiles_and_revision_snapshots_survive_later_edits() {
    let directory = TestDirectory::new();
    let mut store = directory.open();
    let dictionary = json!({
        "id": "dictionary-1", "name": "Names", "revision": "", "rules": [{
            "id": "rule-1", "text": "Machdoch", "phonemes": "M AA K", "alphabet": "arpabet", "caseSensitive": true
        }]
    });
    let first_dictionary = store.execute("saveDictionary", &json!({"dictionary": dictionary})).unwrap();
    let first_profile = profile();
    assert_eq!(store.execute("saveProfile", &json!({"profile": first_profile})).unwrap(), first_profile);
    let mut project = draft();
    project["profileId"] = first_profile["id"].clone();
    let project = save(&mut store, &project, Value::Null).unwrap();
    let mut edited_dictionary = first_dictionary.clone();
    edited_dictionary["rules"][0]["phonemes"] = json!("M AA K D AA K");
    let second_dictionary = store.execute("saveDictionary", &json!({"dictionary": edited_dictionary})).unwrap();
    assert_ne!(first_dictionary["revision"], second_dictionary["revision"]);
    let mut edited_profile = first_profile.clone();
    edited_profile["temperature"] = json!(0.9);
    store.execute("saveProfile", &json!({"profile": edited_profile})).unwrap();
    let snapshot: String = store.connection.query_row(
        "SELECT data FROM revision_profiles WHERE revision_id=?1",
        [project["revisionId"].as_str().unwrap()], |row| row.get(0)
    ).unwrap();
    assert_eq!(parse_json(snapshot).unwrap(), first_profile);
    let pinned_dictionary: String = store.connection.query_row(
        "SELECT dictionary_revision FROM revision_dictionaries WHERE revision_id=?1",
        [project["revisionId"].as_str().unwrap()], |row| row.get(0)
    ).unwrap();
    assert_eq!(pinned_dictionary, first_dictionary["revision"].as_str().unwrap());
    assert!(store.execute("deleteProfile", &json!({"id": first_profile["id"]})).is_err());
    let mut detached = project.clone();
    detached["profileId"] = Value::Null;
    save(&mut store, &detached, project["revisionId"].clone()).unwrap();
    store.execute("deleteProfile", &json!({"id": first_profile["id"]})).unwrap();
    assert_eq!(store.execute("listProfiles", &json!({})).unwrap(), json!([]));
    assert_eq!(store.execute("listDictionaries", &json!({})).unwrap(), json!([second_dictionary]));
    assert!(store.connection.execute("DELETE FROM dictionary_revisions", []).is_err());
}

#[test]
fn take_annotations_change_without_mutating_provenance() {
    let directory = TestDirectory::new();
    let mut store = directory.open();
    let project = save(&mut store, &draft(), Value::Null).unwrap();
    let asset = store.put_asset(&directory.audio(), "audio/wav", 0.01, 24_000, 1).unwrap();
    let original = take(&project, &asset);
    store.put_take(&original).unwrap();
    store.put_take(&original).unwrap();
    let edited = store.execute("updateTake", &json!({
        "id": original["id"], "favorite": true, "rating": 5, "note": "Use this take"
    })).unwrap();
    let mut expected = original.clone();
    expected["favorite"] = json!(true);
    expected["rating"] = json!(5);
    expected["note"] = json!("Use this take");
    assert_eq!(edited, expected);
    assert!(store.execute("updateTake", &json!({"id": original["id"], "rating": 6})).is_err());
    assert!(store.execute("updateTake", &json!({"id": original["id"], "asset": asset})).is_err());
    let mut tampered = edited.clone();
    tampered["requestHash"] = json!(digest(b"changed request"));
    assert!(store.put_take(&tampered).is_err());
    assert!(store.connection.execute(
        "UPDATE takes SET data=json_set(data,'$.model','tampered') WHERE id=?1",
        [original["id"].as_str().unwrap()]
    ).is_err());
    assert_eq!(store.execute("listTakes", &json!({"projectId": project["id"]})).unwrap(), json!([expected]));
}

#[test]
fn malformed_project_boundaries_and_foreign_references_are_rejected_atomically() {
    let directory = TestDirectory::new();
    let mut store = directory.open();
    let original = draft();
    let mut cases = Vec::new();
    let mut invalid = original.clone();
    invalid["id"] = json!("../escape");
    cases.push(invalid);
    let mut invalid = original.clone();
    invalid["title"] = json!("  ");
    cases.push(invalid);
    let mut invalid = original.clone();
    invalid["source"] = json!("x".repeat(MAX_SOURCE_BYTES + 1));
    cases.push(invalid);
    let mut invalid = original.clone();
    invalid["cast"] = json!([
        {"id":"speaker-1","name":"One","referenceAssetIds":[],"direction":""},
        {"id":"speaker-1","name":"Two","referenceAssetIds":[],"direction":""}
    ]);
    cases.push(invalid);
    let mut invalid = original.clone();
    invalid["timeline"] = json!([{
        "id":"clip-1","takeId":"missing","start":0,"in":1,"out":0,
        "gain":1,"fadeIn":0,"fadeOut":0,"track":0
    }]);
    cases.push(invalid);
    let mut invalid = original.clone();
    invalid["profileId"] = json!("missing-profile");
    cases.push(invalid);
    let mut invalid = original.clone();
    invalid["selectedTakes"] = json!({"segment-1":"missing-take"});
    cases.push(invalid);
    let mut invalid = original.clone();
    invalid["bookmarks"] = json!([{"id":"bookmark-1","label":"Invalid position","offset":-1}]);
    cases.push(invalid);
    let mut invalid = original.clone();
    invalid["audioBytes"] = json!([0, 1, 2]);
    cases.push(invalid);
    for invalid in cases {
        assert!(save(&mut store, &invalid, Value::Null).is_err());
    }
    assert_eq!(store.execute("listProjects", &json!({"offset":0,"limit":20})).unwrap()["projects"], json!([]));
    assert_eq!(store.connection.query_row("SELECT count(*) FROM revisions", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    let first = save(&mut store, &original, Value::Null).unwrap();
    let asset = store.put_asset(&directory.audio(), "audio/wav", 0.01, 24_000, 1).unwrap();
    let take = take(&first, &asset);
    store.put_take(&take).unwrap();
    let mut another = draft();
    another["id"] = json!("project-2");
    another["selectedTakes"] = json!({"segment-1": take["id"]});
    assert!(save(&mut store, &another, Value::Null).is_err());
    another["selectedTakes"] = json!({});
    let another = save(&mut store, &another, Value::Null).unwrap();
    assert!(store.execute("restoreRevision", &json!({
        "projectId": another["id"], "revisionId": first["revisionId"],
        "expectedRevisionId": another["revisionId"]
    })).is_err());
    let mut wrong_job = job(&another, "queued");
    wrong_job["revisionId"] = first["revisionId"].clone();
    assert!(store.put_job(&wrong_job).is_err());
    assert!(store.execute("listProjects", &json!({"archived": "false","offset":0,"limit":20})).is_err());
    assert_eq!(store.execute("listProjects", &json!({"search": "Hello", "archived": false,"offset":0,"limit":20})).unwrap()["projects"].as_array().unwrap().len(), 2);
    assert_eq!(store.execute("listProjects", &json!({"search": "%","offset":0,"limit":20})).unwrap()["projects"], json!([]));
    assert_eq!(store.connection.query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    assert_eq!(store.connection.query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0)).unwrap(), "wal");
}

#[test]
fn answer_playback_can_persist_without_a_project_and_job_links_are_scoped() {
    let directory = TestDirectory::new();
    let mut store = directory.open();
    let answer = json!({"id": null, "revisionId": "answer-revision"});
    let asset = store.put_asset(&directory.audio(), "audio/wav", 0.01, 24_000, 1).unwrap();
    let take = take(&answer, &asset);
    store.put_take(&take).unwrap();
    let mut job = job(&answer, "running");
    job["owner"] = json!("answer-session-1");
    job["takeIds"] = json!([take["id"]]);
    store.put_job(&job).unwrap();
    job["state"] = json!("completed");
    job["completedSegments"] = json!(1);
    store.put_job(&job).unwrap();
    assert_eq!(store.execute("listTakes", &json!({"jobId": job["id"]})).unwrap(), json!([take]));
    let mut changed = job.clone();
    changed["state"] = json!("running");
    assert!(store.put_job(&changed).is_err());
    changed = job.clone();
    changed["owner"] = json!("different-session");
    assert!(store.put_job(&changed).is_err());
    changed = job.clone();
    changed["takeIds"] = json!([]);
    assert!(store.put_job(&changed).is_err());
    assert!(store.execute("listJobs", &json!({"projectId": null})).is_err());
    assert!(store.execute("render", &json!({})).is_err());
}
