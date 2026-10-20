use super::*;
use super::portable::budget::{records, ArchiveBudget};

impl SpeechStore {
    pub(super) fn find_answer_audio(&mut self,input:&Value)->Result<Value,String>{
        fields(input,&["owner","alternateOwner","answerId","revision","source","profileId"])?;
        let owner=text(input,"owner",1,512)?;
        let alternate=optional_text(input,"alternateOwner",512)?;
        if alternate.is_some_and(|alternate| !owner.starts_with("chat:") || alternate!=format!("chat:auto:{}",&owner[5..])){return Err("Use the same conversation's speech owners.".into());}
        let answer=identifier(input,"answerId")?;
        let revision=identifier(input,"revision")?;
        let source=text(input,"source",1,2*1024*1024)?;
        let profile_id=identifier(input,"profileId")?;
        let data:Option<String>=self.connection.query_row("SELECT t.data FROM takes t JOIN job_takes jt ON jt.take_id=t.id JOIN jobs j ON j.id=jt.job_id JOIN speech_live_inputs l ON l.job_id=j.id WHERE (j.owner=?1 OR j.owner=?2) AND j.state='completed' AND t.project_id IS NULL AND l.answer_revision=?3 AND l.final_text=?5 AND json_extract(t.data,'$.segmentId')=?4 ORDER BY t.created_at DESC,t.id DESC LIMIT 1",params![owner,alternate,revision,answer,source],|row|row.get(0)).optional().map_err(error)?;
        let Some(data)=data else{return Ok(Value::Null)};
        let mut take=parse_json(data)?;
        let request=self.execute("takeRequest",&json!({"id":take["id"]}))?;
        let profiles=self.execute("listProfiles",&json!({}))?;
        let Some(profile)=profiles.as_array().and_then(|profiles|profiles.iter().find(|profile|profile["id"]==profile_id))else{return Ok(Value::Null)};
        let available=self.execute("listDictionaries",&json!({}))?;
        let mut dictionaries=Vec::new();
        for id in array(profile,"dictionaryIds",256)?{
            let Some(dictionary)=available.as_array().and_then(|items|items.iter().find(|item|item["id"]==*id))else{return Ok(Value::Null)};
            dictionaries.push(dictionary.clone());
        }
        let connection=super::super::settings::connection_snapshot(self,profile["backend"].as_str().ok_or("The saved speech backend is invalid.")?)?;
        if super::super::cache::request_hash(&request["segment"],profile,&json!(dictionaries),&request["references"],&connection)?!=take["requestHash"]{return Ok(Value::Null)}
        take["asset"]=self.execute("asset",&json!({"id":take["asset"]["id"]}))?;
        Ok(take)
    }

