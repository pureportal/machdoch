use super::*;

#[test]
fn project_duplication_remaps_audio_history_and_bookmarks_without_changing_the_source() {
    let directory=TestDirectory::new();let mut store=directory.open();let project=save(&mut store,&draft(),Value::Null).unwrap();
    let asset=store.put_asset(&directory.audio(),"audio/wav",0.01,24000,1).unwrap();
    let mut first=take(&project,&asset);let request=generation_request(&mut first);store.put_take(&first).unwrap();
    store.connection.execute("INSERT INTO take_requests VALUES(?1,?2)",params![first["id"].as_str(),encode(&request).unwrap()]).unwrap();
    let mut second=first.clone();second["id"]=json!("take-2");second["parentTakeId"]=first["id"].clone();store.put_take(&second).unwrap();
    store.connection.execute("INSERT INTO take_requests VALUES(?1,?2)",params![second["id"].as_str(),encode(&request).unwrap()]).unwrap();
    let mut edited=project.clone();edited["archived"]=json!(true);edited["selectedTakes"]=json!({"segment-1":"take-2"});
    edited["timeline"]=json!([{"id":"clip","takeId":"take-2","start":0,"in":0,"out":0.01,"gain":1,"fadeIn":0,"fadeOut":0,"track":0}]);
    edited["readingBookmarks"]=json!([{"id":"bookmark","label":"Passage","takeId":"take-2","assetSha256":asset["sha256"],"seconds":0.005}]);
    let source=save(&mut store,&edited,project["revisionId"].clone()).unwrap();
    let copy=store.execute("duplicateProject",&json!({"id":source["id"],"expectedRevisionId":source["revisionId"],"title":"Copied narration"})).unwrap();
    assert_ne!(copy["id"],source["id"]);assert_ne!(copy["revisionId"],source["revisionId"]);assert_eq!(copy["title"],"Copied narration");assert_eq!(copy["archived"],false);assert_eq!(copy["source"],source["source"]);assert_eq!(copy["location"],Value::Null);
    let selected=&copy["selectedTakes"]["segment-1"];assert_ne!(selected,"take-2");assert_eq!(copy["timeline"][0]["takeId"],*selected);assert_eq!(copy["readingBookmarks"][0]["takeId"],*selected);assert_eq!(copy["readingBookmarks"][0]["assetSha256"],asset["sha256"]);assert_eq!(copy["readingBookmarks"][0]["seconds"],0.005);
    let takes=store.execute("listTakes",&json!({"projectId":copy["id"]})).unwrap();let takes=takes.as_array().unwrap();assert_eq!(takes.len(),2);assert!(takes.iter().all(|take|take["asset"]==asset));
    let child=takes.iter().find(|take|take["id"]==*selected).unwrap();let parent=takes.iter().find(|take|take["id"]==child["parentTakeId"]).unwrap();assert_ne!(parent["id"],first["id"]);assert_eq!(store.execute("takeRequest",&json!({"id":child["id"]})).unwrap(),request);
    let history=store.execute("revisions",&json!({"projectId":copy["id"],"offset":0,"limit":20})).unwrap();assert_eq!(history["total"],2);
    assert_eq!(store.execute("getProject",&json!({"id":source["id"]})).unwrap(),source);
    store.execute("deleteProject",&json!({"id":copy["id"]})).unwrap();assert_eq!(store.execute("getProject",&json!({"id":source["id"]})).unwrap(),source);assert!(store.asset_path(asset["id"].as_str().unwrap()).is_ok());
}

#[test]
fn project_duplication_rejects_stale_revisions_and_invalid_names_before_creating_a_copy() {
    let directory=TestDirectory::new();let mut store=directory.open();let first=save(&mut store,&draft(),Value::Null).unwrap();let mut changed=first.clone();changed["source"]=json!("Changed source.");let latest=save(&mut store,&changed,first["revisionId"].clone()).unwrap();
    for (revision,title) in [(first["revisionId"].clone(),json!("Copy")),(latest["revisionId"].clone(),json!(" ")),(latest["revisionId"].clone(),json!("界".repeat(342)))] {
        assert!(store.execute("duplicateProject",&json!({"id":first["id"],"expectedRevisionId":revision,"title":title})).is_err());
    }
    assert_eq!(store.connection.query_row("SELECT count(*) FROM projects",[],|row|row.get::<_,i64>(0)).unwrap(),1);
}
