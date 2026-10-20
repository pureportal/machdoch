use super::*;

const SCAN_ENTRIES: usize = 128;

enum CacheFile {
    Blob(String),
    Stage(String),
    Analysis(String),
}

struct Candidate {
    path: PathBuf,
    scope: PathBuf,
    kind: CacheFile,
}

enum ScanStep {
    Candidate(Candidate),
    Skipped,
    Complete,
}

pub(super) struct OrphanScan {
    blobs: fs::ReadDir,
    shard: Option<(String,fs::ReadDir)>,
    analysis: Option<fs::ReadDir>,
    scanning_analysis: bool,
    retention_days: u64,
    completed_at: Option<DateTime<Utc>>,
}

fn hexadecimal(value: &str, length: usize) -> bool {
    value.len()==length && value.bytes().all(|byte|byte.is_ascii_hexdigit()&&!byte.is_ascii_uppercase())
}

fn directory(root: &Path, path: &Path) -> Result<Option<fs::ReadDir>,String> {
    let metadata=match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(cause) if cause.kind()==std::io::ErrorKind::NotFound => return Ok(None),
        Err(cause) => return Err(error(cause)),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() || !path.canonicalize().map_err(error)?.starts_with(root) {
        return Err("A speech cache directory is outside its storage scope or is not a directory. Repair the storage before cleaning.".into());
    }
    fs::read_dir(path).map(Some).map_err(error)
}

fn uuid_name(value: &str) -> bool {
    value.len()==36 && value.bytes().enumerate().all(|(index,byte)|if matches!(index,8|13|18|23) { byte==b'-' } else { byte.is_ascii_hexdigit()&&!byte.is_ascii_uppercase() })
}

fn stage_reservation(name: &str) -> Option<&str> {
    let body=name.strip_prefix(".stage-")?.strip_suffix(".part")?;
    let reservation=body.get(..36)?;
    let nonce=body.get(36..)?.strip_prefix('-')?;
    (uuid_name(reservation)&&uuid_name(nonce)).then_some(reservation)
}

fn analysis_asset(name: &str) -> Option<&str> {
    let (id,rest)=name.split_once('-')?;
    if !hexadecimal(id,64) { return None; }
    let (buckets,rest)=rest.split_once("-v3-")?;
    let count=buckets.parse::<usize>().ok()?;
    if !(1..=4096).contains(&count) || count.to_string()!=buckets { return None; }
    let (encoder,suffix)=rest.split_once('.')?;
    if !hexadecimal(encoder,64) { return None; }
    if suffix!="json" && !suffix.strip_suffix(".part").is_some_and(uuid_name) { return None; }
    Some(id)
}

impl OrphanScan {
    fn new(root: &Path, retention_days: u64) -> Result<Self,String> {
        let blobs=directory(root,&root.join("blobs"))?.ok_or("Speech blob storage is unavailable.")?;
        Ok(Self{blobs,shard:None,analysis:None,scanning_analysis:false,retention_days,completed_at:None})
    }

    fn next(&mut self, root: &Path) -> Result<ScanStep,String> {
        if let Some((shard,entries))=&mut self.shard {
            if let Some(entry)=entries.next() {
                let entry=entry.map_err(error)?;let name=entry.file_name();
                let Some(name)=name.to_str() else { return Ok(ScanStep::Skipped); };
                if hexadecimal(name,64) && name.starts_with(shard.as_str()) {
                    return Ok(ScanStep::Candidate(Candidate{path:entry.path(),scope:root.join("blobs"),kind:CacheFile::Blob(name.into())}));
                }
                return Ok(ScanStep::Skipped);
            }
            self.shard=None;
            return Ok(ScanStep::Skipped);
        }
        if !self.scanning_analysis {
            if let Some(entry)=self.blobs.next() {
                let entry=entry.map_err(error)?;let name=entry.file_name();
                let Some(name)=name.to_str() else { return Ok(ScanStep::Skipped); };
                if hexadecimal(name,2) {
                    let entries=directory(root,&entry.path())?.ok_or("A speech cache shard disappeared. Clean the cache again.")?;
                    self.shard=Some((name.into(),entries));
                } else if let Some(reservation)=stage_reservation(name) {
                    return Ok(ScanStep::Candidate(Candidate{path:entry.path(),scope:root.join("blobs"),kind:CacheFile::Stage(reservation.into())}));
                }
                return Ok(ScanStep::Skipped);
            }
            self.scanning_analysis=true;
            self.analysis=directory(root,&root.join("analysis"))?;
            return Ok(ScanStep::Skipped);
        }
        match self.analysis.as_mut().and_then(Iterator::next) {
            Some(entry) => {
                let entry=entry.map_err(error)?;let name=entry.file_name();
                let Some(id)=name.to_str().and_then(analysis_asset) else { return Ok(ScanStep::Skipped); };
                Ok(ScanStep::Candidate(Candidate{path:entry.path(),scope:root.join("analysis"),kind:CacheFile::Analysis(id.into())}))
            }
            None => Ok(ScanStep::Complete),
        }
    }
}

