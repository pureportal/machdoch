use super::*;
use std::io::Cursor;
use std::sync::{mpsc,Mutex};
use std::time::SystemTime;

struct GatedAudio {
    input: Cursor<Vec<u8>>,
    started: Option<mpsc::Sender<()>>,
    resume: mpsc::Receiver<()>,
}

impl Read for GatedAudio {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        if let Some(started)=self.started.take() {
            started.send(()).unwrap();
            self.resume.recv_timeout(Duration::from_secs(30)).unwrap();
        }
        self.input.read(bytes)
    }
}

#[test]
fn gated_audio_staging_leaves_the_shared_metadata_store_available() {
    let directory=TestDirectory::new();let source=fs::read(directory.audio()).unwrap();
    let store=Arc::new(Mutex::new(directory.open()));
    let mut reservation=store.lock().unwrap().reserve_assets().unwrap();
    let (started_tx,started_rx)=mpsc::channel();let (resume_tx,resume_rx)=mpsc::channel();
    let writer_store=store.clone();
    let writer=thread::spawn(move || {
        let bytes=source.len() as u64;
        let mut input=GatedAudio{input:Cursor::new(source),started:Some(started_tx),resume:resume_rx};
        let stage=StagedAsset::from_reader(&reservation,&mut input,bytes,"audio/wav",0.01,24000,1,None).unwrap();
        reservation.protect(&mut writer_store.lock().unwrap(),&[stage.id().to_owned()]).unwrap();
        let published=stage.publish(&reservation,None).unwrap();
        let mut store=writer_store.lock().unwrap();let asset=store.commit_staged_asset(&reservation,&published).unwrap();
        reservation.release(&mut store).unwrap();asset
    });
    started_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let (metadata_tx,metadata_rx)=mpsc::channel();let metadata_store=store.clone();
    let metadata=thread::spawn(move || { let result=metadata_store.lock().unwrap().execute("queue",&json!({"paused":true}));metadata_tx.send(result).unwrap(); });
    let available=metadata_rx.recv_timeout(Duration::from_secs(5));resume_tx.send(()).unwrap();
    metadata.join().unwrap();let asset=writer.join().unwrap();
    assert_eq!(available.unwrap().unwrap(),json!({"paused":true}));
    assert_eq!(store.lock().unwrap().asset_record(asset["id"].as_str().unwrap()).unwrap(),asset);
}

#[test]
fn an_asset_reservation_protects_only_its_audio_until_publication_finishes() {
    let directory=TestDirectory::new();let mut store=directory.open();let source=directory.audio();
    let asset=store.put_asset(&source,"audio/wav",0.01,24000,1).unwrap();let id=asset["id"].as_str().unwrap();
    let path=store.asset_path(id).unwrap();
    OpenOptions::new().write(true).open(&path).unwrap().set_times(std::fs::FileTimes::new().set_modified(SystemTime::UNIX_EPOCH+Duration::from_secs(1))).unwrap();
    store.connection.execute("UPDATE speech_asset_access SET accessed_at='2000-01-01T00:00:00Z'",[]).unwrap();
    let mut reservation=store.reserve_assets().unwrap();reservation.protect(&mut store,&[id.to_owned()]).unwrap();
    assert_eq!(store.clean_cache(0,Utc::now()).unwrap()["assets"],0);assert!(path.exists());
    reservation.release(&mut store).unwrap();
    assert_eq!(store.clean_cache(0,Utc::now()).unwrap()["assets"],1);assert!(!path.exists());
}

