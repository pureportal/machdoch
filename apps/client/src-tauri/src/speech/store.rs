use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const MAX_SOURCE_BYTES: usize = 4 * 1024 * 1024;
const MAX_ITEMS: usize = 10_000;
pub(super) const MAX_METADATA_BYTES: usize = 16 * 1024 * 1024;
const MAX_ASSET_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[path="asset_staging.rs"]
mod asset_staging;
pub use asset_staging::{AssetReservation, StagedAsset};

#[path = "portable_store.rs"]
mod portable;
#[path = "take_request.rs"]
mod take_request;
use take_request::validate_take_request;
#[path = "answer_save.rs"]
mod answer_save;
#[path = "retention.rs"]
mod retention;
#[path="orphan_cache.rs"]
mod orphan_cache;
#[path = "playback_leases.rs"]
mod playback_leases;
#[path = "archive_permissions.rs"]
pub(super) mod archive_permissions;
#[path = "project_delete.rs"]
mod project_delete;
#[path="project_copy.rs"]
mod project_copy;
#[path = "template_store.rs"]
mod template_store;
#[path="audition_reviews.rs"]
mod audition_reviews;
#[path="reading_bookmarks.rs"]
mod reading_bookmarks;
#[path="history_store.rs"]
mod history_store;
#[path="production_history.rs"]
mod production_history;
#[path="voice_observations.rs"]
mod voice_observations;
#[path="voice_favorites.rs"]
mod voice_favorites;
#[path="voice_mutations.rs"]
mod voice_mutations;
#[path="playback_metrics.rs"]
mod playback_metrics;
#[path="generation_metrics.rs"]
pub(crate) mod generation_metrics;
#[path="timing_store.rs"]
mod timing_store;
#[path="timing_admission.rs"]
mod timing_admission;
#[path="timing_portable.rs"]
mod timing_portable;
#[cfg(test)]
#[path="timing_store_tests.rs"]
mod timing_store_tests;

pub struct SpeechStore {
    pub connection: Connection,
    pub root: PathBuf,
    orphan_scan: Option<orphan_cache::OrphanScan>,
}

