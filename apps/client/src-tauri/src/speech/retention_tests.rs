use super::*;

#[path="orphan_cache_tests.rs"]
mod orphan_cache;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("speech-retention-{}", uuid().unwrap()));
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }

    fn asset(&self, store: &mut SpeechStore, content: &[u8]) -> Value {
        let path = self.0.join("sample");
        let mut writer=hound::WavWriter::create(&path,hound::WavSpec{channels:1,sample_rate:24000,bits_per_sample:16,sample_format:hound::SampleFormat::Int}).unwrap();
        for index in 0..24000 { writer.write_sample::<i16>(i16::from(content[index%content.len()])*100).unwrap(); }
        writer.finalize().unwrap();
        store.put_asset(&path,"audio/wav",1.0,24_000,1).unwrap()
    }
}

impl Drop for Fixture { fn drop(&mut self) { fs::remove_dir_all(&self.0).unwrap(); } }

fn future() -> DateTime<Utc> { Utc::now() + chrono::Duration::days(30) }

#[test]
fn cleanup_reclaims_orphans_and_restores_identical_audio_without_changing_immutable_metadata() {
    let fixture=Fixture::new();
    let mut store=SpeechStore::open(fixture.0.join("store")).unwrap();
    let asset=fixture.asset(&mut store,b"unreferenced immutable audio");
    let id=asset["id"].as_str().unwrap();
    let path=store.asset_path(id).unwrap();
    let result=store.clean_cache(7,future()).unwrap();
    assert_eq!(result["assets"],1);
    assert_eq!(result["bytes"],asset["bytes"]);
    assert!(!path.exists());
    assert!(store.asset_path(id).unwrap_err().contains("expired"));
    assert_eq!(store.clean_cache(7,future()).unwrap()["assets"],0);
    let restored=fixture.asset(&mut store,b"unreferenced immutable audio");
    assert_eq!(restored,asset);
    assert_eq!(store.asset_path(id).unwrap(),path);
}

#[test]
fn cleanup_keeps_recent_audio_and_reusable_reference_originals_and_design_candidates() {
    let fixture=Fixture::new();
    let mut store=SpeechStore::open(fixture.0.join("store")).unwrap();
    let recent=fixture.asset(&mut store,b"recent audio");
    assert_eq!(store.clean_cache(7,Utc::now()).unwrap()["assets"],0);
    let original=fixture.asset(&mut store,b"original recording");
    let trimmed=fixture.asset(&mut store,b"trimmed recording");
    let design=fixture.asset(&mut store,b"designed voice");
    store.connection.execute("INSERT INTO speech_references VALUES(?1,'accurate transcript','owner permission')",[trimmed["id"].as_str().unwrap()]).unwrap();
    store.connection.execute("INSERT INTO speech_reference_originals VALUES(?1,?2)",params![trimmed["id"].as_str(),original["id"].as_str()]).unwrap();
    store.connection.execute("INSERT INTO speech_design_candidates VALUES('candidate',?1,'{}')",[design["id"].as_str().unwrap()]).unwrap();
    assert_eq!(store.clean_cache(7,future()).unwrap()["assets"],1);
    assert!(store.asset_path(recent["id"].as_str().unwrap()).is_err());
    for asset in [original,trimmed,design] { assert!(store.asset_path(asset["id"].as_str().unwrap()).is_ok()); }
}

#[test]
fn active_jobs_protect_only_their_inputs_and_access_refreshes_the_cache_retention_clock() {
    let fixture=Fixture::new();
    let mut store=SpeechStore::open(fixture.0.join("store")).unwrap();
    let asset=fixture.asset(&mut store,b"pinned input speech");
    let orphan=fixture.asset(&mut store,b"unrelated expired speech");
    store.connection.execute("INSERT INTO jobs(id,owner,revision_id,state,created_at,data) VALUES('job','chat:one','answer','running','2000-01-01T00:00:00Z','{}')",[]).unwrap();
    let mut snapshot=json!({"references":{}});snapshot["references"][asset["id"].as_str().unwrap()]=json!({"transcript":"Pinned transcript"});
    store.connection.execute("INSERT INTO speech_requests VALUES('job',?1)",[snapshot.to_string()]).unwrap();
    assert_eq!(store.clean_cache(7,future()).unwrap()["assets"],1);
    assert!(store.asset_path(orphan["id"].as_str().unwrap()).is_err());
    assert!(store.asset_path(asset["id"].as_str().unwrap()).is_ok());
    store.connection.execute("DELETE FROM speech_requests",[]).unwrap();
    store.connection.execute("DELETE FROM jobs",[]).unwrap();
    store.connection.execute("UPDATE speech_asset_access SET accessed_at=?1",[future().to_rfc3339()]).unwrap();
    assert_eq!(store.clean_cache(7,future()).unwrap()["assets"],0);
    assert!(store.asset_path(asset["id"].as_str().unwrap()).is_ok());
}

