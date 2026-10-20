use super::*;

fn observed(id:&str,name:&str)->Value{
    let response=json!({"_id":id,"title":name,"visibility":"private","languages":["de"],"author":{"_id":"author-id","nickname":"Original author"},"samples":[{"audio":"https://samples.example/preview?temporary=not-for-export"}],"source":"voice_design"});
    super::super::super::voice_metadata::normalize(&response,false,"2026-10-20T00:00:00.000Z").unwrap()
}

#[test]
fn favorites_remain_discoverable_without_remote_catalog_rankings_or_credentials(){
    let directory=TestDirectory::new();let mut store=directory.open();
    for (id,name) in [("voice-a","A voice"),("voice-b","B voice")]{SpeechStore::record_voice_observation(&store.connection,&observed(id,name)).unwrap();store.execute("favoriteVoice",&json!({"id":id,"favorite":true})).unwrap();}
    store.execute("favoriteVoice",&json!({"id":"unobserved","favorite":true})).unwrap();
    let first=store.execute("listFavoriteVoices",&json!({"offset":0,"limit":1})).unwrap();assert_eq!(first["total"],3);assert_eq!(first["favorites"][0]["id"],"voice-a");assert_eq!(first["favorites"][0]["voice"]["favorite"],true);assert!(first["favorites"][0]["voice"]["previewUrl"].is_null());
    let second=store.execute("listFavoriteVoices",&json!({"offset":1,"limit":1,"language":"de"})).unwrap();assert_eq!(second["total"],2);assert_eq!(second["favorites"][0]["id"],"voice-b");
    let missing=store.execute("listFavoriteVoices",&json!({"offset":0,"limit":20,"search":"unobserved"})).unwrap();assert_eq!(missing["total"],1);assert!(missing["favorites"][0]["voice"].is_null());
    store.execute("favoriteVoice",&json!({"id":"voice-a","favorite":false})).unwrap();drop(store);let mut reopened=directory.open();assert_eq!(reopened.execute("listFavoriteVoices",&json!({"offset":0,"limit":20})).unwrap()["total"],2);
    for input in [json!({"offset":0}),json!({"offset":-1,"limit":1}),json!({"offset":0,"limit":101}),json!({"offset":0,"limit":null})]{assert!(reopened.execute("listFavoriteVoices",&input).is_err());}
    assert!(reopened.execute("favoriteVoice",&json!({"id":"voice-b","favorite":"false"})).is_err());
}

#[test]
fn voice_observations_pin_cast_and_overrides_without_signed_previews_and_survive_catalog_changes(){
    let directory=TestDirectory::new();let mut store=directory.open();
    let original=observed("first-voice","Original voice");let second=observed("second-voice","Second voice");
    SpeechStore::record_voice_observation(&store.connection,&original).unwrap();SpeechStore::record_voice_observation(&store.connection,&second).unwrap();
    let mut project=draft();project["cast"]=json!([{"id":"narrator","name":"Narrator","voiceId":"first-voice","referenceAssetIds":[],"direction":"","sceneOverrides":[{"sceneId":"scene","voiceId":"second-voice","referenceAssetIds":[],"direction":""}]}]);
    project["cast"].as_array_mut().unwrap().push(json!({"id":"guest","name":"Guest","voiceId":"second-voice","referenceAssetIds":[],"direction":""}));
    let saved=save(&mut store,&project,Value::Null).unwrap();assert_eq!(saved["cast"][0]["voiceObservation"]["name"],"Original voice");assert_eq!(saved["cast"][0]["sceneOverrides"][0]["voiceObservation"]["id"],"second-voice");assert!(saved["cast"][1].get("sceneOverrides").is_none());assert_eq!(saved["cast"][1]["voiceObservation"]["name"],"Second voice");
    let serialized=saved.to_string();for private in ["previewUrl","temporary=","not-for-export","favorite"]{assert!(!serialized.contains(private));}
    SpeechStore::record_voice_observation(&store.connection,&observed("first-voice","Changed catalog name")).unwrap();
    let mut revised=saved.clone();revised["title"]=json!("New title");let revised=save(&mut store,&revised,saved["revisionId"].clone()).unwrap();assert_eq!(revised["cast"][0]["voiceObservation"]["name"],"Original voice");
    let archive=store.portable_snapshot(revised["id"].as_str().unwrap(),revised["revisionId"].as_str().unwrap()).unwrap();let imported=store.commit_portable_snapshot(&archive).unwrap();assert_eq!(imported["cast"][0]["voiceObservation"],saved["cast"][0]["voiceObservation"]);
    let mut reassigned=revised.clone();reassigned["cast"][0]["voiceId"]=json!("second-voice");let reassigned=save(&mut store,&reassigned,revised["revisionId"].clone()).unwrap();assert_eq!(reassigned["cast"][0]["voiceObservation"]["id"],"second-voice");
    let mut inline=reassigned.clone();inline["cast"][0].as_object_mut().unwrap().remove("voiceId");let inline=save(&mut store,&inline,reassigned["revisionId"].clone()).unwrap();assert!(inline["cast"][0].get("voiceObservation").is_none());
}

