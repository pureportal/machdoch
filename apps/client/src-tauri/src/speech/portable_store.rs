use super::*;
use serde_json::Map;
use std::collections::{BTreeMap, HashMap, VecDeque};

#[path = "portable_budget.rs"]
pub(super) mod budget;
use budget::{insert_dependency, records, ArchiveBudget};

fn remap(map: &HashMap<String, String>, value: &Value) -> Result<Value, String> {
    if value.is_null() { return Ok(Value::Null); }
    Ok(json!(map.get(value.as_str().ok_or("An archived identifier is invalid.")?).ok_or("An archived dependency is missing.")?))
}

fn id_map(values: &[Value], field: &str) -> Result<HashMap<String, String>, String> {
    let mut result = HashMap::new();
    for value in values {
        let id = identifier(value, field)?;
        if result.insert(id.to_owned(), uuid()?).is_some() { return Err("The archive contains duplicate identifiers.".into()); }
    }
    Ok(result)
}

fn mapped_dictionary(dictionary: &Value, ids: &HashMap<String, String>) -> Result<Value, String> {
    let mut dictionary = dictionary.clone();
    dictionary["id"] = remap(ids, &dictionary["id"])?;
    Ok(dictionary)
}

fn mapped_profile(profile: &Value, ids: &HashMap<String, String>, dictionaries: &HashMap<String, String>) -> Result<Value, String> {
    let mut profile = profile.clone();
    profile["id"] = remap(ids, &profile["id"])?;
    for id in profile["dictionaryIds"].as_array_mut().ok_or("An archived profile dictionary list is invalid.")? { *id = remap(dictionaries, id)?; }
    Ok(profile)
}

fn validate_profile_assets(profile:&Value,assets:&Map<String,Value>,references:&Value)->Result<(),String>{
    for id in profile["referenceAssetIds"].as_array().into_iter().flatten(){
        let id=asset_identifier(id)?;if !assets.contains_key(id)||references.get(id).is_none(){return Err("An archived profile default reference or its permission/transcript is missing.".into());}
    }
    Ok(())
}

fn mapped_project(project: &Value, id: &str, revisions: &HashMap<String, String>, profiles: &HashMap<String, String>, takes: &HashMap<String, String>, timings: &HashMap<String,String>) -> Result<Value, String> {
    let mut project = project.clone();
    project["id"] = json!(id);
    project["revisionId"] = remap(revisions, &project["revisionId"])?;
    project["parentRevisionId"] = remap(revisions, &project["parentRevisionId"])?;
    project["profileId"] = remap(profiles, &project["profileId"])?;
    project["location"] = Value::Null;
    for clip in project["timeline"].as_array_mut().ok_or("An archived timeline is invalid.")? {
        clip["takeId"] = remap(takes, &clip["takeId"])?;
    }
    for value in project["selectedTakes"].as_object_mut().ok_or("Archived selections are invalid.")?.values_mut() { *value = remap(takes, value)?; }
    if let Some(reviews)=project.get_mut("voiceAuditions").and_then(Value::as_array_mut){for review in reviews{review["takeId"]=remap(takes,&review["takeId"])?;}}
    if let Some(bookmarks)=project.get_mut("readingBookmarks").and_then(Value::as_array_mut){for bookmark in bookmarks{bookmark["takeId"]=remap(takes,&bookmark["takeId"])?;}}
    timing_portable::map_project(&mut project,takes,timings)?;
    Ok(project)
}

pub(super) struct PortableAudio {
    pub takes: Vec<Value>,
    pub take_requests: Map<String,Value>,
    pub assets: Map<String,Value>,
    pub references: Map<String,Value>,
    pub originals: Vec<Value>,
    pub audio_sources: Map<String,Value>,
}