    pub(super) fn save_answer_audio(&mut self, input: &Value) -> Result<Value,String> {
        fields(input,&["owner","alternateOwner","answerId","revision","source","title","sessionId"])?;
        let owner = text(input,"owner",1,512)?;
        let alternate = optional_text(input,"alternateOwner",512)?;
        if alternate.is_some_and(|alternate| !owner.starts_with("chat:") || alternate != format!("chat:auto:{}", &owner[5..])) { return Err("Use the same conversation's manual and automatic speech owners.".into()); }
        let answer_id = identifier(input,"answerId")?;
        let revision = identifier(input,"revision")?;
        let session_id = text(input,"sessionId",1,512)?;
        let source = text(input,"source",1,2*1024*1024)?;
        if source.chars().any(|value|matches!(value,'<'|'>'|'['|']')) { return Err("Convert the answer into literal speech text before saving its audio.".into()); }
        let title = text(input,"title",1,1024)?;
        let mut budget = ArchiveBudget::default();
        budget.reserve(1024, 0)?;
        let original = {
            let mut statement = self.connection.prepare("SELECT length(CAST(t.data AS BLOB)),t.data FROM takes t JOIN job_takes jt ON jt.take_id=t.id JOIN jobs j ON j.id=jt.job_id LEFT JOIN speech_live_inputs l ON l.job_id=j.id WHERE (j.owner=?1 OR j.owner=?2) AND j.state='completed' AND t.project_id IS NULL AND (t.revision_id=?3 OR l.answer_revision=?3 AND l.final_text=?5) AND json_extract(t.data,'$.segmentId')=?4 ORDER BY t.created_at DESC,t.id DESC LIMIT 1").map_err(error)?;
            let mut rows = statement.query(params![owner,alternate,revision,answer_id,source]).map_err(error)?;
            let row = rows.next().map_err(error)?.ok_or("Read the complete answer with a generated speech voice before saving its audio.")?;
            budget.json_row(row)?
        };
        if original["spokenText"] != source { return Err("This answer changed after it was read. Play the current answer before saving its audio.".into()); }
        let project_id = format!("answer-{}",digest(encode(&json!([session_id,answer_id,revision]))?.as_bytes()));
        let existing = records(&self.connection,
            "SELECT length(CAST(data AS BLOB)),data FROM projects WHERE id=?1 AND deleted=0",
            [&project_id], &mut budget)?.into_iter().next();
        if let Some(mut project) = existing {
            let takes = records(&self.connection,
                "SELECT length(CAST(data AS BLOB)),data FROM takes WHERE project_id=?1 ORDER BY created_at,id",
                [&project_id], &mut budget)?;
            if takes.iter().any(|take|take["requestHash"]==original["requestHash"]&&take["asset"]["id"]==original["asset"]["id"]&&take["spokenText"]==source) { return Ok(project); }
            let source_revision:String=self.connection.query_row("SELECT id FROM revisions WHERE project_id=?1 AND source=?2 ORDER BY created_at,id LIMIT 1",params![project_id,source],|row|row.get(0)).optional().map_err(error)?.ok_or("The saved project has no matching answer revision. Open the answer as a new project before saving this audio.")?;
            let request = records(&self.connection, "SELECT length(CAST(data AS BLOB)),data FROM take_requests WHERE take_id=?1",
                [identifier(&original, "id")?], &mut budget)?.into_iter().next().ok_or("The answer generation request is missing.")?;
            budget.value(&original, 1)?;
            let mut take=original.clone();
            take["id"]=json!(uuid()?);
            take["projectId"]=json!(project_id);
            take["revisionId"]=json!(source_revision);
            take["createdAt"]=json!(timestamp());
            take["parentTakeId"]=Value::Null;
            take["reusedFromTakeId"]=original["id"].clone();
            if project["timeline"].as_array().is_some_and(Vec::is_empty) {
                project["timeline"]=json!([{"id":uuid()?,"takeId":take["id"],"start":0,"in":0,"out":take["asset"]["duration"],"gain":1,"fadeIn":0,"fadeOut":0,"track":0}]);
            }
            if project["selectedTakes"].get(answer_id).is_none() { project["selectedTakes"][answer_id]=take["id"].clone(); }
            let expected=project["revisionId"].as_str().ok_or("The saved answer project is damaged.")?.to_owned();
            return self.save_project_with_take(project,Some(&expected),Some((&take,&request)));
        }
        let temporary_project_id = uuid()?;
        let temporary_revision = uuid()?;
        let root_id = uuid()?;
        let original_id = identifier(&original,"id")?.to_owned();
        let mut audio = super::portable::collect_audio(self, vec![original], None, HashSet::new(), &mut budget)?;
        let original_root = audio.takes.iter().find(|take| take["id"] == original_id).ok_or("The answer take is missing.")?;
        budget.value(original_root, 1)?;
        budget.reserve(1024, 0)?;
        let mut root = original_root.clone();
        root["id"] = json!(root_id);
        root["projectId"] = json!(temporary_project_id);
        root["revisionId"] = json!(temporary_revision);
        root["parentTakeId"] = Value::Null;
        root["reusedFromTakeId"] = json!(original_id);
        root["createdAt"] = json!(timestamp());
        let duration = root["asset"]["duration"].clone();
        let request = audio.take_requests.get(&original_id).ok_or("The answer generation request is missing.")?;
        budget.value(request, 1)?;
        let root_request = request.clone();
        let profile = &request["profile"];
        let dictionaries = request["dictionaries"].as_array().ok_or("The answer pronunciation snapshot is invalid.")?;
        let references = array(&request["segment"], "referenceAssetIds", 256)?;
        let rights_values = references.iter().filter_map(Value::as_str)
            .map(|id| request["references"][id]["rights"].as_str().ok_or("The saved reference permission is missing."))
            .collect::<Result<Vec<_>,_>>()?;
        budget.value(&rights_values, 0)?;
        budget.value(references, 1)?;
        let rights = rights_values.join("\n");
        let voices = array(&request["segment"], "voiceIds", 256)?;
        if voices.len() > 1 { return Err("Save this multi-voice scene from a studio project so its cast remains explicit.".into()); }
        let mut cast = json!({"id":"narrator","name":"Narrator","referenceAssetIds":references,"direction":"","rightsEvidence":rights});
        if let Some(voice) = voices.first() {
            budget.value(voice, 1)?;
            cast["voiceId"] = voice.clone();
        }
        budget.value(&(title, source, session_id, answer_id, revision), 1)?;
        let now = timestamp();
        let project = json!({"id":temporary_project_id,"revisionId":temporary_revision,"parentRevisionId":null,"title":title,"source":source,"profileId":profile["id"],"cast":[cast],"createdAt":now,"updatedAt":now,"archived":false,"location":null,"timeline":[{"id":uuid()?,"takeId":root_id,"start":0,"in":0,"out":duration,"gain":1,"fadeIn":0,"fadeOut":0,"track":0}],"selectedTakes":{answer_id:root_id},"bookmarks":[],"variants":[],"answerOrigin":{"sessionId":session_id,"answerId":answer_id,"revision":revision}});
        budget.value(&project, 1)?;
        let archived_project = project.clone();
        budget.value(profile, 1)?;
        let profiles = Value::Array(vec![profile.clone()]);
        budget.value(profile, 1)?;
        budget.value(&temporary_revision, 0)?;
        let revision_profiles = Value::Object(serde_json::Map::from_iter([(temporary_revision.clone(), profile.clone())]));
        let mut current_dictionaries = Vec::new();
        let mut revision_dictionary_values = Vec::new();
        for dictionary in dictionaries {
            budget.value(dictionary, 1)?;
            current_dictionaries.push(dictionary.clone());
            budget.value(dictionary, 1)?;
            revision_dictionary_values.push(dictionary.clone());
        }
        budget.value(&temporary_revision, 0)?;
        let revision_dictionaries = Value::Object(serde_json::Map::from_iter([(temporary_revision, Value::Array(revision_dictionary_values))]));
        budget.value(&root_id, 1)?;
        budget.value(&root_id, 0)?;
        audio.takes.push(root);
        audio.take_requests.insert(root_id.clone(), root_request);
        let timing_results = timing_portable::collect(self, &audio.takes, &mut budget)?;
        let manifest = Value::Object(serde_json::Map::from_iter([
            ("schema".into(), Value::String("machdoch-speech-project".into())),
            ("version".into(), json!(1)),
            ("project".into(), archived_project),
            ("revisions".into(), Value::Array(vec![project])),
            ("profiles".into(), profiles),
            ("dictionaries".into(), Value::Array(current_dictionaries)),
            ("revisionProfiles".into(), revision_profiles),
            ("revisionDictionaries".into(), revision_dictionaries),
            ("takes".into(), Value::Array(audio.takes)),
            ("takeRequests".into(), Value::Object(audio.take_requests)),
            ("rootTakeIds".into(), Value::Array(vec![Value::String(root_id)])),
            ("assets".into(), Value::Object(audio.assets)),
            ("references".into(), Value::Object(audio.references)),
            ("originals".into(), Value::Array(audio.originals)),
            ("audioSources".into(), Value::Object(audio.audio_sources)),
            ("timingResults".into(), Value::Array(timing_results)),
        ]));
        self.commit_portable_snapshot_with_id(&manifest,project_id)
    }
}
