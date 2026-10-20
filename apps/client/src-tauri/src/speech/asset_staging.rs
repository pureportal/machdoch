use super::*;
use std::collections::HashMap;
use std::time::SystemTime;
use tokio_util::sync::CancellationToken;

pub struct AssetReservation {
    root: PathBuf,
    id: String,
    expires: DateTime<Utc>,
    assets: HashMap<String, bool>,
    released: bool,
}

pub struct StagedAsset {
    temporary: TemporaryBlob,
    reservation_id: String,
    root: PathBuf,
    id: String,
    bytes: u64,
    mime: String,
    duration: f64,
    sample_rate: u32,
    channels: u16,
    modified: SystemTime,
}

pub struct PublishedAsset {
    stage: StagedAsset,
    canonical: PathBuf,
    modified: SystemTime,
}

pub fn schema(connection: &Connection) -> Result<(), String> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS speech_asset_reservations(id TEXT PRIMARY KEY,expires_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS speech_asset_reservation_expiry ON speech_asset_reservations(expires_at);
        CREATE TABLE IF NOT EXISTS speech_reserved_assets(reservation_id TEXT NOT NULL REFERENCES speech_asset_reservations(id) ON DELETE CASCADE,asset_id TEXT NOT NULL,PRIMARY KEY(reservation_id,asset_id));
        CREATE INDEX IF NOT EXISTS speech_reserved_asset_lookup ON speech_reserved_assets(asset_id,reservation_id);").map_err(error)
}

fn check_cancel(cancel: Option<&CancellationToken>) -> Result<(), String> {
    if cancel.is_some_and(CancellationToken::is_cancelled) { return Err("Speech cancelled.".into()); }
    Ok(())
}

impl AssetReservation {
    pub fn ensure_live(&self) -> Result<(), String> {
        if self.released || Utc::now() >= self.expires { return Err("The audio operation exceeded its working deadline. Start it again.".into()); }
        Ok(())
    }

    pub fn protect(&mut self, store: &mut SpeechStore, ids: &[String]) -> Result<(), String> {
        self.register_assets(store,ids,false)
    }

    pub fn retain(&mut self, store: &mut SpeechStore, ids: &[String]) -> Result<(), String> {
        self.register_assets(store,ids,true)
    }

    fn register_assets(&mut self, store: &mut SpeechStore, ids: &[String], require_available: bool) -> Result<(), String> {
        self.ensure_live()?;
        if ids.len()>MAX_ITEMS { return Err("Protect at most 10,000 audio assets at once.".into()); }
        let ids:HashSet<&str>=ids.iter().map(String::as_str).collect();
        if store.root != self.root || self.assets.len()+ids.iter().filter(|id|!self.assets.contains_key(**id)).count() > MAX_ITEMS {
            return Err("Keep staged audio within this store's asset limit.".into());
        }
        let transaction=store.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
        let live: bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM speech_asset_reservations WHERE id=?1 AND julianday(expires_at)>julianday(?2))",params![self.id,timestamp()],|row|row.get(0)).map_err(error)?;
        if !live { return Err("The audio import reservation expired. Restart the import deliberately.".into()); }
        let mut added=Vec::new();
        for id in ids {
            asset_identifier(&json!(id))?;
            if self.assets.contains_key(id) && !require_available { continue; }
            let eviction: Option<bool>=transaction.query_row("SELECT removed FROM speech_cache_evictions WHERE asset_id=?1",[id],|row|row.get(0)).optional().map_err(error)?;
            let existing: bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM assets WHERE id=?1)",[id],|row|row.get(0)).map_err(error)?;
            if require_available && (!existing || eviction.is_some()) { return Err("This source audio is unavailable or expired. Restore it before exporting or playing it.".into()); }
            if eviction == Some(false) {
                let protected: bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM speech_reserved_assets a JOIN speech_asset_reservations w ON w.id=a.reservation_id WHERE a.asset_id=?1 AND julianday(w.expires_at)>julianday(?2))",params![id,timestamp()],|row|row.get(0)).map_err(error)?;
                if protected { return Err("Another audio import is using this expiring asset. Finish it before importing the same audio.".into()); }
                let path=store.root.join("blobs").join(&id[..2]).join(id);
                match fs::symlink_metadata(&path) {
                    Ok(metadata) => {
                        if !metadata.is_file() || metadata.file_type().is_symlink() || !path.canonicalize().map_err(error)?.starts_with(store.root.join("blobs")) {
                            return Err("An expiring audio path leaves its blob store. Repair it before importing.".into());
                        }
                        fs::remove_file(path).map_err(error)?;
                    }
                    Err(cause) if cause.kind()==std::io::ErrorKind::NotFound => {}
                    Err(cause) => return Err(error(cause)),
                }
                transaction.execute("UPDATE speech_cache_evictions SET removed=1 WHERE asset_id=?1",[id]).map_err(error)?;
            }
            transaction.execute("INSERT INTO speech_reserved_assets VALUES(?1,?2) ON CONFLICT DO NOTHING",params![self.id,id]).map_err(error)?;
            added.push((id.to_owned(), existing && eviction.is_none()));
        }
        transaction.commit().map_err(error)?;
        self.assets.extend(added);
        Ok(())
    }

    pub fn release(&mut self, store: &mut SpeechStore) -> Result<(), String> {
        if store.root != self.root { return Err("Release audio reservations in their owning store.".into()); }
        store.connection.execute("DELETE FROM speech_asset_reservations WHERE id=?1",[&self.id]).map_err(error)?;
        self.released=true;
        Ok(())
    }
}