impl SpeechStore {
    pub fn open(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&root).map_err(error)?;
        let root = root.canonicalize().map_err(error)?;
        fs::create_dir_all(root.join("blobs")).map_err(error)?;
        scoped_directory(&root, &root.join("blobs"))?;
        let database = root.join("speech.sqlite3");
        if database.exists() && !database.canonicalize().map_err(error)?.starts_with(&root) {
            return Err("Speech database is outside the storage root".into());
        }
        let connection = Connection::open(database).map_err(error)?;
        connection.busy_timeout(Duration::from_secs(5)).map_err(error)?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             PRAGMA synchronous=FULL;
             BEGIN IMMEDIATE;
             CREATE TABLE IF NOT EXISTS speech_queue (
                 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                 paused INTEGER NOT NULL CHECK(paused IN (0,1))
             );
             INSERT INTO speech_queue(singleton,paused) VALUES(1,0) ON CONFLICT DO NOTHING;
             CREATE TABLE IF NOT EXISTS speech_events (
                 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                 owner TEXT NOT NULL, job_id TEXT NOT NULL,
                 data TEXT NOT NULL CHECK(json_valid(data))
             );
             CREATE TABLE IF NOT EXISTS speech_requests(job_id TEXT PRIMARY KEY REFERENCES jobs(id),snapshot TEXT NOT NULL CHECK(json_valid(snapshot)));
             CREATE TABLE IF NOT EXISTS speech_budget(job_id TEXT PRIMARY KEY REFERENCES jobs(id),scope TEXT NOT NULL,amount REAL NOT NULL);
             CREATE TABLE IF NOT EXISTS speech_references(asset_id TEXT PRIMARY KEY REFERENCES assets(id),transcript TEXT NOT NULL,rights TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS speech_recording_uploads(id TEXT PRIMARY KEY,owner TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
             CREATE TABLE IF NOT EXISTS speech_recording_claims(upload_id TEXT PRIMARY KEY REFERENCES speech_recording_uploads(id) ON DELETE CASCADE,token TEXT NOT NULL,expires_at TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS speech_reference_originals(asset_id TEXT NOT NULL REFERENCES assets(id),original_asset_id TEXT NOT NULL REFERENCES assets(id),PRIMARY KEY(asset_id,original_asset_id));
             CREATE TABLE IF NOT EXISTS speech_cache_evictions(asset_id TEXT PRIMARY KEY REFERENCES assets(id),evicted_at TEXT NOT NULL,removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN (0,1)));
             CREATE TABLE IF NOT EXISTS speech_asset_access(asset_id TEXT PRIMARY KEY REFERENCES assets(id),accessed_at TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS speech_design_candidates(id TEXT PRIMARY KEY,asset_id TEXT NOT NULL REFERENCES assets(id),metadata TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS speech_voice_observations(id TEXT PRIMARY KEY,data TEXT NOT NULL CHECK(json_valid(data)));
             CREATE TABLE IF NOT EXISTS speech_voice_favorites(id TEXT PRIMARY KEY);
             CREATE TABLE IF NOT EXISTS speech_exports(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,snapshot TEXT NOT NULL,created_at TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS speech_deleted_projects(id TEXT PRIMARY KEY,deleted_at TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS speech_audio_sources(asset_id TEXT PRIMARY KEY REFERENCES assets(id),data TEXT NOT NULL CHECK(json_valid(data)));
             CREATE TABLE IF NOT EXISTS speech_mixes(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),asset_id TEXT NOT NULL REFERENCES assets(id),data TEXT NOT NULL CHECK(json_valid(data)));
             CREATE TABLE IF NOT EXISTS profiles (
                 id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)),
                 deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))
             );
             CREATE TABLE IF NOT EXISTS dictionaries (
                 id TEXT PRIMARY KEY, revision TEXT NOT NULL,
                 data TEXT NOT NULL CHECK(json_valid(data))
             );
             CREATE TABLE IF NOT EXISTS dictionary_revisions (
                 dictionary_id TEXT NOT NULL REFERENCES dictionaries(id),
                 revision TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
                 PRIMARY KEY(dictionary_id, revision)
             );
             CREATE TABLE IF NOT EXISTS assets (
                 id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE,
                 mime_type TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes > 0),
                 duration REAL NOT NULL CHECK(duration >= 0),
                 sample_rate INTEGER NOT NULL CHECK(sample_rate > 0),
                 channels INTEGER NOT NULL CHECK(channels > 0)
             );
             CREATE TABLE IF NOT EXISTS projects (
                 id TEXT PRIMARY KEY, revision_id TEXT NOT NULL,
                 profile_id TEXT REFERENCES profiles(id), title TEXT NOT NULL,
                 archived INTEGER NOT NULL CHECK(archived IN (0,1)),
                 deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
                 updated_at TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
                 FOREIGN KEY(id, revision_id) REFERENCES revisions(project_id, id)
                    DEFERRABLE INITIALLY DEFERRED
             );
             CREATE TABLE IF NOT EXISTS revisions (
                 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id)
                    DEFERRABLE INITIALLY DEFERRED,
                 parent_id TEXT, created_at TEXT NOT NULL, source TEXT NOT NULL,
                 content_hash TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
                 UNIQUE(project_id, id),
                 FOREIGN KEY(project_id, parent_id) REFERENCES revisions(project_id, id)
             );
             CREATE TABLE IF NOT EXISTS revision_assets (
                 revision_id TEXT NOT NULL REFERENCES revisions(id),
                 asset_id TEXT NOT NULL REFERENCES assets(id),
                 PRIMARY KEY(revision_id, asset_id)
             );
             CREATE TABLE IF NOT EXISTS revision_profiles (
                 revision_id TEXT PRIMARY KEY REFERENCES revisions(id),
                 profile_id TEXT NOT NULL REFERENCES profiles(id),
                 data TEXT NOT NULL CHECK(json_valid(data))
             );
             CREATE TABLE IF NOT EXISTS revision_dictionaries (
                 revision_id TEXT NOT NULL REFERENCES revisions(id),
                 dictionary_id TEXT NOT NULL, dictionary_revision TEXT NOT NULL,
                 PRIMARY KEY(revision_id, dictionary_id),
                 FOREIGN KEY(dictionary_id, dictionary_revision)
                    REFERENCES dictionary_revisions(dictionary_id, revision)
             );
             CREATE TABLE IF NOT EXISTS jobs (
                 id TEXT PRIMARY KEY, owner TEXT NOT NULL,
                 project_id TEXT REFERENCES projects(id), revision_id TEXT NOT NULL,
                 state TEXT NOT NULL CHECK(state IN
                    ('queued','running','completed','cancelled','failed','uncertain','interrupted')),
                 parent_job_id TEXT REFERENCES jobs(id), created_at TEXT NOT NULL,
                 data TEXT NOT NULL CHECK(json_valid(data)),
                 FOREIGN KEY(project_id, revision_id) REFERENCES revisions(project_id, id)
             );
             CREATE TABLE IF NOT EXISTS takes (
                 id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id),
                 revision_id TEXT NOT NULL, asset_id TEXT NOT NULL REFERENCES assets(id),
                 parent_take_id TEXT REFERENCES takes(id), created_at TEXT NOT NULL,
                 data TEXT NOT NULL CHECK(json_valid(data)),
                 FOREIGN KEY(project_id, revision_id) REFERENCES revisions(project_id, id)
             );
             CREATE TABLE IF NOT EXISTS job_takes (
                 job_id TEXT NOT NULL REFERENCES jobs(id),
                 take_id TEXT NOT NULL REFERENCES takes(id),
                  PRIMARY KEY(job_id, take_id)
              );
             CREATE TABLE IF NOT EXISTS speech_dispatch_order (
                 job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL CHECK(ordinal>0)
             );
             CREATE TABLE IF NOT EXISTS take_requests (
                 take_id TEXT PRIMARY KEY REFERENCES takes(id) ON DELETE CASCADE,
                 data TEXT NOT NULL CHECK(json_valid(data))
             );
             CREATE TRIGGER IF NOT EXISTS take_requests_no_update BEFORE UPDATE ON take_requests
                 BEGIN SELECT RAISE(ABORT, 'Generation requests are immutable'); END;
             CREATE TABLE IF NOT EXISTS revision_takes (
                 revision_id TEXT NOT NULL REFERENCES revisions(id),
                 take_id TEXT NOT NULL REFERENCES takes(id),
                 PRIMARY KEY(revision_id, take_id)
             );
             CREATE INDEX IF NOT EXISTS projects_updated ON projects(deleted, updated_at);
             CREATE INDEX IF NOT EXISTS revisions_project ON revisions(project_id, created_at);
             CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(owner, created_at);
             CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project_id, created_at);
             CREATE INDEX IF NOT EXISTS takes_project ON takes(project_id, created_at);
             CREATE INDEX IF NOT EXISTS takes_project_id ON takes(project_id,id);
             CREATE INDEX IF NOT EXISTS takes_segment ON takes(json_extract(data,'$.segmentId'),created_at,id);
             CREATE TRIGGER IF NOT EXISTS revisions_no_update BEFORE UPDATE ON revisions
                 BEGIN SELECT RAISE(ABORT, 'Revisions are immutable'); END;
             CREATE TRIGGER IF NOT EXISTS revisions_no_delete BEFORE DELETE ON revisions
                 BEGIN SELECT RAISE(ABORT, 'Revisions are immutable'); END;
             CREATE TRIGGER IF NOT EXISTS assets_no_update BEFORE UPDATE ON assets
                 BEGIN SELECT RAISE(ABORT, 'Assets are immutable'); END;
             CREATE TRIGGER IF NOT EXISTS assets_no_delete BEFORE DELETE ON assets
                 BEGIN SELECT RAISE(ABORT, 'Asset references must be preserved'); END;
             CREATE TRIGGER IF NOT EXISTS dictionaries_no_revision_update
                 BEFORE UPDATE ON dictionary_revisions
                 BEGIN SELECT RAISE(ABORT, 'Dictionary revisions are immutable'); END;
             CREATE TRIGGER IF NOT EXISTS dictionaries_no_revision_delete
                 BEFORE DELETE ON dictionary_revisions
                 BEGIN SELECT RAISE(ABORT, 'Dictionary revisions are immutable'); END;
             CREATE TRIGGER IF NOT EXISTS takes_provenance BEFORE UPDATE ON takes
                 WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id
                   OR NEW.revision_id IS NOT OLD.revision_id OR NEW.asset_id IS NOT OLD.asset_id
                   OR NEW.parent_take_id IS NOT OLD.parent_take_id
                   OR NEW.created_at IS NOT OLD.created_at
                   OR json_remove(NEW.data,'$.favorite','$.rating','$.note')
                      IS NOT json_remove(OLD.data,'$.favorite','$.rating','$.note')
                 BEGIN SELECT RAISE(ABORT, 'Take provenance is immutable'); END;"
        ).map_err(error)?;
        template_store::init_schema(&connection)?;
        voice_mutations::schema(&connection)?;
        playback_metrics::schema(&connection)?;
        generation_metrics::schema(&connection)?;
        timing_store::schema(&connection)?;
        playback_leases::schema(&connection)?;
        asset_staging::schema(&connection)?;
        let mut store = Self { connection, root, orphan_scan:None };
        super::live_input::schema(&store)?;
        super::voice_workflow::schema(&store)?;
        retention::schema(&store.connection)?;
        store.connection.execute_batch("COMMIT;").map_err(error)?;
        store.recover_interrupted()?;
        Ok(store)
    }

    pub fn execute(&mut self, operation: &str, input: &Value) -> Result<Value, String> {
        match operation {
            "archiveReferences"=>{fields(input,&["projectId","revisionId"])?;let manifest=self.portable_snapshot(identifier(input,"projectId")?,identifier(input,"revisionId")?)?;archive_permissions::inventory(&manifest)},
            "retainPlayback" | "releasePlayback"=>playback_leases::execute(self,operation,input,Utc::now()),
            "getTiming"=>{fields(input,&["id"])?;self.timing(identifier(input,"id")?)},
            "listTimings"=>{
                fields(input,&["takeId"])?;let id=identifier(input,"takeId")?;let take=self.timing_take(id)?;
                let mut statement=self.connection.prepare("SELECT data FROM speech_timings WHERE take_id=?1 ORDER BY created_at DESC,id").map_err(error)?;
                let rows=statement.query_map([id],|row|row.get(0)).map_err(error)?;let records=collect_json(rows)?;
                for record in records.as_array().ok_or("The timing inventory is damaged.")?{timing_store::validate_record(record,&take)?;}
                Ok(records)
            },
            "resolveTimings"=>{fields(input,&["projectId","selections"])?;let mut project=self.project(identifier(input,"projectId")?)?;project["timingSelections"]=required(input,"selections")?.clone();self.project_timings(&project)},
            "findAnswerAudio"=>self.find_answer_audio(input),
            "listVoiceReviews"=>audition_reviews::list(self,input),
            "listTemplates" | "saveTemplate" | "deleteTemplate" => self.execute_template(operation,input),
            "cleanCache" => {
                fields(input, &["restart"])?;
                if boolean(input,"restart")? { self.orphan_scan=None; }
                let days = super::settings::raw_settings(self)?["cacheRetentionDays"].as_u64().ok_or("The cache retention setting is invalid.")?;
                self.clean_cache(days, Utc::now())
            }
            "saveAnswerAudio" => self.save_answer_audio(input),
            "queue" => {
                fields(input, &["paused"])?;
                if input.get("paused").is_some() {
                    let paused = boolean(input, "paused")?;
                    self.connection.execute("UPDATE speech_queue SET paused=?1 WHERE singleton=1", [paused]).map_err(error)?;
                }
                let paused: bool = self.connection.query_row("SELECT paused FROM speech_queue WHERE singleton=1", [], |row| row.get(0)).map_err(error)?;
                Ok(json!({"paused":paused}))
            },
            "listProjects"=>history_store::projects(self,input),
            "getProject" => {
                fields(input, &["id"])?;
                self.project(identifier(input, "id")?)
            }
            "duplicateProject" => self.duplicate_project(input),
            "saveProject" => {
                fields(input, &["project", "expectedRevisionId"])?;
                let expected = nullable_identifier(input, "expectedRevisionId")?;
                self.save_project(required(input, "project")?.clone(), expected)
            }
            "deleteProject" => {
                fields(input, &["id"])?;
                self.delete_project(identifier(input,"id")?)
            }
            "revisions"=>history_store::revisions(self,input),
            "getRevision"=>history_store::revision(self,input),
            "restoreRevision" => {
                fields(input, &["projectId", "revisionId", "expectedRevisionId"])?;
                let project_id = identifier(input, "projectId")?;
                let expected = identifier(input, "expectedRevisionId")?;
                let revision_id = identifier(input, "revisionId")?;
                self.project(project_id)?;
                let data: String = self.connection.query_row(
                    "SELECT data FROM revisions WHERE id=?1 AND project_id=?2",
                    params![revision_id, project_id], |row| row.get(0)
                ).optional().map_err(error)?.ok_or("Revision does not belong to this project")?;
                self.save_project(parse_json(data)?, Some(expected))
            }
            "listProfiles" => {
                fields(input, &[])?;
                self.list_data("SELECT data FROM profiles WHERE deleted=0 ORDER BY json_extract(data,'$.name'),id")
            }
            "saveProfile" => {
                fields(input, &["profile"])?;
                let profile = required(input, "profile")?;
                validate_profile(profile)?;
                super::contracts::validate_profile(profile)?;
                super::profile_binding::validate_defaults(self,profile)?;
                let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
                for id in array(profile, "dictionaryIds", 256)? {
                    exists(&transaction, "SELECT 1 FROM dictionaries WHERE id=?1", value_identifier(id)?)?;
                }
                transaction.execute(
                    "INSERT INTO profiles(id,data) VALUES(?1,?2)
                     ON CONFLICT(id) DO UPDATE SET data=excluded.data,deleted=0",
                    params![identifier(profile, "id")?, encode(profile)?]
                ).map_err(error)?;
                transaction.commit().map_err(error)?;
                Ok(profile.clone())
            }
            "deleteProfile" => {
                fields(input, &["id"])?;
                let id = identifier(input, "id")?;
                let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
                let used: bool = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM projects WHERE deleted=0 AND profile_id=?1)",
                    [id], |row| row.get(0)
                ).map_err(error)?;
                if used { return Err("Profile is used by a project; choose another profile first".into()); }
                if transaction.execute("UPDATE profiles SET deleted=1 WHERE id=?1 AND deleted=0", [id]).map_err(error)? == 0 {
                    return Err("Profile does not exist".into());
                }
                transaction.commit().map_err(error)?;
                Ok(Value::Null)
            }
            "listDictionaries" => {
                fields(input, &[])?;
                self.list_data("SELECT data FROM dictionaries ORDER BY json_extract(data,'$.name'),id")
            }
            "dictionaryRevisions" => super::dictionary_snapshots::list(self,input),
            "saveDictionary" => {
                fields(input, &["dictionary"])?;
                let dictionary = required(input, "dictionary")?;
                validate_dictionary(dictionary)?;
                let id = identifier(dictionary, "id")?;
                let revision = uuid()?;
                let mut saved = dictionary.clone();
                saved["revision"] = json!(revision);
                let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
                transaction.execute(
                    "INSERT INTO dictionaries(id,revision,data) VALUES(?1,?2,?3)
                     ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data",
                    params![id, revision, encode(&saved)?]
                ).map_err(error)?;
                transaction.execute(
                    "INSERT INTO dictionary_revisions(dictionary_id,revision,data) VALUES(?1,?2,?3)",
                    params![id, revision, encode(&saved)?]
                ).map_err(error)?;
                transaction.commit().map_err(error)?;
                Ok(saved)
            }
            "listJobs" => {
                fields(input, &["owner", "projectId", "id", "limit", "offset", "kinds", "states"])?;
                let owner = optional_text(input, "owner", 512)?;
                let project = optional_identifier(input, "projectId")?;
                let id=optional_identifier(input,"id")?;
                let kinds=if let Some(kinds)=input.get("kinds"){
                    let values=kinds.as_array().filter(|values|!values.is_empty()&&values.len()<=3).ok_or("Choose one to three speech job kinds.")?;
                    if values.iter().any(|kind|!matches!(kind.as_str(),Some("alignment"|"voice-design"|"voice-creation"))){return Err("Choose supported speech job kinds.".into());}Some(kinds.to_string())
                }else{None};
                let states=if let Some(states)=input.get("states") {
                    let values=states.as_array().filter(|values|!values.is_empty()&&values.len()<=7).ok_or("Choose one to seven speech job states.")?;
                    if values.iter().any(|state|!matches!(state.as_str(),Some("queued"|"running"|"completed"|"cancelled"|"failed"|"uncertain"|"interrupted"))){return Err("Choose supported speech job states.".into());}Some(states.to_string())
                }else{None};
                let (limit,offset)=query_page(input)?;
                let mut statement = self.connection.prepare(
                    "SELECT data FROM jobs WHERE (?1 IS NULL OR owner=?1)
                     AND (?2 IS NULL OR project_id=?2) AND (?3 IS NULL OR id=?3)
                     AND (?6 IS NULL OR json_extract(data,'$.kind') IN (SELECT value FROM json_each(?6)))
                     AND (?7 IS NULL OR state IN (SELECT value FROM json_each(?7))) ORDER BY created_at DESC,id LIMIT ?4 OFFSET ?5"
                ).map_err(error)?;
                let rows = statement.query_map(params![owner, project,id,limit,offset,kinds,states], |row| row.get(0)).map_err(error)?;
                collect_json(rows)
            }
            "listTakes" => {
                fields(input, &["projectId", "jobId", "limit", "offset"])?;
                let project = optional_identifier(input, "projectId")?;
                let job = optional_identifier(input, "jobId")?;
                let (limit,offset)=query_page(input)?;
                let mut statement = self.connection.prepare(
                    "SELECT data FROM takes WHERE (?1 IS NULL OR project_id=?1)
                     AND (?2 IS NULL OR EXISTS(SELECT 1 FROM job_takes
                          WHERE job_id=?2 AND take_id=takes.id)) ORDER BY created_at DESC,id LIMIT ?3 OFFSET ?4"
                ).map_err(error)?;
                let rows = statement.query_map(params![project, job,limit,offset], |row| row.get(0)).map_err(error)?;
                collect_json(rows)
            }
            "resolveTakes" => self.resolve_project_takes(input),
            "takeRequest" => {
                fields(input,&["id"])?;
                let id=identifier(input,"id")?;
                let data: String = self.connection.query_row("SELECT data FROM take_requests WHERE take_id=?1",[id],|row|row.get(0)).optional().map_err(error)?.ok_or("The generation request is unavailable for this take.")?;
                let request=parse_json(data)?;validate_take_request(&self.timing_take(id)?,&request)?;Ok(request)
            },
            "takeProvenance" => {let request=self.execute("takeRequest",input)?;let mut summary=super::take_provenance::summarize(&request)?;let take=self.timing_take(identifier(input,"id")?)?;if let Some(observations)=take.get("voiceObservations"){summary["voiceObservations"]=observations.clone();}Ok(summary)},
            "favoriteVoice"=>self.favorite_voice(input),
            "listFavoriteVoices"=>self.favorite_voices(input),
            "listVoiceMutations"=>self.list_voice_mutations(input),
            "recordPlaybackMetrics"=>self.record_playback_metrics(input,&timestamp()),
            "updateTake" => {
                fields(input, &["id", "favorite", "rating", "note"])?;
                let id = identifier(input, "id")?;
                let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
                let data: String = transaction.query_row("SELECT data FROM takes WHERE id=?1", [id], |row| row.get(0))
                    .optional().map_err(error)?.ok_or("Take does not exist")?;
                let mut take = parse_json(data)?;
                for key in ["favorite", "rating", "note"] {
                    if let Some(value) = input.get(key) { take[key] = value.clone(); }
                }
                validate_annotations(&take)?;
                transaction.execute("UPDATE takes SET data=?2 WHERE id=?1", params![id, encode(&take)?]).map_err(error)?;
                transaction.commit().map_err(error)?;
                Ok(take)
            }
            "asset" => {
                fields(input, &["id"])?;
                let id = asset_identifier(required(input, "id")?)?;
                self.asset_record(id)
            }
            _ => Err(format!("Unsupported speech store operation: {operation}")),
        }
    }

    fn project(&self, id: &str) -> Result<Value, String> {
        let data: String = self.connection.query_row(
            "SELECT data FROM projects WHERE id=?1 AND deleted=0", [id], |row| row.get(0)
        ).optional().map_err(error)?.ok_or("Project does not exist")?;
        parse_json(data)
    }

    fn list_data(&self, sql: &str) -> Result<Value, String> {
        let mut statement = self.connection.prepare(sql).map_err(error)?;
        let rows = statement.query_map([], |row| row.get(0)).map_err(error)?;
        collect_json(rows)
    }

    fn save_project(&mut self, project: Value, expected: Option<&str>) -> Result<Value, String> {
        self.save_project_with_take(project,expected,None)
    }

    pub(super) fn save_project_with_take(&mut self, mut project: Value, expected: Option<&str>, pending: Option<(&Value,&Value)>) -> Result<Value,String> {
        bounded_record(&project)?;
        self.pin_cast_voice_observations(&mut project)?;
        validate_project(&project)?;
        if let Some((take,request))=pending { self.validate_take_asset(take)?; validate_take_request(take,request)?; }
        let project_id = identifier(&project, "id")?.to_owned();
        let reference_assets = project_asset_ids(&project)?;
        let take_ids = project_take_ids(&project)?;
        for id in project_reference_ids(&project)? { self.asset_record(&id)?; }
        if let Some(tracks)=project["backgroundTracks"].as_array(){
            for track in tracks{
                let id=asset_identifier(required(track,"assetId")?)?;
                let duration:f64=self.connection.query_row("SELECT a.duration FROM assets a JOIN speech_audio_sources s ON s.asset_id=a.id WHERE a.id=?1",[id],|row|row.get(0)).optional().map_err(error)?.ok_or("Import this background audio before adding it to the timeline.")?;
                if track["out"].as_f64().is_none_or(|out|out>duration){return Err("Keep background trims within the imported audio duration.".into());}
            }
        }
        let revision = uuid()?;
        let now = timestamp();
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
        let deleted:bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM speech_deleted_projects WHERE id=?1)",[&project_id],|row|row.get(0)).map_err(error)?;
        if deleted{return Err("Project has been deleted. Save recovered edits as a new project.".into());}
        let previous: Option<(String, String, bool)> = transaction.query_row(
            "SELECT revision_id,data,deleted FROM projects WHERE id=?1", [&project_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        ).optional().map_err(error)?;
        match &previous {
            Some((head, _, false)) if expected == Some(head.as_str()) => {}
            None if expected.is_none() => {}
            Some((_, _, true)) => return Err("Project has been deleted".into()),
            _ => return Err("Revision conflict: reload the project before saving".into()),
        }
        if let Some((take,request))=pending {
            Self::put_take_in_transaction(&transaction,take)?;
            transaction.execute("INSERT INTO take_requests VALUES(?1,?2)",params![identifier(take,"id")?,encode(request)?]).map_err(error)?;
        }
        if let Some((_, data, _)) = &previous {
            project["createdAt"] = parse_json(data.clone())?["createdAt"].clone();
        } else {
            project["createdAt"] = json!(now);
        }
        project["revisionId"] = json!(revision);
        project["parentRevisionId"] = json!(expected);
        project["updatedAt"] = json!(now);
        let profile_id = nullable_identifier(&project, "profileId")?;
        if let Some(id) = profile_id {
            exists(&transaction, "SELECT 1 FROM profiles WHERE id=?1 AND deleted=0", id)?;
        }
        for id in &take_ids {
            let take_project: Option<String> = transaction.query_row(
                "SELECT project_id FROM takes WHERE id=?1", [id], |row| row.get(0)
            ).optional().map_err(error)?.ok_or("Timeline or selection references a missing take")?;
            if take_project.as_deref() != Some(project_id.as_str()) {
                return Err("Timeline or selection references a take from another project".into());
            }
        }
        for review in project["voiceAuditions"].as_array().into_iter().flatten(){
            let (take,request):(String,String)=transaction.query_row("SELECT t.data,r.data FROM takes t JOIN take_requests r ON r.take_id=t.id WHERE t.id=?1",[identifier(review,"takeId")?],|row|Ok((row.get(0)?,row.get(1)?))).map_err(error)?;
            audition_reviews::validate_evidence(review,&parse_json(take)?,&parse_json(request)?)?;
        }
        for bookmark in reading_bookmarks::records(&project)? {
            let data: String = transaction.query_row("SELECT data FROM takes WHERE id=?1", [identifier(bookmark,"takeId")?], |row| row.get(0)).map_err(error)?;
            reading_bookmarks::validate_evidence(bookmark, &parse_json(data)?, &project)?;
        }
        let mut timing_ids=Vec::new();
        for (take_id,timing_id) in timing_store::selection_ids(&project)?{
            let data:String=transaction.query_row("SELECT data FROM takes WHERE id=?1",[take_id],|row|row.get(0)).map_err(error)?;
            let record:String=transaction.query_row("SELECT data FROM speech_timings WHERE id=?1",[timing_id],|row|row.get(0)).optional().map_err(error)?.ok_or("Select an existing timing result before saving.")?;
            let record=parse_json(record)?;timing_store::validate_record(&record,&parse_json(data)?)?;
            if record["words"].as_array().is_none_or(Vec::is_empty){return Err("This transcript has no measured word timing to apply.".into());}
            timing_ids.push(timing_id.to_owned());
        }
        for clip in array(&project, "timeline", MAX_ITEMS)? {
            let take_data: String = transaction.query_row(
                "SELECT data FROM takes WHERE id=?1", [identifier(clip, "takeId")?], |row| row.get(0)
            ).map_err(error)?;
            let take = parse_json(take_data)?;
            if number(clip, "out", 0.0, f64::MAX)? > number(&take["asset"], "duration", 0.0, f64::MAX)? {
                return Err("Timeline clip exceeds its take duration".into());
            }
        }
        let data = encode(&project)?;
        let hash = digest(data.as_bytes());
        transaction.execute(
            "INSERT INTO projects(id,revision_id,profile_id,title,archived,updated_at,data)
             VALUES(?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(id) DO UPDATE SET revision_id=excluded.revision_id,
               profile_id=excluded.profile_id,title=excluded.title,archived=excluded.archived,
               updated_at=excluded.updated_at,data=excluded.data",
            params![project_id, revision, profile_id, text(&project, "title", 1, 1024)?,
                boolean(&project, "archived")?, now, data]
        ).map_err(error)?;
        transaction.execute(
            "INSERT INTO revisions(id,project_id,parent_id,created_at,source,content_hash,data)
             VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![revision, project_id, expected, now, text(&project, "source", 0, MAX_SOURCE_BYTES)?, hash, data]
        ).map_err(error)?;
        for id in reference_assets {
            transaction.execute("INSERT INTO revision_assets VALUES(?1,?2)", params![revision, id]).map_err(error)?;
        }
        for id in take_ids {
            transaction.execute("INSERT INTO revision_takes VALUES(?1,?2)", params![revision, id]).map_err(error)?;
        }
        for id in timing_ids{transaction.execute("INSERT INTO revision_timings VALUES(?1,?2)",params![revision,id]).map_err(error)?;}
        if let Some(id) = profile_id {
            let profile_data: String = transaction.query_row("SELECT data FROM profiles WHERE id=?1", [id], |row| row.get(0)).map_err(error)?;
            let profile = parse_json(profile_data.clone())?;
            transaction.execute("INSERT INTO revision_profiles VALUES(?1,?2,?3)", params![revision, id, profile_data]).map_err(error)?;
            for id in profile["referenceAssetIds"].as_array().into_iter().flatten(){transaction.execute("INSERT INTO revision_assets VALUES(?1,?2) ON CONFLICT DO NOTHING",params![revision,asset_identifier(id)?]).map_err(error)?;}
            for dictionary_id in array(&profile, "dictionaryIds", 256)? {
                transaction.execute(
                    "INSERT INTO revision_dictionaries
                     SELECT ?1,id,revision FROM dictionaries WHERE id=?2",
                    params![revision, value_identifier(dictionary_id)?]
                ).map_err(error)?;
            }
        }
        transaction.commit().map_err(error)?;
        Ok(project)
    }

    #[cfg(test)]
    pub fn put_job(&mut self, job: &Value) -> Result<(), String> {
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
        Self::put_job_in_transaction(&transaction, job)?;
        transaction.commit().map_err(error)
    }

    pub fn put_job_in_transaction(transaction: &rusqlite::Transaction<'_>, job: &Value) -> Result<(), String> {
        validate_job(job)?;
        let id = identifier(job, "id")?;
        validate_project_revision(&transaction, job)?;
        let previous: Option<String> = transaction.query_row("SELECT data FROM jobs WHERE id=?1", [id], |row| row.get(0))
            .optional().map_err(error)?;
        if let Some(data) = previous {
            let previous = parse_json(data)?;
            for key in ["id", "owner", "projectId", "revisionId", "totalSegments", "createdAt", "priority", "attempt", "parentJobId","kind"] {
                if previous[key] != job[key] { return Err(format!("Job provenance is immutable: {key}")); }
            }
            if !valid_transition(previous["state"].as_str().ok_or("Invalid stored job state")?, job["state"].as_str().ok_or("Invalid job state")?) {
                return Err("Job state cannot be replayed; create a new explicit job".into());
            }
            if job["completedSegments"].as_u64() < previous["completedSegments"].as_u64() {
                return Err("Completed segments cannot decrease".into());
            }
            if previous["cancelRequestedAt"].is_string()&&previous["cancelRequestedAt"]!=job["cancelRequestedAt"]{return Err("Speech cancellation was requested. The active worker must stop before updating this job.".into());}
            if !previous["timingId"].is_null()&&previous["timingId"]!=job["timingId"]{return Err("Committed job timing cannot be replaced.".into());}
            for take in array(&previous, "takeIds", MAX_ITEMS)? {
                if !array(job, "takeIds", MAX_ITEMS)?.contains(take) {
                    return Err("Persisted job takes cannot be removed".into());
                }
            }
            if parse_time(text(job, "updatedAt", 1, 128)?)? < parse_time(text(&previous, "updatedAt", 1, 128)?)? {
                return Err("Job update time cannot move backwards".into());
            }
        } else if !matches!(job["state"].as_str(), Some("queued" | "running")) {
            return Err("A new job must be queued or running".into());
        }
        if let Some(parent_id) = nullable_identifier(job, "parentJobId")? {
            if parent_id == id { return Err("Job cannot be its own parent".into()); }
            let data: String = transaction.query_row("SELECT data FROM jobs WHERE id=?1", [parent_id], |row| row.get(0))
                .optional().map_err(error)?.ok_or("Parent job does not exist")?;
            let parent = parse_json(data)?;
            for key in ["owner", "projectId"] {
                if parent[key] != job[key] { return Err("Parent job belongs to another owner or project".into()); }
            }
        }
        for take_id in array(job, "takeIds", MAX_ITEMS)? {
            let data: String = transaction.query_row("SELECT data FROM takes WHERE id=?1", [value_identifier(take_id)?], |row| row.get(0))
                .optional().map_err(error)?.ok_or("Job references a missing take")?;
            let take = parse_json(data)?;
            if take["projectId"] != job["projectId"] || take["revisionId"] != job["revisionId"] {
                return Err("Job references a take with different provenance".into());
            }
        }
        transaction.execute(
            "INSERT INTO jobs(id,owner,project_id,revision_id,state,parent_job_id,created_at,data)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data",
            params![id, text(job, "owner", 1, 512)?, nullable_identifier(job, "projectId")?,
                identifier(job, "revisionId")?, text(job, "state", 1, 32)?,
                nullable_identifier(job, "parentJobId")?, text(job, "createdAt", 1, 128)?, encode(job)?]
        ).map_err(error)?;
        for take_id in array(job, "takeIds", MAX_ITEMS)? {
            transaction.execute(
                "INSERT INTO job_takes(job_id,take_id) VALUES(?1,?2) ON CONFLICT DO NOTHING",
                params![id, value_identifier(take_id)?]
            ).map_err(error)?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn put_take(&mut self, take: &Value) -> Result<(), String> {
        self.validate_take_asset(take)?;
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
        Self::put_take_in_transaction(&transaction, take)?;
        transaction.commit().map_err(error)
    }

    pub fn put_completed_segment(&mut self, take: &Value, job: &Value, request: &Value) -> Result<(), String> {
        self.validate_take_asset(take)?;
        validate_take_request(take,request)?;
        if request.get("performanceNote").is_some(){
            let parent=self.execute("takeRequest",&json!({"id":identifier(take,"parentTakeId")?}))?;
            super::performance::validate_origin(request,&parent)?;
        }
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
        Self::put_take_in_transaction(&transaction, take)?;
        transaction.execute("INSERT INTO take_requests(take_id,data) VALUES(?1,?2)",params![identifier(take,"id")?,encode(request)?]).map_err(error)?;
        Self::put_job_in_transaction(&transaction, job)?;
        transaction.commit().map_err(error)
    }

    fn validate_take_asset(&self, take: &Value) -> Result<(), String> {
        validate_take(take)?;
        let asset_id = asset_identifier(required(&take["asset"], "id")?)?;
        if self.asset_record(asset_id)? != take["asset"] {
            return Err("Take asset metadata does not match the stored asset".into());
        }
        Ok(())
    }

    fn put_take_in_transaction(transaction: &rusqlite::Transaction<'_>, take: &Value) -> Result<(), String> {
        let asset_id = asset_identifier(required(&take["asset"], "id")?)?;
        let id = identifier(take, "id")?;
        validate_project_revision(&transaction, take)?;
        if let Some(reused_id) = nullable_identifier(take, "reusedFromTakeId")? {
            if reused_id == id { return Err("A cached take cannot reuse itself".into()); }
            let data: String = transaction.query_row("SELECT data FROM takes WHERE id=?1", [reused_id], |row| row.get(0))
                .optional().map_err(error)?.ok_or("The cached source take does not exist")?;
            let source = parse_json(data)?;
            for field in ["asset", "alignment", "requestHash", "backend", "model", "generatedAt", "providerResponse", "voiceObservations"] {
                if source[field] != take[field] { return Err(format!("Cached take provenance differs from its source: {field}")); }
            }
        }
        if let Some(parent_id) = nullable_identifier(take, "parentTakeId")? {
            if parent_id == id { return Err("Take cannot be its own parent".into()); }
            let data: String = transaction.query_row("SELECT data FROM takes WHERE id=?1", [parent_id], |row| row.get(0))
                .optional().map_err(error)?.ok_or("Parent take does not exist")?;
            let parent = parse_json(data)?;
            if parent["projectId"] != take["projectId"] || parent["segmentId"] != take["segmentId"] {
                return Err("Parent take has different project or segment provenance".into());
            }
        }
        let previous: Option<String> = transaction.query_row("SELECT data FROM takes WHERE id=?1", [id], |row| row.get(0))
            .optional().map_err(error)?;
        if let Some(data) = previous {
            if parse_json(data)? != *take { return Err("Take is immutable; update annotations through updateTake".into()); }
            return Ok(());
        }
        transaction.execute(
            "INSERT INTO takes(id,project_id,revision_id,asset_id,parent_take_id,created_at,data)
             VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![id, nullable_identifier(take, "projectId")?, identifier(take, "revisionId")?,
                asset_id, nullable_identifier(take, "parentTakeId")?,
                text(take, "createdAt", 1, 128)?, encode(take)?]
        ).map_err(error)?;
        Ok(())
    }

    pub fn recover_interrupted(&mut self) -> Result<(), String> {
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
        let jobs: Vec<(String, String)> = {
            let mut statement = transaction.prepare("SELECT id,data FROM jobs WHERE state='running' OR state='queued' AND id IN(SELECT job_id FROM speech_live_inputs)").map_err(error)?;
            let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).map_err(error)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(error)?
        };
        let now = timestamp();
        for (id, data) in jobs {
            let mut job = parse_json(data)?;
            let queued=job["state"]=="queued";
            let committed_voice=matches!(job["kind"].as_str(),Some("voice-design"|"voice-creation"))&&job["completedSegments"]==1&&transaction.query_row("SELECT EXISTS(SELECT 1 FROM speech_voice_workflow_results WHERE job_id=?1)",[&id],|row|row.get::<_,bool>(0)).map_err(error)?;
            job["state"] = json!(if committed_voice{"completed"}else if queued{"interrupted"}else{"uncertain"});
            job["updatedAt"] = json!(now);
            job["error"] = if committed_voice{Value::Null}else{json!(if queued{"Application stopped before live dispatch. Replay the completed answer deliberately."}else{"Application stopped during generation. The provider may have billed this request; explicitly start a new job to retry."})};
            if committed_voice{super::job_usage::settle(&transaction,&mut job,false)?;}
            transaction.execute("UPDATE jobs SET state=?3,data=?2 WHERE id=?1", params![id, encode(&job)?,job["state"].as_str()]).map_err(error)?;
            generation_metrics::finish(&transaction,&id,job["state"].as_str().ok_or("The recovered job state is missing.")?,&now)?;
            if queued{transaction.execute("DELETE FROM speech_budget WHERE job_id=?1",[&id]).map_err(error)?;}
        }
        transaction.commit().map_err(error)
    }

    pub fn put_asset(&mut self, path: &Path, mime: &str, duration: f64, sample_rate: u32, channels: u16) -> Result<Value, String> {
        let mut reservation=self.reserve_assets()?;
        let stage=StagedAsset::from_file(&reservation,path,mime,duration,sample_rate,channels,None)?;
        reservation.protect(self,&[stage.id().to_owned()])?;
        let published=stage.publish(&reservation,None)?;
        let asset=self.commit_staged_asset(&reservation,&published)?;
        reservation.release(self)?;
        Ok(asset)
    }

    pub fn asset_reader(&self,id:&str)->Result<(File,Value),String>{
        asset_identifier(&json!(id))?;
        let expired:bool=self.connection.query_row("SELECT EXISTS(SELECT 1 FROM speech_cache_evictions WHERE asset_id=?1)",[id],|row|row.get(0)).map_err(error)?;
        if expired{return Err("This temporary speech audio expired. Open a saved project take before exporting.".into());}
        let (hash,bytes):(String,i64)=self.connection.query_row("SELECT sha256,bytes FROM assets WHERE id=?1",[id],|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(error)?.ok_or("Asset does not exist")?;
        if hash!=id{return Err("Asset metadata failed its integrity check".into());}
        let (file,canonical)=open_blob(&self.root,&self.root.join("blobs").join(&id[..2]).join(id),u64::try_from(bytes).map_err(|_|"Asset byte count is invalid")?)?;
        self.connection.execute("INSERT INTO speech_asset_access VALUES(?1,?2) ON CONFLICT(asset_id) DO UPDATE SET accessed_at=excluded.accessed_at",params![id,timestamp()]).map_err(error)?;
        Ok((file,self.asset_metadata(id,&canonical)?))
    }

    pub fn asset_record(&self,id:&str)->Result<Value,String>{
        self.asset_reader(id).map(|(_,asset)|asset)
    }

    pub fn asset_path(&self, id: &str) -> Result<PathBuf, String> {
        asset_identifier(&json!(id))?;
        let expired: bool = self.connection.query_row("SELECT EXISTS(SELECT 1 FROM speech_cache_evictions WHERE asset_id=?1)", [id], |row| row.get(0)).map_err(error)?;
        if expired { return Err("This temporary speech audio expired. Generate it again or open a saved project take.".into()); }
        let (sha256, bytes): (String, i64) = self.connection.query_row(
            "SELECT sha256,bytes FROM assets WHERE id=?1", [id], |row| Ok((row.get(0)?, row.get(1)?))
        ).optional().map_err(error)?.ok_or("Asset does not exist")?;
        if sha256 != id { return Err("Asset metadata failed its integrity check".into()); }
        let path = self.root.join("blobs").join(&id[..2]).join(id);
        let path = verify_blob(&self.root, &path, id, u64::try_from(bytes).map_err(|_| "Asset byte count is invalid")?)?;
        self.connection.execute("INSERT INTO speech_asset_access VALUES(?1,?2) ON CONFLICT(asset_id) DO UPDATE SET accessed_at=excluded.accessed_at", params![id,timestamp()]).map_err(error)?;
        Ok(path)
    }

    fn asset_metadata(&self, id: &str, path: &Path) -> Result<Value, String> {
        let path = path.to_str().ok_or("Asset path is not valid UTF-8")?;
        self.connection.query_row(
            "SELECT sha256,mime_type,bytes,duration,sample_rate,channels FROM assets WHERE id=?1",
            [id], |row| Ok(json!({
                "id": id, "sha256": row.get::<_, String>(0)?, "mimeType": row.get::<_, String>(1)?,
                "bytes": row.get::<_, i64>(2)?, "duration": row.get::<_, f64>(3)?,
                "sampleRate": row.get::<_, u32>(4)?, "channels": row.get::<_, u16>(5)?, "path": path
            }))
        ).optional().map_err(error)?.ok_or_else(|| "Asset does not exist".into())
    }
}

fn validate_project(project: &Value) -> Result<(), String> {
    bounded_record(project)?;
    fields(project, &["id", "title", "source", "cast", "profileId", "revisionId", "parentRevisionId",
        "createdAt", "updatedAt", "archived", "location", "timeline", "selectedTakes", "bookmarks", "variants", "answerOrigin", "backgroundTracks", "exportSettings", "voiceAuditions", "timingSelections", "readingBookmarks"])?;
    audition_reviews::validate_records(project)?;
    reading_bookmarks::validate(project)?;
    timing_store::selection_ids(project)?;
    if let Some(origin) = project.get("answerOrigin") {
        fields(origin,&["sessionId","answerId","revision"])?;
        for key in ["sessionId","answerId","revision"] { text(origin,key,1,512)?; }
    }
    identifier(project, "id")?;
    let title = text(project, "title", 1, 1024)?;
    if title.trim().is_empty() { return Err("Project title is required".into()); }
    text(project, "source", 0, MAX_SOURCE_BYTES)?;
    let revision = text(project, "revisionId", 0, 128)?;
    if !revision.is_empty() { validate_id(revision)?; }
    nullable_identifier(project, "parentRevisionId")?;
    for key in ["createdAt", "updatedAt"] {
        let value = text(project, key, 0, 128)?;
        if !value.is_empty() { parse_time(value)?; }
    }
    boolean(project, "archived")?;
    nullable_text(project, "location", 32_768)?;
    nullable_identifier(project, "profileId")?;
    if let Some(settings)=project.get("exportSettings"){validate_export_preset(settings)?;}
    if let Some(tracks)=project.get("backgroundTracks"){
        let tracks=tracks.as_array().filter(|tracks|tracks.len()<=MAX_ITEMS).ok_or("Keep background tracks within the local clip limit.")?;
        let mut background_ids=HashSet::new();
        for track in tracks{
            fields(track,&["id","assetId","name","role","ducking","start","in","out","gain","fadeIn","fadeOut","track"])?;
            unique(&mut background_ids,identifier(track,"id")?)?;
            asset_identifier(required(track,"assetId")?)?;
            text(track,"name",1,1024)?;
            if !matches!(text(track,"role",1,16)?,"music"|"sfx"){return Err("Choose music or sound effects for the background track.".into());}
            validate_clip_timing(track)?;
            if !track["ducking"].is_null(){validate_ducking(&track["ducking"])?;}
        }
    }
    let mut ids = HashSet::new();
    for member in array(project, "cast", 64)? {
        fields(member, &["id", "name", "voiceId", "referenceAssetIds", "direction", "rightsEvidence", "sceneOverrides", "voiceObservation"])?;
        voice_observations::validate_binding(member)?;
        unique(&mut ids, identifier(member, "id")?)?;
        text(member, "name", 1, 1024)?;
        optional_text(member, "voiceId", 512)?;
        text(member, "direction", 0, 32_768)?;
        optional_text(member, "rightsEvidence", 32_768)?;
        let mut assets = HashSet::new();
        for asset in array(member, "referenceAssetIds", 256)? {
            unique(&mut assets, asset_identifier(asset)?)?;
        }
        if let Some(overrides)=member.get("sceneOverrides"){
            let overrides=overrides.as_array().filter(|values|values.len()<=MAX_ITEMS).ok_or("Keep cast overrides within the local scope limit.")?;
            let mut scopes=HashSet::new();
            for binding in overrides{
                fields(binding,&["sceneId","voiceId","referenceAssetIds","direction","rightsEvidence","voiceObservation"])?;
                voice_observations::validate_binding(binding)?;
                unique(&mut scopes,identifier(binding,"sceneId")?)?;
                let voice=optional_text(binding,"voiceId",512)?;
                text(binding,"direction",0,32_768)?;
                optional_text(binding,"rightsEvidence",32_768)?;
                let references=array(binding,"referenceAssetIds",256)?;
                if voice.is_some_and(|voice|!voice.is_empty())&&!references.is_empty(){return Err("Choose a voice ID or a reference set for each cast override.".into());}
                assets.clear();
                for asset in references{unique(&mut assets,asset_identifier(asset)?)?;}
            }
        }
    }
    ids.clear();
    for clip in array(project, "timeline", MAX_ITEMS)? {
        fields(clip, &["id", "takeId", "start", "in", "out", "gain", "fadeIn", "fadeOut", "track"])?;
        unique(&mut ids, identifier(clip, "id")?)?;
        identifier(clip, "takeId")?;
        validate_clip_timing(clip)?;
    }
    let selections = required(project, "selectedTakes")?.as_object().ok_or("selectedTakes must be an object")?;
    if selections.len() > MAX_ITEMS { return Err("Too many selected takes".into()); }
    for (segment, take) in selections { validate_id(segment)?; value_identifier(take)?; }
    ids.clear();
    for bookmark in array(project, "bookmarks", MAX_ITEMS)? {
        fields(bookmark, &["id", "label", "offset"])?;
        unique(&mut ids, identifier(bookmark, "id")?)?;
        text(bookmark, "label", 0, 4096)?;
        number(bookmark, "offset", 0.0, f64::MAX)?;
    }
    ids.clear();
    for variant in array(project, "variants", 256)? {
        fields(variant, &["id", "language", "source"])?;
        unique(&mut ids, identifier(variant, "id")?)?;
        text(variant, "language", 1, 128)?;
        text(variant, "source", 0, MAX_SOURCE_BYTES)?;
    }
    Ok(())
}

fn project_reference_ids(project: &Value) -> Result<HashSet<String>, String> {
    let mut ids = HashSet::new();
    for member in array(project, "cast", 64)? {
        for asset in array(member, "referenceAssetIds", 256)? {
            ids.insert(asset_identifier(asset)?.to_owned());
        }
        if let Some(overrides)=member["sceneOverrides"].as_array(){for binding in overrides{for asset in array(binding,"referenceAssetIds",256)?{ids.insert(asset_identifier(asset)?.to_owned());}}}
    }
    Ok(ids)
}

fn project_asset_ids(project:&Value)->Result<HashSet<String>,String>{
    let mut ids=project_reference_ids(project)?;
    if let Some(tracks)=project["backgroundTracks"].as_array(){for track in tracks{ids.insert(asset_identifier(required(track,"assetId")?)?.to_owned());}}
    Ok(ids)
}

fn validate_clip_timing(clip:&Value)->Result<(),String>{
    number(clip,"start",0.0,7.0*24.0*3600.0)?;
    let from=number(clip,"in",0.0,f64::MAX)?;
    let to=number(clip,"out",from,f64::MAX)?;
    if to<=from{return Err("Trim out must follow trim in.".into());}
    number(clip,"gain",0.0,16.0)?;
    let fade_in=number(clip,"fadeIn",0.0,to-from)?;
    let fade_out=number(clip,"fadeOut",0.0,to-from)?;
    if fade_in+fade_out>to-from{return Err("Timeline fades exceed the clip duration.".into());}
    unsigned(clip,"track",1023)?;
    Ok(())
}

fn validate_ducking(value:&Value)->Result<(),String>{
    fields(value,&["thresholdDbfs","reductionDb","attackMs","releaseMs"])?;
    number(value,"thresholdDbfs",-80.0,0.0)?;
    number(value,"reductionDb",-60.0,0.0)?;
    number(value,"attackMs",1.0,2000.0)?;
    number(value,"releaseMs",1.0,10000.0)?;
    Ok(())
}

pub(super) fn validate_export_preset(value:&Value)->Result<(),String>{
    fields(value,&["format","sampleRate","channels","bitrate","loudnessLufs","truePeakDb"])?;
    for key in ["format","sampleRate","channels","bitrate","loudnessLufs","truePeakDb"]{required(value,key)?;}
    if !matches!(text(value,"format",1,16)?,"wav"|"mp3"|"opus"|"flac"|"m4b"|"srt"|"vtt"|"txt"|"json"|"archive"){return Err("Choose a supported export format.".into());}
    let rate=unsigned(value,"sampleRate",192_000)?;
    if rate<8000{return Err("Use a sample rate from 8,000 to 192,000 Hz.".into());}
    if !(1..=2).contains(&unsigned(value,"channels",2)?){return Err("Use one or two export channels.".into());}
    let bitrate=unsigned(value,"bitrate",512_000)?;
    if matches!(value["format"].as_str(),Some("mp3"|"opus"|"m4b"))&&bitrate<16_000{return Err("Use an export bitrate from 16,000 to 512,000 bits per second.".into());}
    if value["loudnessLufs"].is_null()!=value["truePeakDb"].is_null(){return Err("Set both target loudness and true peak, or leave both unset.".into());}
    if !value["loudnessLufs"].is_null(){number(value,"loudnessLufs",-70.0,-5.0)?;number(value,"truePeakDb",-9.0,0.0)?;}
    Ok(())
}

fn project_take_ids(project: &Value) -> Result<HashSet<String>, String> {
    let mut ids = HashSet::new();
    for (take,_) in timing_store::selection_ids(project)?{ids.insert(take.to_owned());}
    for review in project["voiceAuditions"].as_array().into_iter().flatten(){ids.insert(identifier(review,"takeId")?.to_owned());}
    for bookmark in reading_bookmarks::records(project)? { ids.insert(identifier(bookmark,"takeId")?.to_owned()); }
    for clip in array(project, "timeline", MAX_ITEMS)? { ids.insert(identifier(clip, "takeId")?.to_owned()); }
    for take in required(project, "selectedTakes")?.as_object().ok_or("selectedTakes must be an object")?.values() {
        ids.insert(value_identifier(take)?.to_owned());
    }
    Ok(ids)
}

pub(super) fn validate_profile(profile: &Value) -> Result<(), String> {
    bounded_record(profile)?;
    fields(profile, &["id", "name", "backend", "model", "voiceId", "language", "direction", "temperature",
        "topP", "chunkLength", "minChunkLength", "latency", "dictionaryIds", "playbackRate", "normalize", "referenceAssetIds"])?;
    identifier(profile, "id")?;
    text(profile, "name", 1, 1024)?;
    backend(profile)?;
    text(profile, "model", 1, 512)?;
    let voice=optional_text(profile, "voiceId", 256)?;
    if profile.get("referenceAssetIds").is_some(){
        let references=array(profile,"referenceAssetIds",256)?;let mut ids=HashSet::new();for id in references{unique(&mut ids,asset_identifier(id)?)?;}
        if !references.is_empty()&&(voice.is_some_and(|voice|!voice.is_empty())||!matches!(profile["backend"].as_str(),Some("fish-cloud"|"sglang"|"drama3"))){return Err("Choose a default voice ID or reference recordings for a Drama 3 profile.".into());}
    }
    optional_text(profile, "language", 128)?;
    if let Some(normalize) = profile.get("normalize") { if !normalize.is_boolean() { return Err("Choose whether text normalization is enabled.".into()); } }
    text(profile, "direction", 0, 32_768)?;
    number(profile, "temperature", 0.0, 2.0)?;
    number(profile, "topP", 0.0, 1.0)?;
    let chunk = unsigned(profile, "chunkLength", 1_000_000)?;
    let minimum = unsigned(profile, "minChunkLength", 1_000_000)?;
    if chunk == 0 || minimum > chunk { return Err("Invalid profile chunk lengths".into()); }
    if !matches!(text(profile, "latency", 1, 16)?, "normal" | "balanced" | "low") {
        return Err("Invalid profile latency".into());
    }
    number(profile, "playbackRate", 0.25, 4.0)?;
    let mut ids = HashSet::new();
    for id in array(profile, "dictionaryIds", 256)? { unique(&mut ids, value_identifier(id)?)?; }
    Ok(())
}

fn validate_dictionary(dictionary: &Value) -> Result<(), String> {
    bounded_record(dictionary)?;
    fields(dictionary, &["id", "name", "revision", "rules"])?;
    super::dictionary_snapshots::validate_rules(dictionary)?;
    identifier(dictionary, "id")?;
    text(dictionary, "name", 1, 1024)?;
    text(dictionary, "revision", 0, 128)?;
    let mut ids = HashSet::new();
    for rule in array(dictionary, "rules", MAX_ITEMS)? {
        fields(rule, &["id", "text", "phonemes", "alphabet", "caseSensitive"])?;
        unique(&mut ids, identifier(rule, "id")?)?;
        text(rule, "text", 1, 16_384)?;
        text(rule, "phonemes", 1, 16_384)?;
        boolean(rule, "caseSensitive")?;
        if !matches!(text(rule, "alphabet", 1, 16)?, "arpabet" | "pinyin" | "romaji") {
            return Err("Invalid dictionary alphabet".into());
        }
    }
    Ok(())
}

fn validate_job(job: &Value) -> Result<(), String> {
    bounded_record(job)?;
    fields(job, &["id", "owner", "projectId", "revisionId", "state", "completedSegments", "totalSegments",
        "takeIds", "error", "createdAt", "updatedAt", "priority", "attempt", "parentJobId", "kind", "timingId", "cancelRequestedAt", "usage"])?;
    identifier(job, "id")?;
    text(job, "owner", 1, 512)?;
    nullable_identifier(job, "projectId")?;
    identifier(job, "revisionId")?;
    nullable_identifier(job, "parentJobId")?;
    let state = text(job, "state", 1, 32)?;
    if !matches!(state, "queued" | "running" | "completed" | "cancelled" | "failed" | "uncertain" | "interrupted") {
        return Err("Invalid job state".into());
    }
    let completed = unsigned(job, "completedSegments", MAX_ITEMS as u64)?;
    let total = unsigned(job, "totalSegments", MAX_ITEMS as u64)?;
    if total == 0 || completed > total || (state == "completed" && completed != total) {
        return Err("Invalid job segment counts".into());
    }
    if let Some(kind)=job.get("kind"){if !matches!(kind.as_str(),Some("alignment"|"voice-design"|"voice-creation")){return Err("Unknown speech job kind.".into());}}
    if let Some(id)=job.get("timingId"){if !id.is_null(){value_identifier(id)?;if job["kind"]!="alignment"{return Err("Only transcription jobs produce timing results.".into());}}}
    let priority = required(job, "priority")?.as_i64().ok_or("priority must be an integer")?;
    if !(i32::MIN as i64..=i32::MAX as i64).contains(&priority) { return Err("Invalid job priority".into()); }
    unsigned(job, "attempt", u32::MAX as u64)?;
    nullable_text(job, "error", 65_536)?;
    let created = parse_time(text(job, "createdAt", 1, 128)?)?;
    let updated = parse_time(text(job, "updatedAt", 1, 128)?)?;
    if updated < created { return Err("Job update time precedes creation".into()); }
    if let Some(cancelled)=job.get("cancelRequestedAt"){let at=parse_time(cancelled.as_str().ok_or("Record a valid cancellation request time.")?)?;if at<created||at>updated{return Err("The cancellation request time is outside the job lifetime.".into());}}
    if let Some(usage)=job.get("usage"){super::job_usage::validate(usage)?;}
    let mut ids = HashSet::new();
    for id in array(job, "takeIds", MAX_ITEMS)? { unique(&mut ids, value_identifier(id)?)?; }
    if job["kind"]=="alignment"&&(ids.len()!=1||state=="completed"&&job["timingId"].is_null()){return Err("A transcription job must retain its source take and completed timing result.".into());}
    if matches!(job["kind"].as_str(),Some("voice-design"|"voice-creation"))&&(total!=1||!ids.is_empty()||!job["projectId"].is_null()){return Err("Voice design and creation use one durable request without production takes.".into());}
    Ok(())
}

fn validate_take(take: &Value) -> Result<(), String> {
    bounded_record(take)?;
    voice_observations::validate_take(take)?;
    if let Some(evidence)=take.get("providerResponse"){super::provider_response::validate(evidence,take["backend"].as_str().ok_or("The take provider is missing.")?)?;}
    fields(take, &["id", "projectId", "revisionId", "segmentId", "asset", "createdAt", "generatedAt", "reusedFromTakeId", "backend", "model",
        "requestHash", "parentTakeId", "favorite", "rating", "note", "alignment", "spokenText", "chapter", "providerResponse", "voiceObservations"])?;
    text(take, "spokenText", 1, 2*1024*1024)?;
    let chapter = required(take, "chapter")?;
    if !chapter.is_null() { fields(chapter, &["id", "title"])?; identifier(chapter, "id")?; text(chapter, "title", 0, 4096)?; }
    identifier(take, "id")?;
    nullable_identifier(take, "projectId")?;
    identifier(take, "revisionId")?;
    identifier(take, "segmentId")?;
    nullable_identifier(take, "parentTakeId")?;
    nullable_identifier(take, "reusedFromTakeId")?;
    if parse_time(text(take, "generatedAt", 1, 128)?)? > parse_time(text(take, "createdAt", 1, 128)?)? {
        return Err("Generation time cannot be later than take creation".into());
    }
    backend(take)?;
    text(take, "model", 1, 512)?;
    asset_identifier(required(take, "requestHash")?)?;
    validate_annotations(take)?;
    let asset = required(take, "asset")?;
    fields(asset, &["id", "sha256", "mimeType", "bytes", "duration", "sampleRate", "channels", "path"])?;
    asset_identifier(required(asset, "id")?)?;
    asset_identifier(required(asset, "sha256")?)?;
    text(asset, "mimeType", 1, 128)?;
    unsigned(asset, "bytes", MAX_ASSET_BYTES)?;
    unsigned(asset, "sampleRate", 384_000)?;
    unsigned(asset, "channels", 32)?;
    text(asset, "path", 1, 32_768)?;
    let duration = number(asset, "duration", 0.0, f64::MAX)?;
    let mut previous_start = 0.0;
    for entry in array(take, "alignment", 100_000)? {
        fields(entry, &["text", "start", "end"])?;
        text(entry, "text", 0, 65_536)?;
        let start = number(entry, "start", previous_start, duration)?;
        let end = number(entry, "end", start, duration)?;
        if end < start { return Err("Invalid alignment range".into()); }
        previous_start = start;
    }
    Ok(())
}

fn validate_annotations(take: &Value) -> Result<(), String> {
    boolean(take, "favorite")?;
    let rating = required(take, "rating")?;
    if !rating.is_null() && !rating.as_u64().is_some_and(|value| value <= 5) {
        return Err("Take rating must be null or an integer from 0 to 5".into());
    }
    text(take, "note", 0, 65_536)?;
    Ok(())
}

fn validate_project_revision(connection: &Connection, value: &Value) -> Result<(), String> {
    if let Some(project_id) = nullable_identifier(value, "projectId")? {
        let valid: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM revisions r JOIN projects p ON p.id=r.project_id
             WHERE r.id=?1 AND r.project_id=?2 AND p.deleted=0)",
            params![identifier(value, "revisionId")?, project_id], |row| row.get(0)
        ).map_err(error)?;
        if !valid { return Err("Revision does not belong to an active project".into()); }
    }
    Ok(())
}