#[test]
fn missing_blobs_do_not_starve_later_cleanup_batches(){
    let fixture=Fixture::new();let mut store=SpeechStore::open(fixture.0.join("store")).unwrap();
    let missing=fixture.asset(&mut store,b"missing cached audio");let id=missing["id"].as_str().unwrap();
    fs::remove_file(store.asset_path(id).unwrap()).unwrap();
    assert_eq!(store.clean_cache(7,future()).unwrap(),json!({"assets":1,"bytes":0,"pending":false}));
    assert_eq!(store.clean_cache(7,future()).unwrap()["assets"],0);
    assert!(store.asset_path(id).unwrap_err().contains("expired"));
}

#[test]
fn project_takes_and_favorite_transient_takes_are_never_expired() {
    let fixture=Fixture::new();
    let mut store=SpeechStore::open(fixture.0.join("store")).unwrap();
    let project_asset=fixture.asset(&mut store,b"project take");
    let favorite=fixture.asset(&mut store,b"favorite answer");
    let temporary=fixture.asset(&mut store,b"temporary answer");
    let project=json!({"id":"project","title":"Saved narration","source":"Hello","cast":[],"profileId":null,"revisionId":"","parentRevisionId":null,"createdAt":"","updatedAt":"","archived":false,"location":null,"timeline":[],"selectedTakes":{},"bookmarks":[],"variants":[]});
    let saved=store.execute("saveProject",&json!({"project":project,"expectedRevisionId":null})).unwrap();
    for (id,asset,project_id,revision,favorite) in [
        ("saved",&project_asset,saved["id"].clone(),saved["revisionId"].clone(),false),
        ("favorite",&favorite,Value::Null,json!("answer"),true),
        ("transient",&temporary,Value::Null,json!("answer"),false),
    ] {
        let now=timestamp();
        let take=json!({"id":id,"projectId":project_id,"revisionId":revision,"segmentId":"segment","spokenText":"Hello","chapter":null,"asset":asset,"createdAt":now,"generatedAt":now,"reusedFromTakeId":null,"backend":"fish-cloud","model":"drama-3","requestHash":digest(b"request"),"parentTakeId":null,"favorite":favorite,"rating":null,"note":"","alignment":[]});
        store.put_take(&take).unwrap();
    }
    assert_eq!(store.clean_cache(7,future()).unwrap()["assets"],1);
    assert!(store.asset_path(project_asset["id"].as_str().unwrap()).is_ok());
    assert!(store.asset_path(favorite["id"].as_str().unwrap()).is_ok());
    assert!(store.asset_path(temporary["id"].as_str().unwrap()).unwrap_err().contains("expired"));
}

fn protect(store:&mut SpeechStore,id:&str,owner:&str,assets:Value,jobs:Value,now:DateTime<Utc>)->Result<Value,String>{
    super::super::playback_leases::execute(store,"retainPlayback",&json!({"id":id,"owner":owner,"assetIds":assets,"jobIds":jobs}),now)
}