#[test]
fn invalid_and_cancelled_staging_keeps_the_users_source_and_publishes_nothing() {
    let directory=TestDirectory::new();let mut store=directory.open();let mut reservation=store.reserve_assets().unwrap();
    let malformed=directory.0.join("malformed.wav");fs::write(&malformed,b"not a WAV").unwrap();
    assert!(StagedAsset::from_file(&reservation,&malformed,"audio/wav",1.0,24000,1,None).is_err());
    let cancelled=tokio_util::sync::CancellationToken::new();cancelled.cancel();
    assert!(StagedAsset::from_file(&reservation,&directory.audio(),"audio/wav",0.01,24000,1,Some(&cancelled)).is_err());
    assert_eq!(fs::read(malformed).unwrap(),b"not a WAV");
    assert_eq!(fs::read_dir(store.root.join("blobs")).unwrap().count(),0);
    assert_eq!(store.connection.query_row("SELECT count(*) FROM assets",[],|row|row.get::<_,i64>(0)).unwrap(),0);
    reservation.release(&mut store).unwrap();
}

#[test]
fn export_retention_survives_source_project_deletion_without_protecting_unrelated_audio() {
    let directory=TestDirectory::new();let mut store=directory.open();let source=directory.audio();let asset=store.put_asset(&source,"audio/wav",0.01,24000,1).unwrap();
    let project=save(&mut store,&draft(),Value::Null).unwrap();store.put_take(&take(&project,&asset)).unwrap();
    let mut bytes=fs::read(&source).unwrap();bytes[50]=1;let other=directory.0.join("unrelated.wav");fs::write(&other,bytes).unwrap();let unrelated=store.put_asset(&other,"audio/wav",0.01,24000,1).unwrap();
    let mut reservation=store.reserve_assets().unwrap();let id=asset["id"].as_str().unwrap().to_owned();reservation.retain(&mut store,&[id.clone(),id]).unwrap();
    let path=PathBuf::from(asset["path"].as_str().unwrap());let unrelated_path=PathBuf::from(unrelated["path"].as_str().unwrap());
    for path in [&path,&unrelated_path] {OpenOptions::new().write(true).open(path).unwrap().set_times(fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::from_secs(1))).unwrap();}
    store.connection.execute("UPDATE speech_asset_access SET accessed_at='2000-01-01T00:00:00Z'",[]).unwrap();
    store.execute("deleteProject",&json!({"id":project["id"]})).unwrap();
    assert_eq!(store.clean_cache(0,Utc::now()).unwrap()["assets"],1);assert!(path.exists());assert!(!unrelated_path.exists());
    reservation.release(&mut store).unwrap();assert_eq!(store.clean_cache(0,Utc::now()).unwrap()["assets"],1);assert!(!path.exists());
    let mut invalid=store.reserve_assets().unwrap();assert!(invalid.retain(&mut store,&[asset["id"].as_str().unwrap().to_owned()]).unwrap_err().contains("expired"));invalid.release(&mut store).unwrap();
}

#[test]
fn changed_staged_audio_never_commits_and_its_unregistered_blob_can_be_reclaimed() {
    let directory=TestDirectory::new();let mut store=directory.open();let source=directory.audio();let original=fs::read(&source).unwrap();
    let mut reservation=store.reserve_assets().unwrap();let stage=StagedAsset::from_file(&reservation,&source,"audio/wav",0.01,24000,1,None).unwrap();let id=stage.id().to_owned();reservation.protect(&mut store,&[id]).unwrap();
    let temporary=fs::read_dir(store.root.join("blobs")).unwrap().map(Result::unwrap).find(|entry|entry.file_name().to_str().is_some_and(|name|name.starts_with(".stage-"))).unwrap().path();
    let mut changed=original.clone();changed[50]=1;fs::write(&temporary,changed).unwrap();OpenOptions::new().write(true).open(&temporary).unwrap().set_times(fs::FileTimes::new().set_modified(SystemTime::now()+Duration::from_secs(60))).unwrap();
    assert!(stage.publish(&reservation,None).is_err());reservation.release(&mut store).unwrap();assert_eq!(fs::read(&source).unwrap(),original);
    assert_eq!(store.connection.query_row("SELECT count(*) FROM assets",[],|row|row.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(store.clean_cache(0,Utc::now()+chrono::Duration::hours(1)).unwrap()["assets"],1);
}