fn valid_transition(previous: &str, next: &str) -> bool {
    previous == next || matches!((previous, next),
        ("queued", "running" | "cancelled" | "failed" | "interrupted")
        | ("running", "queued" | "completed" | "cancelled" | "failed" | "uncertain" | "interrupted"))
}

fn open_blob(root:&Path,path:&Path,expected_bytes:u64)->Result<(File,PathBuf),String>{
    let canonical = path.canonicalize().map_err(error)?;
    if !canonical.starts_with(root.join("blobs")) {
        return Err("Asset path is outside the blob store".into());
    }
    let file = File::open(&canonical).map_err(error)?;
    let metadata = file.metadata().map_err(error)?;
    if !metadata.is_file() || metadata.len() != expected_bytes || expected_bytes == 0 || expected_bytes > MAX_ASSET_BYTES {
        return Err("Asset size failed its integrity check".into());
    }
    Ok((file,canonical))
}

fn verify_blob(root: &Path, path: &Path, expected_hash: &str, expected_bytes: u64) -> Result<PathBuf, String> {
    let (mut file,canonical)=open_blob(root,path,expected_bytes)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut bytes = 0u64;
    loop {
        let length = file.read(&mut buffer).map_err(error)?;
        if length == 0 { break; }
        bytes = bytes.checked_add(length as u64).ok_or("Asset size overflow")?;
        if bytes > expected_bytes { return Err("Asset changed during its integrity check".into()); }
        hasher.update(&buffer[..length]);
    }
    if bytes != expected_bytes || format!("{:x}", hasher.finalize()) != expected_hash {
        return Err("Asset SHA-256 failed its integrity check".into());
    }
    Ok(canonical)
}