#[test]
fn paused_playback_keeps_expired_audio_until_its_owner_releases_it(){
    let fixture=Fixture::new();let mut store=SpeechStore::open(fixture.0.join("store")).unwrap();let asset=fixture.asset(&mut store,b"paused transient speech");let id=asset["id"].as_str().unwrap();let now=future();
    protect(&mut store,"player","chat:one",json!([id]),json!([]),now).unwrap();
    assert_eq!(store.clean_cache(7,now+chrono::Duration::minutes(9)).unwrap()["assets"],0);
    assert!(protect(&mut store,"player","chat:two",json!([]),json!([]),now).unwrap_err().contains("another"));
    assert!(store.execute("releasePlayback",&json!({"id":"player","owner":"chat:two"})).is_err());
    store.execute("releasePlayback",&json!({"id":"player","owner":"chat:one"})).unwrap();
    assert_eq!(store.clean_cache(7,now).unwrap()["assets"],1);
    assert!(protect(&mut store,"player","chat:one",json!([id]),json!([]),now).unwrap_err().contains("unavailable"));
}

#[test]
fn renewal_is_durable_across_connections_and_abandoned_players_expire(){
    let fixture=Fixture::new();let root=fixture.0.join("store");let mut store=SpeechStore::open(root.clone()).unwrap();let asset=fixture.asset(&mut store,b"leased speech after reconnect");let now=future();
    protect(&mut store,"player","chat:one",json!([asset["id"]]),json!([]),now).unwrap();
    let mut second=SpeechStore::open(root).unwrap();
    protect(&mut second,"player","chat:one",json!([]),json!([]),now+chrono::Duration::minutes(8)).unwrap();
    assert_eq!(store.clean_cache(7,now+chrono::Duration::minutes(11)).unwrap()["assets"],0);
    assert_eq!(store.clean_cache(7,now+chrono::Duration::minutes(19)).unwrap()["assets"],1);
    assert!(protect(&mut second,"player","chat:one",json!([]),json!([]),now+chrono::Duration::minutes(19)).unwrap_err().contains("expired"));
    let count:i64=store.connection.query_row("SELECT count(*) FROM speech_playback_assets",[],|row|row.get(0)).unwrap();assert_eq!(count,0);
}

#[test]
fn a_streaming_job_lease_protects_its_future_completed_audio_without_a_global_active_job(){
    let fixture=Fixture::new();let mut store=SpeechStore::open(fixture.0.join("store")).unwrap();let now=future();
    store.connection.execute("INSERT INTO jobs(id,owner,revision_id,state,created_at,data) VALUES('stream','chat:one','answer','completed','2000-01-01T00:00:00Z','{}')",[]).unwrap();
    protect(&mut store,"player","chat:one",json!([]),json!(["stream"]),now).unwrap();
    let asset=fixture.asset(&mut store,b"streamed immutable speech");let time=timestamp();let take=json!({"id":"stream-take","projectId":null,"revisionId":"answer","segmentId":"segment","spokenText":"Hello","chapter":null,"asset":asset,"createdAt":time,"generatedAt":time,"reusedFromTakeId":null,"backend":"fish-cloud","model":"drama-3","requestHash":digest(b"request"),"parentTakeId":null,"favorite":false,"rating":null,"note":"","alignment":[]});store.put_take(&take).unwrap();
    store.connection.execute("INSERT INTO job_takes VALUES('stream','stream-take')",[]).unwrap();
    assert_eq!(store.clean_cache(7,now).unwrap()["assets"],0);
    assert_eq!(store.clean_cache(7,now+chrono::Duration::minutes(11)).unwrap()["assets"],1);
}

#[test]
fn playback_admission_is_atomic_and_cannot_protect_another_owners_job(){
    let fixture=Fixture::new();let mut store=SpeechStore::open(fixture.0.join("store")).unwrap();let asset=fixture.asset(&mut store,b"protected audio");let now=future();
    store.connection.execute("INSERT INTO jobs(id,owner,revision_id,state,created_at,data) VALUES('stream','chat:two','answer','completed','2000-01-01T00:00:00Z','{}')",[]).unwrap();
    assert!(protect(&mut store,"player","chat:one",json!([asset["id"]]),json!(["stream"]),now).unwrap_err().contains("owned"));
    let count:i64=store.connection.query_row("SELECT count(*) FROM speech_playback_leases",[],|row|row.get(0)).unwrap();assert_eq!(count,0);
    assert!(protect(&mut store,"player","chat:one",json!([asset["id"],asset["id"]]),json!([]),now).unwrap_err().contains("duplicate"));
    assert_eq!(store.clean_cache(7,now).unwrap()["assets"],1);
}
