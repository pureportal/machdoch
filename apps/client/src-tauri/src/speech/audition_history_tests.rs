use super::*;

fn reviewed_project(store:&mut SpeechStore,directory:&TestDirectory,index:usize,language:&str,verdict:&str)->Value{
    let mut draft=draft();draft["id"]=json!(format!("project-{index}"));draft["title"]=json!(format!("Review project {index}"));draft["source"]=json!(format!("Private source {index}"));let mut project=save(store,&draft,Value::Null).unwrap();
    let asset=store.put_asset(&directory.audio(),"audio/wav",0.01,24000,1).unwrap();let mut take=take(&project,&asset);take["id"]=json!(format!("take-{index}"));let request=generation_request(&mut take);store.put_take(&take).unwrap();store.connection.execute("INSERT INTO take_requests VALUES(?1,?2)",params![take["id"].as_str().unwrap(),request.to_string()]).unwrap();
    project["voiceAuditions"]=json!([{"id":"review","takeId":take["id"],"voiceId":"voice","language":language,"reviewer":"Synthetic listener","reviewedAt":timestamp(),"listened":true,"verdict":verdict,"note":"Synthetic metadata; no model quality claim","assetId":asset["id"],"audioSha256":asset["sha256"],"requestHash":take["requestHash"],"backend":"fish-cloud","model":"drama-3","generatedAt":take["generatedAt"]}]);
    let previous=project["revisionId"].clone();save(store,&project,previous).unwrap()
}

#[test]
fn audition_history_pages_and_filters_cross_projects_without_returning_scripts_or_request_contents(){
    let directory=TestDirectory::new();let mut store=directory.open();reviewed_project(&mut store,&directory,0,"de-DE","approved");reviewed_project(&mut store,&directory,1,"de-AT","rejected");let mut archived=reviewed_project(&mut store,&directory,2,"en-US","approved");archived["archived"]=json!(true);let previous=archived["revisionId"].clone();save(&mut store,&archived,previous).unwrap();
    let all=store.execute("listVoiceReviews",&json!({"offset":0,"limit":2})).unwrap();let next=store.execute("listVoiceReviews",&json!({"offset":2,"limit":2})).unwrap();assert_eq!(all["total"],3);assert_eq!(next["reviews"].as_array().unwrap().len(),1);assert!(all["reviews"].as_array().unwrap().iter().all(|record|record["projectId"]!=next["reviews"][0]["projectId"]));
    let german=store.execute("listVoiceReviews",&json!({"language":"DE","offset":0,"limit":20})).unwrap();assert_eq!(german["total"],2);assert!(!german.to_string().contains("Private source"));assert!(!german.to_string().contains("spokenText"));assert!(!german.to_string().contains("references"));
    assert_eq!(store.execute("listVoiceReviews",&json!({"voiceId":"voice","language":"de","verdict":"approved","offset":0,"limit":20})).unwrap()["total"],1);
    assert_eq!(store.execute("listVoiceReviews",&json!({"voiceId":"missing","offset":0,"limit":20})).unwrap()["total"],0);
    store.execute("deleteProject",&json!({"id":"project-0"})).unwrap();assert_eq!(store.execute("listVoiceReviews",&json!({"language":"de","offset":0,"limit":20})).unwrap()["total"],1);
    for invalid in [json!({"limit":0,"offset":0}),json!({"limit":101,"offset":0}),json!({"limit":20,"offset":-1}),json!({"limit":20,"offset":0,"verdict":"invented"}),json!({"limit":20,"offset":0,"language":"de%"})]{assert!(store.execute("listVoiceReviews",&invalid).is_err());}
}

#[test]
fn audition_history_revalidates_the_actual_take_and_voice_request_instead_of_promoting_forged_metadata(){
    let directory=TestDirectory::new();let mut store=directory.open();reviewed_project(&mut store,&directory,0,"ja","approved");
    store.connection.execute("UPDATE projects SET data=json_set(data,'$.voiceAuditions[0].voiceId','invented-voice') WHERE id='project-0'",[]).unwrap();
    assert!(store.execute("listVoiceReviews",&json!({"offset":0,"limit":20})).unwrap_err().contains("exactly one provider voice"));
}