fn scoped_directory(root: &Path, path: &Path) -> Result<(), String> {
    if !path.canonicalize().map_err(error)?.starts_with(root) {
        return Err("Speech storage directory is outside the storage root".into());
    }
    Ok(())
}

struct TemporaryBlob(PathBuf);

impl Drop for TemporaryBlob {
    fn drop(&mut self) {
        match fs::remove_file(&self.0){
            Ok(())=>{},
            Err(error) if error.kind()==std::io::ErrorKind::NotFound=>{},
            Err(_)=>eprintln!("Speech blob working storage could not be removed."),
        }
    }
}

fn query_page(input:&Value)->Result<(i64,i64),String>{
    let limit=match input.get("limit"){None=>-1,Some(value)=>value.as_u64().filter(|value|(1..=500).contains(value)).ok_or("Use a history page limit from 1 to 500.")? as i64};
    let offset=match input.get("offset"){None=>0,Some(value)=>value.as_u64().filter(|value|*value<=i64::MAX as u64).ok_or("Use a nonnegative history offset.")? as i64};
    Ok((limit,offset))
}

pub(super) fn bounded_record(value: &Value) -> Result<(), String> {
    if encode(value)?.len() > MAX_METADATA_BYTES { return Err("Speech metadata exceeds the storage size limit".into()); }
    Ok(())
}