pub(super) fn collect_audio(
    store: &mut SpeechStore,
    root_takes: Vec<Value>,
    project_id: Option<&str>,
    mut asset_ids: HashSet<String>,
    budget: &mut ArchiveBudget,
) -> Result<PortableAudio,String> {
    if asset_ids.len() > MAX_ITEMS { return Err("The archive has too many audio dependencies.".into()); }
    let mut pending = VecDeque::new();
    let mut queued_takes = HashSet::new();
    for take in root_takes {
        if insert_dependency(&mut queued_takes, identifier(&take, "id")?)? {
            pending.push_back(take);
        }
    }
    let mut takes = BTreeMap::new();
    let mut take_requests = Map::new();
    while let Some(mut take) = pending.pop_front() {
        let id = identifier(&take, "id")?.to_owned();
        let request = records(&store.connection,
            "SELECT length(CAST(data AS BLOB)),data FROM take_requests WHERE take_id=?1",
            [&id], budget)?.into_iter().next().ok_or("A take's immutable generation request is unavailable.")?;
        validate_take_request(&take, &request)?;
        for id in request["references"].as_object().ok_or("Invalid generation references.")?.keys() {
            insert_dependency(&mut asset_ids, id)?;
        }
        for id in request["profile"]["referenceAssetIds"].as_array().into_iter().flatten() {
            insert_dependency(&mut asset_ids, asset_identifier(id)?)?;
        }
        budget.value(&id, 0)?;
        take_requests.insert(id.clone(), request);
        for field in ["reusedFromTakeId", "parentTakeId"] {
            if let Some(id) = take[field].as_str() {
                if insert_dependency(&mut queued_takes, id)? {
                    let dependency = records(&store.connection,
                        "SELECT length(CAST(data AS BLOB)),data FROM takes WHERE id=?1",
                        [id], budget)?.into_iter().next().ok_or("A take lineage dependency is unavailable.")?;
                    pending.push_back(dependency);
                }
            }
        }
        if take["projectId"].as_str() != project_id { take["projectId"] = Value::Null; }
        let asset_id = asset_identifier(&take["asset"]["id"])?.to_owned();
        insert_dependency(&mut asset_ids, &asset_id)?;
        let path = format!("blobs/{asset_id}");
        budget.value(&path, 0)?;
        take["asset"]["path"] = Value::String(path);
        takes.insert(id, take);
    }
    #[derive(serde::Serialize)]
    struct Reference<'a> {
        transcript: &'a str,
        #[serde(rename = "rightsEvidence")]
        rights: &'a str,
    }
    #[derive(serde::Serialize)]
    struct Original<'a> {
        #[serde(rename = "assetId")]
        asset: &'a str,
        #[serde(rename = "originalAssetId")]
        original: &'a str,
    }
    let mut references = Map::new();
    let mut originals = Vec::new();
    let mut pending = VecDeque::from_iter(asset_ids.iter().cloned());
    while let Some(id) = pending.pop_front() {
        let mut statement = store.connection.prepare(
            "SELECT length(CAST(transcript AS BLOB)),length(CAST(rights AS BLOB)),transcript,rights FROM speech_references WHERE asset_id=?1"
        ).map_err(error)?;
        let mut rows = statement.query([&id]).map_err(error)?;
        if let Some(row) = rows.next().map_err(error)? {
            let transcript_bytes: i64 = row.get(0).map_err(error)?;
            let rights_bytes: i64 = row.get(1).map_err(error)?;
            let size = transcript_bytes.checked_add(rights_bytes).ok_or("Archive reference metadata overflowed.")?;
            let prepaid = budget.reserve_sql(size, 1)?;
            let transcript: String = row.get(2).map_err(error)?;
            let rights: String = row.get(3).map_err(error)?;
            if rights.trim().is_empty() { return Err("Record export rights for every bundled reference.".into()); }
            budget.growth(&Reference { transcript: &transcript, rights: &rights }, prepaid)?;
            budget.value(&id, 0)?;
            let reference = Value::Object(Map::from_iter([
                ("transcript".into(), Value::String(transcript)),
                ("rightsEvidence".into(), Value::String(rights)),
            ]));
            references.insert(id.clone(), reference);
        }
        let mut statement = store.connection.prepare(
            "SELECT DISTINCT length(CAST(original_asset_id AS BLOB)),original_asset_id FROM speech_reference_originals WHERE asset_id=?1"
        ).map_err(error)?;
        let mut rows = statement.query([&id]).map_err(error)?;
        while let Some(row) = rows.next().map_err(error)? {
            let prepaid = budget.reserve_sql(row.get(0).map_err(error)?, 1)?;
            let original: String = row.get(1).map_err(error)?;
            budget.growth(&Original { asset: &id, original: &original }, prepaid)?;
            if insert_dependency(&mut asset_ids, &original)? {
                pending.push_back(original.clone());
            }
            originals.push(json!({"assetId":id,"originalAssetId":original}));
        }
    }
    let mut assets = Map::new();
    let mut audio_sources = Map::new();
    for id in asset_ids {
        budget.reserve(0, 1)?;
        asset_identifier(&json!(id))?;
        let asset = store.asset_metadata(&id,Path::new(&format!("blobs/{id}")))?;
        budget.value(&asset, 0)?;
        budget.value(&id, 0)?;
        if let Some(source) = records(&store.connection,
            "SELECT length(CAST(data AS BLOB)),data FROM speech_audio_sources WHERE asset_id=?1",
            [&id], budget)?.into_iter().next() {
            budget.value(&id, 0)?;
            audio_sources.insert(id.clone(), source);
        }
        assets.insert(id, asset);
    }
    Ok(PortableAudio { takes: takes.into_values().collect(), take_requests, assets, references, originals, audio_sources })
}