impl Drop for AssetReservation {
    fn drop(&mut self) {
        if self.released { return; }
        let released=(|| -> rusqlite::Result<()> {
            let connection=Connection::open(self.root.join("speech.sqlite3"))?;
            connection.busy_timeout(Duration::from_millis(100))?;
            connection.execute_batch("PRAGMA foreign_keys=ON;")?;
            connection.execute("DELETE FROM speech_asset_reservations WHERE id=?1",[&self.id])?;
            Ok(())
        })();
        if released.is_err() { eprintln!("Speech audio reservation cleanup failed; its bounded deadline remains recorded."); }
    }
}

impl StagedAsset {
    pub fn from_file(reservation: &AssetReservation, path: &Path, mime: &str, duration: f64, sample_rate: u32, channels: u16, cancel: Option<&CancellationToken>) -> Result<Self,String> {
        let mut source=File::open(path).map_err(error)?;
        let metadata=source.metadata().map_err(error)?;
        if !metadata.is_file() { return Err("Import a regular audio file.".into()); }
        Self::from_reader(reservation,&mut source,metadata.len(),mime,duration,sample_rate,channels,cancel)
    }

    pub fn from_reader(reservation: &AssetReservation, source: &mut impl Read, expected_bytes: u64, mime: &str, duration: f64, sample_rate: u32, channels: u16, cancel: Option<&CancellationToken>) -> Result<Self,String> {
        reservation.ensure_live()?;
        if expected_bytes==0 || expected_bytes>MAX_ASSET_BYTES { return Err("Audio must be nonempty and within the storage size limit.".into()); }
        if !matches!(mime,"audio/wav"|"audio/x-wav"|"audio/mpeg"|"audio/ogg"|"audio/opus"|"audio/flac"|"audio/mp4"|"audio/aac"|"audio/webm"|"audio/pcm") {
            return Err("Unsupported audio MIME type".into());
        }
        if !duration.is_finite() || duration<0.0 || !(8000..=384000).contains(&sample_rate) || !(1..=32).contains(&channels) {
            return Err("Invalid audio duration, sample rate, or channel count".into());
        }
        let blobs=reservation.root.join("blobs");scoped_directory(&reservation.root,&blobs)?;
        let available=crate::storage_space::available_storage_bytes(&blobs).ok_or("Free audio staging storage could not be measured.")?;
        if available<expected_bytes.saturating_add(64*1024*1024) { return Err("Free more speech storage before importing this audio.".into()); }
        let temporary=TemporaryBlob(blobs.join(format!(".stage-{}-{}.part",reservation.id,uuid()?)));
        let mut output=OpenOptions::new().create_new(true).write(true).open(&temporary.0).map_err(error)?;
        let mut digest=Sha256::new();let mut bytes=0u64;let mut buffer=[0u8;65536];
        loop {
            check_cancel(cancel)?;reservation.ensure_live()?;
            let length=source.read(&mut buffer).map_err(error)?;if length==0 { break; }
            bytes=bytes.checked_add(length as u64).filter(|value|*value<=expected_bytes).ok_or("Audio exceeded its declared byte length.")?;
            output.write_all(&buffer[..length]).map_err(error)?;digest.update(&buffer[..length]);
        }
        if bytes!=expected_bytes { return Err("Audio changed or was truncated during import.".into()); }
        output.sync_all().map_err(error)?;drop(output);
        if matches!(mime,"audio/wav"|"audio/x-wav") {
            let (actual_duration,actual_rate,actual_channels)=super::super::reference_audio::inspect_wav(&temporary.0)?;
            if actual_rate!=sample_rate || actual_channels!=channels || (actual_duration-duration).abs()>0.5/f64::from(sample_rate) {
                return Err("The staged audio metadata differs from its decoded samples.".into());
            }
        }
        let modified=fs::metadata(&temporary.0).and_then(|metadata|metadata.modified()).map_err(error)?;
        Ok(Self{temporary,reservation_id:reservation.id.clone(),root:reservation.root.clone(),id:format!("{:x}",digest.finalize()),bytes,mime:mime.into(),duration,sample_rate,channels,modified})
    }

    pub fn id(&self) -> &str { &self.id }