fn fields(value: &Value, allowed: &[&str]) -> Result<(), String> {
    let object = value.as_object().ok_or("Expected a JSON object")?;
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) { return Err(format!("Unexpected field: {key}")); }
    }
    Ok(())
}

fn required<'a>(value: &'a Value, key: &str) -> Result<&'a Value, String> {
    value.get(key).ok_or_else(|| format!("Missing field: {key}"))
}

fn text<'a>(value: &'a Value, key: &str, minimum: usize, maximum: usize) -> Result<&'a str, String> {
    let value = required(value, key)?.as_str().ok_or_else(|| format!("{key} must be text"))?;
    if value.len() < minimum || value.len() > maximum || value.contains('\0') {
        return Err(format!("Invalid text length or NUL in {key}"));
    }
    Ok(value)
}

fn optional_text<'a>(value: &'a Value, key: &str, maximum: usize) -> Result<Option<&'a str>, String> {
    if value.get(key).is_none() { Ok(None) } else { text(value, key, 0, maximum).map(Some) }
}

fn nullable_text<'a>(value: &'a Value, key: &str, maximum: usize) -> Result<Option<&'a str>, String> {
    if required(value, key)?.is_null() { Ok(None) } else { text(value, key, 0, maximum).map(Some) }
}

fn identifier<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value_identifier(required(value, key)?)
}