impl SpeechStore {
    pub fn portable_snapshot(&mut self, project_id: &str, revision_id: &str) -> Result<Value, String> {
        let mut budget = ArchiveBudget::default();
        budget.reserve(1024, 0)?;
        self.connection.query_row("SELECT 1 FROM projects WHERE id=?1 AND deleted=0", [project_id], |row| row.get::<_, i64>(0))
            .optional().map_err(error)?.ok_or("The speech project is unavailable.")?;
        let mut revisions = records(&self.connection,
            "WITH RECURSIVE history(id) AS (SELECT ?2 UNION SELECT r.parent_id FROM revisions r JOIN history h ON r.id=h.id WHERE r.project_id=?1 AND r.parent_id IS NOT NULL) SELECT length(CAST(r.data AS BLOB)),r.data FROM revisions r JOIN history h ON r.id=h.id WHERE r.project_id=?1 ORDER BY r.created_at,r.id",
            params![project_id,revision_id], &mut budget)?;
        for revision in &mut revisions { revision["location"] = Value::Null; }
        let selected = revisions.iter().find(|revision| revision["revisionId"] == revision_id)
            .ok_or("The selected project revision is unavailable.")?;
        budget.value(selected, 1)?;
        let project = selected.clone();
        let mut ancestors = HashSet::new();
        let mut head = Some(revision_id);
        while let Some(id) = head {
            if !insert_dependency(&mut ancestors, id)? { return Err("The stored project revision history contains a cycle.".into()); }
            head = revisions.iter().find(|revision| revision["revisionId"] == id)
                .ok_or("A stored parent revision is missing.")?["parentRevisionId"].as_str();
        }
        let mut revision_profiles = Map::new();
        let mut revision_dictionaries = Map::new();
        let mut profile_ids = HashSet::new();
        let mut dictionary_ids = HashSet::new();
        let mut asset_ids = HashSet::new();
        for revision in &revisions {
            for id in project_asset_ids(revision)? { insert_dependency(&mut asset_ids, &id)?; }
            let id = identifier(revision, "revisionId")?;
            let profile = match records(&self.connection,
                "SELECT length(CAST(data AS BLOB)),data FROM revision_profiles WHERE revision_id=?1",
                [id], &mut budget)?.into_iter().next() {
                Some(profile) => profile,
                None => { budget.value(&Value::Null, 1)?; Value::Null }
            };
            for id in profile["referenceAssetIds"].as_array().into_iter().flatten() {
                insert_dependency(&mut asset_ids, asset_identifier(id)?)?;
            }
            if let Some(id) = profile["id"].as_str() { insert_dependency(&mut profile_ids, id)?; }
            let dictionaries = records(&self.connection,
                "SELECT length(CAST(d.data AS BLOB)),d.data FROM dictionary_revisions d JOIN revision_dictionaries r ON r.dictionary_id=d.dictionary_id AND r.dictionary_revision=d.revision WHERE r.revision_id=?1 ORDER BY d.dictionary_id",
                [id], &mut budget)?;
            for dictionary in &dictionaries { insert_dependency(&mut dictionary_ids, identifier(dictionary, "id")?)?; }
            budget.value(&id, 0)?;
            budget.value(&id, 0)?;
            revision_profiles.insert(id.to_owned(), profile);
            revision_dictionaries.insert(id.to_owned(), Value::Array(dictionaries));
        }
        let mut profiles = Vec::new();
        for id in profile_ids {
            let profile = records(&self.connection,
                "SELECT length(CAST(data AS BLOB)),data FROM profiles WHERE id=?1",
                [&id], &mut budget)?.into_iter().next().ok_or("A project profile is unavailable.")?;
            for id in array(&profile, "dictionaryIds", 256)? { insert_dependency(&mut dictionary_ids, value_identifier(id)?)?; }
            for id in profile["referenceAssetIds"].as_array().into_iter().flatten() {
                insert_dependency(&mut asset_ids, asset_identifier(id)?)?;
            }
            profiles.push(profile);
        }
        let mut dictionaries = Vec::new();
        for id in dictionary_ids {
            dictionaries.push(records(&self.connection,
                "SELECT length(CAST(data AS BLOB)),data FROM dictionaries WHERE id=?1",
                [&id], &mut budget)?.into_iter().next().ok_or("A project dictionary is unavailable.")?);
        }
        let root_takes = records(&self.connection,
            "WITH RECURSIVE history(id) AS (SELECT ?2 UNION SELECT r.parent_id FROM revisions r JOIN history h ON r.id=h.id WHERE r.project_id=?1 AND r.parent_id IS NOT NULL) SELECT length(CAST(t.data AS BLOB)),t.data FROM takes t JOIN history h ON t.revision_id=h.id WHERE t.project_id=?1 ORDER BY t.created_at,t.id",
            params![project_id,revision_id], &mut budget)?;
        let mut root_take_ids = Vec::new();
        for take in &root_takes {
            budget.value(&take["id"], 1)?;
            root_take_ids.push(take["id"].clone());
        }
        let audio = collect_audio(self, root_takes, Some(project_id), asset_ids, &mut budget)?;
        let reference_metadata = Value::Object(audio.references);
        for profile in profiles.iter().chain(revision_profiles.values()).chain(audio.take_requests.values().map(|request| &request["profile"])) {
            validate_profile_assets(profile, &audio.assets, &reference_metadata)?;
        }
        let timing_results = timing_portable::collect(self, &audio.takes, &mut budget)?;
        Ok(Value::Object(Map::from_iter([
            ("schema".into(), Value::String("machdoch-speech-project".into())),
            ("version".into(), json!(1)),
            ("project".into(), project),
            ("revisions".into(), Value::Array(revisions)),
            ("profiles".into(), Value::Array(profiles)),
            ("dictionaries".into(), Value::Array(dictionaries)),
            ("revisionProfiles".into(), Value::Object(revision_profiles)),
            ("revisionDictionaries".into(), Value::Object(revision_dictionaries)),
            ("takes".into(), Value::Array(audio.takes)),
            ("takeRequests".into(), Value::Object(audio.take_requests)),
            ("rootTakeIds".into(), Value::Array(root_take_ids)),
            ("assets".into(), Value::Object(audio.assets)),
            ("references".into(), reference_metadata),
            ("originals".into(), Value::Array(audio.originals)),
            ("audioSources".into(), Value::Object(audio.audio_sources)),
            ("timingResults".into(), Value::Array(timing_results)),
        ])))
    }

