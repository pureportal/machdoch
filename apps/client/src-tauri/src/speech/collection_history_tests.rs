use super::*;

#[test]
fn project_pages_filter_before_limiting_keep_stable_order_and_do_not_materialize_scripts(){
    let directory=TestDirectory::new();let mut store=directory.open();
    for index in 0..25{let mut project=draft();project["id"]=json!(format!("project-{index:02}"));project["title"]=json!(format!("Item {index:02}"));project["source"]=json!(format!("PRIVATE_SCRIPT_{}{}",if index==23{"FindMeBySource"}else{""},"界".repeat(1000)));project["archived"]=json!(index%2==1);save(&mut store,&project,Value::Null).unwrap();}
    store.connection.execute("UPDATE projects SET updated_at='2026-10-20T00:00:00.000Z'",[]).unwrap();
    let first=store.execute("listProjects",&json!({"offset":0,"limit":5})).unwrap();let second=store.execute("listProjects",&json!({"offset":5,"limit":5})).unwrap();assert_eq!(first["total"],25);assert_eq!(first["projects"].as_array().unwrap().len(),5);assert_eq!(first["projects"][0]["id"],"project-00");assert_eq!(second["projects"][0]["id"],"project-05");assert!(!first.to_string().contains("PRIVATE_SCRIPT"));assert!(first.to_string().len()<4096);
    for project in first["projects"].as_array().unwrap(){assert_eq!(project.as_object().unwrap().len(),7);for body in ["source","cast","timeline","selectedTakes","variants"]{assert!(project.get(body).is_none());}}
    let found=store.execute("listProjects",&json!({"search":"FindMeBySource","archived":true,"offset":0,"limit":1})).unwrap();assert_eq!(found["total"],1);assert_eq!(found["projects"][0]["id"],"project-23");
    let exact=store.execute("listProjects",&json!({"id":"project-23","offset":0,"limit":1})).unwrap();assert_eq!(exact["projects"][0]["id"],"project-23");assert_eq!(exact["total"],1);
    assert_eq!(store.execute("listProjects",&json!({"archived":false,"offset":0,"limit":100})).unwrap()["total"],13);
    store.execute("deleteProject",&json!({"id":"project-23"})).unwrap();assert_eq!(store.execute("listProjects",&json!({"id":"project-23","offset":0,"limit":1})).unwrap()["total"],0);
}

#[test]
fn revision_pages_are_metadata_only_and_old_sources_restore_through_exact_project_scoped_ids(){
    let directory=TestDirectory::new();let mut store=directory.open();let mut original=draft();original["source"]=json!("PRIVATE_ORIGINAL_SOURCE Grüß dich 世界.");let original=save(&mut store,&original,Value::Null).unwrap();let mut current=original.clone();
    for index in 0..23{let mut changed=current.clone();changed["source"]=json!(format!("PRIVATE_SOURCE_{index}{}","界".repeat(1000)));current=save(&mut store,&changed,current["revisionId"].clone()).unwrap();}
    let page=store.execute("revisions",&json!({"projectId":original["id"],"offset":20,"limit":20})).unwrap();assert_eq!(page["total"],24);assert_eq!(page["revisions"].as_array().unwrap().len(),4);assert!(!page.to_string().contains("PRIVATE_"));for revision in page["revisions"].as_array().unwrap(){assert!(revision.get("source").is_none());}
    let detail=store.execute("getRevision",&json!({"projectId":original["id"],"revisionId":original["revisionId"]})).unwrap();assert_eq!(detail["source"],original["source"]);assert_eq!(detail["contentHash"],page["revisions"][3]["contentHash"]);
    let mut other=draft();other["id"]=json!("other-project");let other=save(&mut store,&other,Value::Null).unwrap();assert!(store.execute("getRevision",&json!({"projectId":other["id"],"revisionId":original["revisionId"]})).is_err());
    let restored=store.execute("restoreRevision",&json!({"projectId":original["id"],"revisionId":original["revisionId"],"expectedRevisionId":current["revisionId"]})).unwrap();assert_eq!(restored["source"],original["source"]);assert_ne!(restored["revisionId"],original["revisionId"]);
    drop(store);let mut reopened=directory.open();assert_eq!(reopened.execute("revisions",&json!({"projectId":original["id"],"offset":0,"limit":1})).unwrap()["total"],25);assert_eq!(reopened.execute("getRevision",&json!({"projectId":original["id"],"revisionId":original["revisionId"]})).unwrap(),detail);
}

#[test]
fn collection_history_rejects_missing_unbounded_or_injected_pages_and_unavailable_projects(){
    let directory=TestDirectory::new();let mut store=directory.open();let project=save(&mut store,&draft(),Value::Null).unwrap();
    for invalid in [json!({}),json!({"offset":0,"limit":0}),json!({"offset":0,"limit":101}),json!({"offset":-1,"limit":20}),json!({"offset":0.5,"limit":20}),json!({"offset":9007199254740992u64,"limit":20}),json!({"offset":0,"limit":20,"includeSources":true})]{
        assert!(store.execute("listProjects",&invalid).is_err());let mut revisions=invalid;revisions["projectId"]=project["id"].clone();assert!(store.execute("revisions",&revisions).is_err());
    }
    let empty=store.execute("listProjects",&json!({"offset":100,"limit":20})).unwrap();assert_eq!(empty["total"],1);assert_eq!(empty["projects"],json!([]));
    assert!(store.execute("revisions",&json!({"projectId":"missing","offset":0,"limit":20})).is_err());store.execute("deleteProject",&json!({"id":project["id"]})).unwrap();assert!(store.execute("getRevision",&json!({"projectId":project["id"],"revisionId":project["revisionId"]})).is_err());
}