fn value_identifier(value: &Value) -> Result<&str, String> {
    let id = value.as_str().ok_or("ID must be text")?;
    validate_id(id)?;
    Ok(id)
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') {
        return Err("ID must contain 1 to 128 ASCII letters, digits, hyphens, or underscores".into());
    }
    Ok(())
}

fn nullable_identifier<'a>(value: &'a Value, key: &str) -> Result<Option<&'a str>, String> {
    if required(value, key)?.is_null() { Ok(None) } else { identifier(value, key).map(Some) }
}

fn optional_identifier<'a>(value: &'a Value, key: &str) -> Result<Option<&'a str>, String> {
    if value.get(key).is_none() { Ok(None) } else { identifier(value, key).map(Some) }
}

fn asset_identifier(value: &Value) -> Result<&str, String> {
    let id = value.as_str().ok_or("SHA-256 must be text")?;
    if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
        return Err("SHA-256 must contain 64 lowercase hexadecimal characters".into());
    }
    Ok(id)
}

fn boolean(value: &Value, key: &str) -> Result<bool, String> {
    required(value, key)?.as_bool().ok_or_else(|| format!("{key} must be boolean"))
}

fn optional_bool(value: &Value, key: &str) -> Result<Option<bool>, String> {
    if value.get(key).is_none() { Ok(None) } else { boolean(value, key).map(Some) }
}