    pub fn validate_portable_snapshot(&self, manifest: &Value) -> Result<(), String> {
        fields(manifest, &["schema","version","project","revisions","profiles","dictionaries","revisionProfiles","revisionDictionaries","takes","takeRequests","rootTakeIds","assets","references","originals","audioSources","timingResults"])?;
        if manifest["schema"] != "machdoch-speech-project" || manifest["version"] != 1 { return Err("This project archive schema is unsupported.".into()); }
        validate_project(&manifest["project"])?;
        let project_id = identifier(&manifest["project"], "id")?;
        let revisions = array(manifest, "revisions", MAX_ITEMS)?;
        let profiles = array(manifest, "profiles", MAX_ITEMS)?;
        let dictionaries = array(manifest, "dictionaries", MAX_ITEMS)?;
        let takes = array(manifest, "takes", MAX_ITEMS)?;
        let revision_ids = id_map(revisions, "revisionId")?;
        let profile_ids = id_map(profiles, "id")?;
        let dictionary_ids = id_map(dictionaries, "id")?;
        let take_ids = id_map(takes, "id")?;
        let timing_ids=id_map(timing_portable::records(manifest)?,"id")?;
        let take_requests = manifest["takeRequests"].as_object().filter(|values|values.len()==takes.len()).ok_or("The archive is missing immutable take requests.")?;
        let assets = manifest["assets"].as_object().filter(|values| values.len() <= MAX_ITEMS).ok_or("The archived asset inventory is invalid.")?;
        let revision_profiles = manifest["revisionProfiles"].as_object().ok_or("Archived revision profiles are missing.")?;
        let revision_dictionaries = manifest["revisionDictionaries"].as_object().ok_or("Archived revision dictionaries are missing.")?;
        if revision_profiles.len() != revisions.len() || revision_dictionaries.len() != revisions.len() { return Err("The archive is missing revision dependencies.".into()); }
        for dictionary in dictionaries { validate_dictionary(dictionary)?; }
        for profile in profiles {
            validate_profile(profile)?;
            validate_profile_assets(profile,assets,&manifest["references"])?;
            mapped_profile(profile, &profile_ids, &dictionary_ids)?;
        }
        for revision in revisions {
            validate_project(revision)?;
            if revision["id"] != project_id { return Err("The archive mixes project revision histories.".into()); }
            let id = identifier(revision, "revisionId")?;
            mapped_project(revision, project_id, &revision_ids, &profile_ids, &take_ids, &timing_ids)?;
            for id in project_asset_ids(revision)? { if !assets.contains_key(&id) { return Err("An archived revision reference is missing.".into()); } }
            let profile = revision_profiles.get(id).ok_or("An archived revision profile is missing.")?;
            if profile["id"] != revision["profileId"] { return Err("An archived revision profile does not match its project.".into()); }
            let dictionaries = revision_dictionaries.get(id).and_then(Value::as_array).ok_or("An archived revision dictionary list is invalid.")?;
            if !profile.is_null() {
                validate_profile(profile)?;
                validate_profile_assets(profile,assets,&manifest["references"])?;
                mapped_profile(profile, &profile_ids, &dictionary_ids)?;
                let expected: HashSet<_> = array(profile, "dictionaryIds", 256)?.iter().map(Value::as_str).collect();
                let actual: HashSet<_> = dictionaries.iter().map(|dictionary| dictionary["id"].as_str()).collect();
                if expected != actual || actual.len() != dictionaries.len() { return Err("The archived pronunciation snapshot is incomplete.".into()); }
            } else if !dictionaries.is_empty() { return Err("A profile-free revision cannot contain dictionary snapshots.".into()); }
            for dictionary in dictionaries { validate_dictionary(dictionary)?; mapped_dictionary(dictionary, &dictionary_ids)?; }
        }
        if !revisions.iter().any(|revision| *revision == manifest["project"]) { return Err("The archived project head differs from its immutable revision.".into()); }
        let mut visited = HashSet::new();
        let mut head = manifest["project"]["revisionId"].as_str();
        while let Some(id) = head {
            if !visited.insert(id) { return Err("The archived revision history contains a cycle.".into()); }
            let revision = revisions.iter().find(|revision| revision["revisionId"] == id).ok_or("An archived parent revision is missing.")?;
            head = revision["parentRevisionId"].as_str();
        }
        if visited.len() != revisions.len() { return Err("The archived revision history contains unrelated snapshots.".into()); }
        let root_ids: HashSet<_> = array(manifest, "rootTakeIds", MAX_ITEMS)?.iter().map(value_identifier).collect::<Result<_,_>>()?;
        for take in takes {
            validate_take(take)?;
            let request = take_requests.get(identifier(take,"id")?).ok_or("An archived take's generation request is missing.")?;
            validate_take_request(take,request)?;
            validate_profile_assets(&request["profile"],assets,&manifest["references"])?;
            for id in request["references"].as_object().ok_or("Invalid archived generation references.")?.keys() { if !assets.contains_key(id) { return Err("An archived generation reference asset is missing.".into()); } }
            if root_ids.contains(identifier(take,"id")?) {
                if take["projectId"] != project_id || !revision_ids.contains_key(identifier(take,"revisionId")?) { return Err("An archived take has invalid project provenance.".into()); }
            } else if !take["projectId"].is_null() { return Err("A dependency take must be detached from unrelated projects.".into()); }
            for field in ["parentTakeId", "reusedFromTakeId"] { remap(&take_ids, &take[field])?; }
            let id = asset_identifier(&take["asset"]["id"])?;
            if assets.get(id) != Some(&take["asset"]) { return Err("An archived take differs from its audio inventory.".into()); }
        }
        if root_ids.iter().any(|id| !take_ids.contains_key(*id)) { return Err("A project take is missing from the archive.".into()); }
        for take in takes{
            let request=&take_requests[identifier(take,"id")?];
            if request.get("performanceNote").is_some(){
                let parent=take_requests.get(identifier(take,"parentTakeId")?).ok_or("A director performance source request is missing.")?;
                super::super::performance::validate_origin(request,parent)?;
            }
        }
        let review_takes:HashMap<_,_>=takes.iter().map(|take|(take["id"].as_str().unwrap_or_default(),take)).collect();
        for revision in revisions{
            for bookmark in reading_bookmarks::records(revision)? {
                let take=review_takes.get(identifier(bookmark,"takeId")?).ok_or("A reading bookmark take is missing from the archive.")?;
                reading_bookmarks::validate_evidence(bookmark,take,revision)?;
            }
            for review in revision["voiceAuditions"].as_array().into_iter().flatten(){
                let id=identifier(review,"takeId")?;
                let take=review_takes.get(id).ok_or("A listening review take is missing from the archive.")?;
                if take["projectId"]!=project_id{return Err("A listening review belongs to another project.".into());}
                audition_reviews::validate_evidence(review,take,take_requests.get(id).ok_or("A listening review request is missing.")?)?;
            }
        }
        timing_portable::validate(manifest)?;
        let references = manifest["references"].as_object().ok_or("Archived references are invalid.")?;
        for (id, reference) in references {
            if !assets.contains_key(id) { return Err("An archived reference asset is missing.".into()); }
            text(reference,"transcript",1,65_536)?;
            if text(reference,"rightsEvidence",1,32_768)?.trim().is_empty() { return Err("A reference has no export permission.".into()); }
        }
        let audio_sources=manifest["audioSources"].as_object().filter(|values|values.len()<=MAX_ITEMS).ok_or("Archived imported-audio provenance is missing.")?;
        for (id,source) in audio_sources{
            if !assets.contains_key(id){return Err("An archived imported-audio asset is missing.".into());}
            fields(source,&["origins"])?;
            let origins=array(source,"origins",32)?;
            if origins.is_empty(){return Err("An archived imported-audio source has no permission evidence.".into());}
            for origin in origins{fields(origin,&["sourceSha256","sourceBytes","rightsEvidence"])?;asset_identifier(required(origin,"sourceSha256")?)?;unsigned(origin,"sourceBytes",512*1024*1024)?;if text(origin,"rightsEvidence",1,32_768)?.trim().is_empty(){return Err("An imported-audio source has no export permission.".into());}}
        }
        for revision in revisions{
            for id in project_reference_ids(revision)?{if !references.contains_key(&id){return Err("An archived voice reference has no transcript or permission evidence.".into());}}
            for track in revision["backgroundTracks"].as_array().into_iter().flatten(){let id=asset_identifier(required(track,"assetId")?)?;if !audio_sources.contains_key(id){return Err("An archived background track has no source or permission evidence.".into());}let duration=assets[id]["duration"].as_f64().ok_or("An archived track duration is missing.")?;if track["out"].as_f64().is_none_or(|out|out>duration){return Err("An archived background trim exceeds its audio.".into());}}
        }
        for link in array(manifest,"originals",MAX_ITEMS)? {
            for key in ["assetId","originalAssetId"] { if !assets.contains_key(asset_identifier(required(link,key)?)?) { return Err("An original reference dependency is missing.".into()); } }
        }
        for (id, asset) in assets {
            if asset_identifier(&json!(id))? != asset_identifier(&asset["id"])? || asset["sha256"] != *id || asset["path"] != format!("blobs/{id}") { return Err("The archived asset inventory is inconsistent.".into()); }
        }
        Ok(())
    }