#[test]
fn take_source_observations_are_immutable_portable_and_do_not_change_cache_identity(){
    let directory=TestDirectory::new();let mut store=directory.open();let project=save(&mut store,&draft(),Value::Null).unwrap();let asset=store.put_asset(&directory.audio(),"audio/wav",0.01,24_000,1).unwrap();
    SpeechStore::record_voice_observation(&store.connection,&observed("voice","Original source")).unwrap();
    let observations=store.voice_observations(&["voice".into()]).unwrap();
    let snapshot=json!({"profile":{"backend":"fish-cloud"},"voiceObservations":observations});let selected=SpeechStore::segment_voice_observations(&snapshot,&json!({"voiceIds":["voice"]})).unwrap();
    let mut recorded=take(&project,&asset);let request=generation_request(&mut recorded);assert_eq!(request["segment"]["voiceIds"],json!(["voice"]));recorded["voiceObservations"]=selected.clone();
    let mut running=job(&project,"running");store.put_job(&running).unwrap();running["state"]=json!("completed");running["completedSegments"]=json!(1);running["takeIds"]=json!([recorded["id"]]);store.put_completed_segment(&recorded,&running,&request).unwrap();
    let provenance=store.execute("takeProvenance",&json!({"id":recorded["id"]})).unwrap();assert_eq!(provenance["voiceObservations"],selected);
    SpeechStore::record_voice_observation(&store.connection,&observed("voice","Changed catalog source")).unwrap();let latest=store.voice_observations(&["voice".into()]).unwrap();assert_ne!(selected,latest);
    let mut reused=recorded.clone();reused["id"]=json!("cached-take");reused["reusedFromTakeId"]=recorded["id"].clone();store.put_take(&reused).unwrap();
    reused["id"]=json!("forged-cache-observation");reused["voiceObservations"]=latest;assert!(store.put_take(&reused).is_err());
    assert!(store.connection.execute("UPDATE takes SET data=json_set(data,'$.voiceObservations[0].name','forged') WHERE id=?1",[recorded["id"].as_str().unwrap()]).is_err());
    let mut wrong=recorded.clone();wrong["id"]=json!("foreign-voice");wrong["voiceObservations"][0]["id"]=json!("other");wrong["voiceObservations"][0]["evidence"]["url"]=json!("https://api.fish.audio/model/other");assert!(validate_take_request(&wrong,&request).is_err());
    store.connection.execute("INSERT INTO take_requests VALUES('cached-take',?1)",[request.to_string()]).unwrap();
    let archive=store.portable_snapshot(project["id"].as_str().unwrap(),project["revisionId"].as_str().unwrap()).unwrap();let imported=store.commit_portable_snapshot(&archive).unwrap();let takes=store.execute("listTakes",&json!({"projectId":imported["id"]})).unwrap();assert_eq!(takes.as_array().unwrap().len(),2);for take in takes.as_array().unwrap(){assert_eq!(take["voiceObservations"],selected);}
}