fn array<'a>(value: &'a Value, key: &str, maximum: usize) -> Result<&'a Vec<Value>, String> {
    let values = required(value, key)?.as_array().ok_or_else(|| format!("{key} must be an array"))?;
    if values.len() > maximum { return Err(format!("Too many items in {key}")); }
    Ok(values)
}

fn number(value: &Value, key: &str, minimum: f64, maximum: f64) -> Result<f64, String> {
    let number = required(value, key)?.as_f64().ok_or_else(|| format!("{key} must be numeric"))?;
    if !number.is_finite() || number < minimum || number > maximum { return Err(format!("Invalid numeric range for {key}")); }
    Ok(number)
}

fn unsigned(value: &Value, key: &str, maximum: u64) -> Result<u64, String> {
    let number = required(value, key)?.as_u64().ok_or_else(|| format!("{key} must be a nonnegative integer"))?;
    if number > maximum { return Err(format!("Invalid integer range for {key}")); }
    Ok(number)
}

fn backend(value: &Value) -> Result<(), String> {
    if !matches!(text(value, "backend", 1, 32)?, "drama3" | "fish-cloud" | "sglang" | "openai" | "google") {
        return Err("Unknown speech backend".into());
    }
    Ok(())
}

fn unique(ids: &mut HashSet<String>, id: &str) -> Result<(), String> {
    if !ids.insert(id.to_owned()) { return Err(format!("Duplicate ID: {id}")); }
    Ok(())
}

fn exists(connection: &Connection, sql: &str, id: &str) -> Result<(), String> {
    connection.query_row(sql, [id], |_| Ok(())).optional().map_err(error)?
        .ok_or_else(|| format!("Referenced record does not exist: {id}"))
}

fn parse_time(value: &str) -> Result<DateTime<chrono::FixedOffset>, String> {
    DateTime::parse_from_rfc3339(value).map_err(error)
}

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn uuid() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(error)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    ))
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn encode(value: &Value) -> Result<String, String> {
    serde_json::to_string(value).map_err(error)
}

fn parse_json(value: String) -> Result<Value, String> {
    serde_json::from_str(&value).map_err(error)
}

fn collect_json<F>(rows: rusqlite::MappedRows<'_, F>) -> Result<Value, String>
where F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<String> {
    rows.map(|row| parse_json(row.map_err(error)?)).collect::<Result<Vec<_>, _>>().map(Value::Array)
}

fn error(cause: impl std::fmt::Display) -> String {
    cause.to_string()
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
#[cfg(test)]
#[path="cast_override_tests.rs"]
mod cast_override_tests;