    pub fn commit_portable_snapshot(&mut self, manifest: &Value) -> Result<Value, String> {
        self.commit_portable_snapshot_with_id(manifest,uuid()?)
    }

    pub(super) fn commit_portable_snapshot_with_id(&mut self, manifest: &Value, project_id: String) -> Result<Value,String> {
        self.validate_portable_snapshot(manifest)?;
        let revisions = array(manifest,"revisions",MAX_ITEMS)?;
        let profiles = array(manifest,"profiles",MAX_ITEMS)?;
        let dictionaries = array(manifest,"dictionaries",MAX_ITEMS)?;
        let takes = array(manifest,"takes",MAX_ITEMS)?;
        let revision_ids = id_map(revisions,"revisionId")?;
        let profile_ids = id_map(profiles,"id")?;
        let dictionary_ids = id_map(dictionaries,"id")?;
        let take_ids = id_map(takes,"id")?;
        let timing_ids=id_map(timing_portable::records(manifest)?,"id")?;
        let project = mapped_project(&manifest["project"], &project_id, &revision_ids, &profile_ids, &take_ids, &timing_ids)?;
        let mut mapped_takes = Vec::new();
        let mut mapped_requests = HashMap::new();
        let mut asset_records=HashMap::<String,Value>::new();
        for original in takes {
            let mut take = original.clone();
            take["id"] = remap(&take_ids,&take["id"])?;
            if !take["projectId"].is_null() { take["projectId"] = json!(project_id); take["revisionId"] = remap(&revision_ids,&take["revisionId"])?; }
            for key in ["parentTakeId","reusedFromTakeId"] { take[key] = remap(&take_ids,&take[key])?; }
            let asset_id=asset_identifier(&take["asset"]["id"])?;
            if !asset_records.contains_key(asset_id){
                let record=self.asset_record(asset_id)?;
                asset_records.insert(asset_id.to_owned(),record);
            }
            take["asset"] = asset_records[asset_id].clone();
            validate_take(&take)?;
            mapped_requests.insert(identifier(&take,"id")?.to_owned(),manifest["takeRequests"][identifier(original,"id")?].clone());
            mapped_takes.push(take);
        }
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
        transaction.execute_batch("PRAGMA defer_foreign_keys=ON").map_err(error)?;
        for dictionary in dictionaries {
            let dictionary = mapped_dictionary(dictionary,&dictionary_ids)?;
            transaction.execute("INSERT INTO dictionaries(id,revision,data) VALUES(?1,?2,?3)",params![dictionary["id"].as_str(),dictionary["revision"].as_str(),encode(&dictionary)?]).map_err(error)?;
            transaction.execute("INSERT INTO dictionary_revisions VALUES(?1,?2,?3)",params![dictionary["id"].as_str(),dictionary["revision"].as_str(),encode(&dictionary)?]).map_err(error)?;
        }
        for profile in profiles {
            let profile = mapped_profile(profile,&profile_ids,&dictionary_ids)?;
            transaction.execute("INSERT INTO profiles(id,data) VALUES(?1,?2)",params![profile["id"].as_str(),encode(&profile)?]).map_err(error)?;
        }
        transaction.execute("INSERT INTO projects(id,revision_id,profile_id,title,archived,updated_at,data) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![project_id,project["revisionId"].as_str(),project["profileId"].as_str(),project["title"].as_str(),project["archived"].as_bool(),project["updatedAt"].as_str(),encode(&project)?]).map_err(error)?;
        for original in revisions {
            let revision = mapped_project(original,&project_id,&revision_ids,&profile_ids,&take_ids,&timing_ids)?;
            let id = identifier(&revision,"revisionId")?;
            let data = encode(&revision)?;
            transaction.execute("INSERT INTO revisions(id,project_id,parent_id,created_at,source,content_hash,data) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![id,project_id,revision["parentRevisionId"].as_str(),revision["updatedAt"].as_str(),revision["source"].as_str(),digest(data.as_bytes()),data]).map_err(error)?;
            for asset in project_asset_ids(&revision)? { transaction.execute("INSERT INTO revision_assets VALUES(?1,?2)",params![id,asset]).map_err(error)?; }
            for take in project_take_ids(&revision)? { transaction.execute("INSERT INTO revision_takes VALUES(?1,?2)",params![id,take]).map_err(error)?; }
            for (_,timing) in timing_store::selection_ids(&revision)?{transaction.execute("INSERT INTO revision_timings VALUES(?1,?2)",params![id,timing]).map_err(error)?;}
            let original_id = identifier(original,"revisionId")?;
            let profile = &manifest["revisionProfiles"][original_id];
            if !profile.is_null() {
                let profile = mapped_profile(profile,&profile_ids,&dictionary_ids)?;
                transaction.execute("INSERT INTO revision_profiles VALUES(?1,?2,?3)",params![id,profile["id"].as_str(),encode(&profile)?]).map_err(error)?;
            }
            for dictionary in manifest["revisionDictionaries"][original_id].as_array().ok_or("Invalid archived dictionaries.")? {
                let dictionary = mapped_dictionary(dictionary,&dictionary_ids)?;
                let existing: Option<String> = transaction.query_row("SELECT data FROM dictionary_revisions WHERE dictionary_id=?1 AND revision=?2",params![dictionary["id"].as_str(),dictionary["revision"].as_str()],|row|row.get(0)).optional().map_err(error)?;
                if existing.as_ref().is_some_and(|value| parse_json(value.clone()).ok().as_ref() != Some(&dictionary)) { return Err("Archived dictionary revisions disagree.".into()); }
                transaction.execute("INSERT INTO dictionary_revisions VALUES(?1,?2,?3) ON CONFLICT DO NOTHING",params![dictionary["id"].as_str(),dictionary["revision"].as_str(),encode(&dictionary)?]).map_err(error)?;
                transaction.execute("INSERT INTO revision_dictionaries VALUES(?1,?2,?3)",params![id,dictionary["id"].as_str(),dictionary["revision"].as_str()]).map_err(error)?;
            }
        }
        let mut inserted = HashSet::new();
        while !mapped_takes.is_empty() {
            let before = mapped_takes.len();
            let mut remaining = Vec::new();
            for take in mapped_takes {
                if ["parentTakeId","reusedFromTakeId"].iter().any(|key| take[key].as_str().is_some_and(|id| !inserted.contains(id))) { remaining.push(take); continue; }
                Self::put_take_in_transaction(&transaction,&take)?;
                let id=identifier(&take,"id")?;
                transaction.execute("INSERT INTO take_requests VALUES(?1,?2)",params![id,encode(mapped_requests.get(id).ok_or("An imported generation request is missing.")?)?]).map_err(error)?;
                inserted.insert(identifier(&take,"id")?.to_owned());
            }
            if remaining.len() == before { return Err("The archived take lineage contains a cycle.".into()); }
            mapped_takes = remaining;
        }
        for record in timing_portable::records(manifest)?{
            let record=timing_portable::map_record(record,&take_ids,&timing_ids)?;
            transaction.execute("INSERT INTO speech_timings VALUES(?1,?2,?3,?4,?5)",params![identifier(&record,"id")?,identifier(&record,"takeId")?,record["requestHash"].as_str(),record["createdAt"].as_str(),encode(&record)?]).map_err(error)?;
        }
        for (id, reference) in manifest["references"].as_object().ok_or("Invalid archived references.")? {
            let existing: Option<(String,String)> = transaction.query_row("SELECT transcript,rights FROM speech_references WHERE asset_id=?1",[id],|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(error)?;
            if existing.as_ref().is_some_and(|(transcript,rights)| reference["transcript"] != *transcript || reference["rightsEvidence"] != *rights) { return Err("An existing reference has different transcript or rights evidence. Resolve it before importing.".into()); }
            transaction.execute("INSERT INTO speech_references VALUES(?1,?2,?3) ON CONFLICT DO NOTHING",params![id,reference["transcript"].as_str(),reference["rightsEvidence"].as_str()]).map_err(error)?;
        }
        for link in array(manifest,"originals",MAX_ITEMS)? { transaction.execute("INSERT INTO speech_reference_originals VALUES(?1,?2) ON CONFLICT DO NOTHING",params![link["assetId"].as_str(),link["originalAssetId"].as_str()]).map_err(error)?; }
        for (id,source) in manifest["audioSources"].as_object().ok_or("Archived imported-audio provenance is missing.")?{
            let previous:Option<String>=transaction.query_row("SELECT data FROM speech_audio_sources WHERE asset_id=?1",[id],|row|row.get(0)).optional().map_err(error)?;
            let mut origins=match previous{Some(data)=>parse_json(data)?["origins"].as_array().cloned().ok_or("Stored imported-audio provenance is invalid.")?,None=>Vec::new()};
            for origin in array(source,"origins",32)?{if !origins.contains(origin){if origins.len()>=32{return Err("Imported audio has too many source records.".into());}origins.push(origin.clone());}}
            transaction.execute("INSERT INTO speech_audio_sources VALUES(?1,?2) ON CONFLICT DO UPDATE SET data=excluded.data",params![id,encode(&json!({"origins":origins}))?]).map_err(error)?;
        }
        transaction.commit().map_err(error)?;
        Ok(project)
    }
}
