use super::*;

fn age(path: &Path) {
    OpenOptions::new().write(true).open(path).unwrap().set_times(fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::from_secs(1))).unwrap();
}

fn orphan(store: &SpeechStore, content: &[u8]) -> (String,PathBuf) {
    let id=digest(content);let parent=store.root.join("blobs").join(&id[..2]);fs::create_dir_all(&parent).unwrap();let path=parent.join(&id);fs::write(&path,content).unwrap();age(&path);(id,path)
}

#[test]
fn orphan_cleanup_preserves_staging_and_analysis_consumers_then_reclaims_abandoned_files() {
    let fixture=Fixture::new();let mut store=SpeechStore::open(fixture.0.join("store")).unwrap();
    let saved=fixture.asset(&mut store,b"saved reference");store.connection.execute("INSERT INTO speech_references VALUES(?1,'Transcript','Owner permission')",[saved["id"].as_str().unwrap()]).unwrap();
    let (id,blob)=orphan(&store,b"unregistered staged audio");let (_,unused)=orphan(&store,b"abandoned audio");
    let mut reservation=store.reserve_assets().unwrap();reservation.protect(&mut store,&[id.clone(),id.clone()]).unwrap();
    let reservation_id:String=store.connection.query_row("SELECT id FROM speech_asset_reservations",[],|row|row.get(0)).unwrap();
    let part=store.root.join("blobs").join(format!(".stage-{reservation_id}-{}.part",uuid().unwrap()));fs::write(&part,b"partial staged bytes").unwrap();age(&part);
    let analysis=store.root.join("analysis");fs::create_dir(&analysis).unwrap();
    let retained=analysis.join(format!("{id}-256-v3-{}.json","f".repeat(64)));fs::write(&retained,b"{}").unwrap();age(&retained);
    let abandoned=analysis.join(format!("{}-256-v3-{}.{}.part","a".repeat(64),"f".repeat(64),uuid().unwrap()));fs::write(&abandoned,b"{}").unwrap();age(&abandoned);
    let foreign=analysis.join("personal.json");fs::write(&foreign,b"not a managed cache file").unwrap();age(&foreign);
    let result=store.clean_cache(0,Utc::now()).unwrap();assert_eq!(result["assets"],1);assert!(!unused.exists());assert!(!abandoned.exists());
    for path in [&blob,&part,&retained,&foreign] {assert!(path.exists());}
    reservation.release(&mut store).unwrap();let result=store.execute("cleanCache",&json!({"restart":true})).unwrap();assert_eq!(result["assets"],1);
    for path in [&blob,&part,&retained] {assert!(!path.exists());}
    assert!(foreign.exists());assert!(store.asset_path(saved["id"].as_str().unwrap()).is_ok());
}

#[test]
fn bounded_orphan_scanning_advances_past_unmanaged_entries_without_starvation() {
    let fixture=Fixture::new();let mut store=SpeechStore::open(fixture.0.join("store")).unwrap();
    for index in 0..260 {fs::write(store.root.join("blobs").join(format!("unmanaged-{index}")),b"keep").unwrap();}
    let (_,path)=orphan(&store,b"orphan beyond directory batches");
    let mut result=store.clean_cache(0,Utc::now()).unwrap();assert_eq!(result["pending"],true);let mut assets=result["assets"].as_u64().unwrap();let mut calls=1;
    while result["pending"]==true {assert!(calls<10);result=store.clean_cache(0,Utc::now()).unwrap();assets+=result["assets"].as_u64().unwrap();calls+=1;}
    assert_eq!(assets,1);assert!(!path.exists());assert!(calls>=3);
    for index in 0..260 {assert_eq!(fs::read(store.root.join("blobs").join(format!("unmanaged-{index}"))).unwrap(),b"keep");}
}

#[test]
fn cleanup_removes_unavailable_blobs_that_reappear_after_a_failed_repopulation() {
    let fixture=Fixture::new();let mut store=SpeechStore::open(fixture.0.join("store")).unwrap();let asset=fixture.asset(&mut store,b"expired cached audio");let path=store.asset_path(asset["id"].as_str().unwrap()).unwrap();age(&path);
    store.connection.execute("UPDATE speech_asset_access SET accessed_at='2000-01-01T00:00:00Z'",[]).unwrap();
    assert_eq!(store.clean_cache(0,Utc::now()).unwrap()["assets"],1);assert!(!path.exists());
    fs::write(&path,b"failed repopulation bytes").unwrap();
    let result=store.clean_cache(7,Utc::now()).unwrap();assert_eq!(result["assets"],1);assert_eq!(result["bytes"],25);assert!(!path.exists());
    assert!(store.asset_path(asset["id"].as_str().unwrap()).unwrap_err().contains("expired"));
}

#[test]
fn orphan_cleanup_refuses_to_recurse_into_a_directory_named_as_an_audio_blob() {
    let fixture=Fixture::new();let mut store=SpeechStore::open(fixture.0.join("store")).unwrap();let id="a".repeat(64);let path=store.root.join("blobs").join("aa").join(id);fs::create_dir_all(&path).unwrap();let child=path.join("keep.txt");fs::write(&child,b"preserve").unwrap();
    assert!(store.clean_cache(0,Utc::now()).unwrap_err().contains("regular file"));assert_eq!(fs::read(child).unwrap(),b"preserve");
}

#[test]
fn invalid_retention_dates_are_rejected_before_settings_or_cleanup_can_change_data() {
    let fixture=Fixture::new();let mut store=SpeechStore::open(fixture.0.join("store")).unwrap();
    let preferences=json!({"cloudConsent":false,"maxConcurrent":1,"pricing":null,"budgetLimit":null,"answerBudgetLimit":null,"answerCharacterLimit":10000,"cacheRetentionDays":u32::MAX});
    use super::super::super::super::settings;
    assert!(settings::save_settings(&store,&preferences).unwrap_err().contains("retention"));
    assert_eq!(settings::raw_settings(&store).unwrap()["cacheRetentionDays"],7);
    assert!(store.clean_cache(u64::MAX,Utc::now()).is_err());assert!(store.cache_retention_cutoff(36_500_000,Utc::now()).is_err());
}

#[test]
fn overlapping_cleanup_continuations_observe_completion_until_an_explicit_or_scheduled_restart() {
    let fixture=Fixture::new();let mut store=SpeechStore::open(fixture.0.join("store")).unwrap();
    for index in 0..260 {fs::write(store.root.join("blobs").join(format!("foreign-{index}")),b"keep").unwrap();}
    assert!(store.execute("cleanCache",&json!({})).is_err());
    assert_eq!(store.execute("cleanCache",&json!({"restart":true})).unwrap()["pending"],true);
    let now=Utc::now();let mut calls=0;
    while store.clean_cache(7,now).unwrap()["pending"]==true {calls+=1;assert!(calls<10);}
    let (_,path)=orphan(&store,b"created after background completion");
    assert_eq!(store.execute("cleanCache",&json!({"restart":false})).unwrap()["pending"],false);assert!(path.exists());
    let mut result=store.execute("cleanCache",&json!({"restart":true})).unwrap();let mut calls=0;
    while result["pending"]==true {calls+=1;assert!(calls<10);result=store.execute("cleanCache",&json!({"restart":false})).unwrap();}
    assert!(!path.exists());
    let (_,later)=orphan(&store,b"created before scheduled cleanup");
    let future=now+chrono::Duration::minutes(31);let mut result=store.clean_cache(7,future).unwrap();let mut calls=0;
    while result["pending"]==true {calls+=1;assert!(calls<10);result=store.clean_cache(7,future).unwrap();}
    assert!(!later.exists());
}