impl SpeechStore {
    pub(super) fn clean_orphan_files(&mut self, cutoff: &str, days: u64, now: DateTime<Utc>) -> Result<(u64,u64,bool),String> {
        let cutoff_time=parse_time(cutoff)?;
        let restart=self.orphan_scan.as_ref().is_none_or(|scan|scan.retention_days!=days || scan.completed_at.is_some_and(|completed|now.signed_duration_since(completed)>=chrono::Duration::minutes(30)));
        if restart { self.orphan_scan=Some(OrphanScan::new(&self.root,days)?); }
        if self.orphan_scan.as_ref().is_some_and(|scan|scan.completed_at.is_some()) { return Ok((0,0,false)); }
        let protected_blob=format!("SELECT EXISTS(SELECT 1 FROM speech_reserved_assets WHERE asset_id=?2) OR EXISTS(SELECT 1 FROM assets a WHERE a.id=?2 AND (NOT EXISTS(SELECT 1 FROM speech_cache_evictions e WHERE e.asset_id=a.id) OR ({})))",retention::ASSET_ROOTS);
        let mut assets=0u64;let mut bytes=0u64;
        for _ in 0..SCAN_ENTRIES {
            let candidate=match self.orphan_scan.as_mut().ok_or("The cache scan is unavailable.")?.next(&self.root)? {
                ScanStep::Skipped => continue,
                ScanStep::Complete => {if let Some(scan)=self.orphan_scan.as_mut() {scan.completed_at=Some(now);}return Ok((assets,bytes,false));}
                ScanStep::Candidate(candidate) => candidate,
            };
            let transaction=self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
            let retained:bool=match &candidate.kind {
                CacheFile::Blob(id) => transaction.query_row(&protected_blob,params![cutoff,id],|row|row.get(0)).map_err(error)?,
                CacheFile::Stage(id) => transaction.query_row("SELECT EXISTS(SELECT 1 FROM speech_asset_reservations WHERE id=?1)",[id],|row|row.get(0)).map_err(error)?,
                CacheFile::Analysis(id) => transaction.query_row("SELECT EXISTS(SELECT 1 FROM speech_reserved_assets WHERE asset_id=?1)",[id],|row|row.get(0)).map_err(error)?,
            };
            if retained { continue; }
            let metadata=match fs::symlink_metadata(&candidate.path) {
                Ok(value) => value,
                Err(cause) if cause.kind()==std::io::ErrorKind::NotFound => continue,
                Err(cause) => return Err(error(cause)),
            };
            if !metadata.is_file() || metadata.file_type().is_symlink() || !candidate.path.canonicalize().map_err(error)?.starts_with(candidate.scope.canonicalize().map_err(error)?) {
                return Err("A managed speech cache file leaves its storage scope or is not a regular file. Repair the storage before cleaning.".into());
            }
            let expired=match &candidate.kind {
                CacheFile::Blob(id) => transaction.query_row("SELECT EXISTS(SELECT 1 FROM speech_cache_evictions WHERE asset_id=?1)",[id],|row|row.get::<_,bool>(0)).map_err(error)?,
                _ => false,
            };
            if !expired && DateTime::<Utc>::from(metadata.modified().map_err(error)?)>=cutoff_time { continue; }
            fs::remove_file(&candidate.path).map_err(|_|"An expired speech working file could not be removed. Close its consumer and clean the cache again.")?;
            if let CacheFile::Blob(id)=&candidate.kind {
                transaction.execute("UPDATE speech_cache_evictions SET removed=1 WHERE asset_id=?1",[id]).map_err(error)?;
                assets+=1;
            }
            bytes=bytes.checked_add(metadata.len()).ok_or("The removed cache size overflowed.")?;
            transaction.commit().map_err(error)?;
        }
        Ok((assets,bytes,true))
    }
}