#[test]
fn admission_pins_available_voice_sources_and_does_not_require_observations_for_cache_replay(){
    let directory=TestDirectory::new();let mut store=directory.open();let mut profile=profile();profile["voiceId"]=json!("voice");profile["dictionaryIds"]=json!([]);store.execute("saveProfile",&json!({"profile":profile})).unwrap();
    SpeechStore::record_voice_observation(&store.connection,&observed("voice","Original source")).unwrap();
    let settings=json!({"connections":[{"backend":"fish-cloud","configured":true,"model":"drama-3","url":null,"runtimeVersion":null}],"cloudConsent":true,"pricing":null,"budgetLimit":null,"answerBudgetLimit":null,"answerCharacterLimit":1000});
    let input=json!({"owner":"chat:manual:source-observation","projectId":null,"revisionId":"answer","profileId":profile["id"],"segments":[{"id":"answer","text":"Hello.","spokenText":"Hello.","chapter":null,"voiceIds":[],"referenceAssetIds":[]}],"takes":1,"priority":100,"reuseCache":false,"cloudConsent":true,"budgetLimit":null});
    let mut admitted=super::super::super::admission::admit(&mut store,input.clone(),settings.clone(),timestamp(),"observed-job".into()).unwrap();
    let data:String=store.connection.query_row("SELECT snapshot FROM speech_requests WHERE job_id='observed-job'",[],|row|row.get(0)).unwrap();let snapshot=parse_json(data).unwrap();assert_eq!(snapshot["voiceObservations"][0]["name"],"Original source");assert_eq!(snapshot["input"]["segments"][0]["voiceIds"],json!(["voice"]));
    SpeechStore::record_voice_observation(&store.connection,&observed("voice","New source")).unwrap();assert_eq!(snapshot["voiceObservations"][0]["name"],"Original source");
    let take_observations=SpeechStore::segment_voice_observations(&snapshot,&snapshot["input"]["segments"][0]).unwrap();assert_eq!(take_observations[0]["name"],"Original source");
    let mut unknown=snapshot.clone();unknown["input"]["segments"][0]["voiceIds"]=json!(["unobserved"]);assert!(SpeechStore::segment_voice_observations(&unknown,&unknown["input"]["segments"][0]).unwrap().is_null());
    let asset=store.put_asset(&directory.audio(),"audio/wav",0.01,24_000,1).unwrap();let mut cached=take(&draft(),&asset);cached["projectId"]=Value::Null;cached["revisionId"]=json!("answer");cached["segmentId"]=json!("answer");cached["spokenText"]=json!("Hello.");cached["voiceObservations"]=take_observations;
    let request=json!({"segment":snapshot["input"]["segments"][0],"profile":snapshot["profile"],"dictionaries":snapshot["dictionaries"],"references":snapshot["references"],"connection":{"backend":"fish-cloud","model":"drama-3","url":null,"runtimeVersion":null}});cached["requestHash"]=json!(super::super::super::cache::request_hash(&request["segment"],&request["profile"],&request["dictionaries"],&request["references"],&request["connection"]).unwrap());
    admitted["state"]=json!("running");store.put_job(&admitted).unwrap();admitted["state"]=json!("completed");admitted["completedSegments"]=json!(1);admitted["takeIds"]=json!([cached["id"]]);store.put_completed_segment(&cached,&admitted,&request).unwrap();
    store.connection.execute("DELETE FROM speech_voice_observations",[]).unwrap();assert_eq!(store.voice_observations(&["voice".into()]).unwrap(),json!([]));
    let mut replay=input;replay["reuseCache"]=json!(true);replay["cloudConsent"]=json!(false);let mut offline=settings;offline["cloudConsent"]=json!(false);offline["connections"][0]["configured"]=json!(false);
    super::super::super::admission::admit(&mut store,replay,offline,timestamp(),"unobserved-job".into()).unwrap();let data:String=store.connection.query_row("SELECT snapshot FROM speech_requests WHERE job_id='unobserved-job'",[],|row|row.get(0)).unwrap();let replay=parse_json(data).unwrap();assert_eq!(replay["voiceObservations"],json!([]));assert_eq!(replay["cachedTakes"]["answer"],cached["id"]);assert_eq!(replay["billableBytesEstimate"],0);
    let mut unsafe_voice=observed("voice","Source");unsafe_voice["evidence"]["url"]=json!("https://api.fish.audio/model/voice?secret=not-allowed");assert!(SpeechStore::record_voice_observation(&store.connection,&unsafe_voice).is_err());
}