    pub fn publish(self, reservation: &AssetReservation, cancel: Option<&CancellationToken>) -> Result<PublishedAsset,String> {
        reservation.ensure_live()?;check_cancel(cancel)?;
        let requires_existing=*reservation.assets.get(&self.id).ok_or("Reserve this audio before publication.")?;
        if self.reservation_id!=reservation.id || self.root!=reservation.root { return Err("Publish staged audio only through its owning reservation.".into()); }
        let directory=self.root.join("blobs").join(&self.id[..2]);fs::create_dir_all(&directory).map_err(error)?;scoped_directory(&self.root,&directory)?;
        let destination=directory.join(&self.id);
        let verify=if requires_existing { true } else {
            match fs::hard_link(&self.temporary.0,&destination) {
                Ok(()) => false,
                Err(cause) if cause.kind()==std::io::ErrorKind::AlreadyExists => true,
                Err(cause) => return Err(error(cause)),
            }
        };
        let (mut file,canonical)=open_blob(&self.root,&destination,self.bytes)?;
        let initial_modified=file.metadata().and_then(|metadata|metadata.modified()).map_err(error)?;
        if !verify && initial_modified!=self.modified { return Err("Staged audio changed before publication. Reimport the original file.".into()); }
        if verify {
            let mut digest=Sha256::new();let mut bytes=0u64;let mut buffer=[0u8;65536];
            loop {
                check_cancel(cancel)?;reservation.ensure_live()?;
                let length=file.read(&mut buffer).map_err(error)?;if length==0 { break; }
                bytes=bytes.checked_add(length as u64).filter(|value|*value<=self.bytes).ok_or("Stored audio changed during verification.")?;digest.update(&buffer[..length]);
            }
            if bytes!=self.bytes || format!("{:x}",digest.finalize())!=self.id { return Err("Stored audio failed its SHA-256 integrity check. Restore it before importing again.".into()); }
        }
        let modified=file.metadata().and_then(|metadata|metadata.modified()).map_err(error)?;
        if modified!=initial_modified { return Err("Stored audio changed during verification. Restore it before importing again.".into()); }
        Ok(PublishedAsset{stage:self,canonical,modified})
    }
}

impl SpeechStore {
    pub fn reserve_assets(&mut self) -> Result<AssetReservation,String> {
        let id=uuid()?;let expires=Utc::now()+chrono::Duration::hours(24);
        let transaction=self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
        transaction.execute("DELETE FROM speech_asset_reservations WHERE julianday(expires_at)<=julianday(?1)",[timestamp()]).map_err(error)?;
        let count:i64=transaction.query_row("SELECT count(*) FROM speech_asset_reservations",[],|row|row.get(0)).map_err(error)?;
        if count>=64 { return Err("Wait for an active audio operation to finish before starting another.".into()); }
        transaction.execute("INSERT INTO speech_asset_reservations VALUES(?1,?2)",params![id,expires.to_rfc3339_opts(SecondsFormat::Millis,true)]).map_err(error)?;
        transaction.commit().map_err(error)?;
        Ok(AssetReservation{root:self.root.clone(),id,expires,assets:HashMap::new(),released:false})
    }

    pub fn commit_staged_asset(&mut self, reservation: &AssetReservation, published: &PublishedAsset) -> Result<Value,String> {
        reservation.ensure_live()?;
        let stage=&published.stage;
        if self.root!=stage.root || stage.reservation_id!=reservation.id { return Err("Commit audio only in its owning store.".into()); }
        let (file,canonical)=open_blob(&self.root,&published.canonical,stage.bytes)?;
        if canonical!=published.canonical || file.metadata().and_then(|metadata|metadata.modified()).map_err(error)?!=published.modified { return Err("Stored audio changed before publication. Restore it before importing again.".into()); }
        let transaction=self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
        let live:bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM speech_asset_reservations w JOIN speech_reserved_assets a ON a.reservation_id=w.id WHERE w.id=?1 AND a.asset_id=?2 AND julianday(w.expires_at)>julianday(?3))",params![reservation.id,stage.id,timestamp()],|row|row.get(0)).map_err(error)?;
        if !live { return Err("The audio publication reservation expired. Restart the import deliberately.".into()); }
        let previous:Option<(String,f64,u32,u16,String,i64)>=transaction.query_row("SELECT mime_type,duration,sample_rate,channels,sha256,bytes FROM assets WHERE id=?1",[&stage.id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?))).optional().map_err(error)?;
        if previous.is_some_and(|value|value!=(stage.mime.clone(),stage.duration,stage.sample_rate,stage.channels,stage.id.clone(),stage.bytes as i64)) { return Err("Identical audio already has different immutable metadata".into()); }
        transaction.execute("INSERT INTO assets(id,sha256,mime_type,bytes,duration,sample_rate,channels) VALUES(?1,?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO NOTHING",params![stage.id,stage.mime,stage.bytes as i64,stage.duration,stage.sample_rate,stage.channels]).map_err(error)?;
        transaction.execute("DELETE FROM speech_cache_evictions WHERE asset_id=?1",[&stage.id]).map_err(error)?;
        transaction.execute("INSERT INTO speech_asset_access VALUES(?1,?2) ON CONFLICT(asset_id) DO UPDATE SET accessed_at=excluded.accessed_at",params![stage.id,timestamp()]).map_err(error)?;
        transaction.commit().map_err(error)?;
        self.asset_metadata(&stage.id,&canonical)
    }
}
