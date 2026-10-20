use super::*;

#[test]
fn measured_reading_bookmarks_are_revision_pinned_and_remapped_with_portable_takes() {
    let directory=TestDirectory::new();let mut store=directory.open();
    let project=save(&mut store,&draft(),Value::Null).unwrap();
    let source=directory.0.join("measured.wav");
    let mut writer=hound::WavWriter::create(&source,hound::WavSpec{channels:1,sample_rate:8000,bits_per_sample:16,sample_format:hound::SampleFormat::Int}).unwrap();
    for _ in 0..8000 { writer.write_sample::<i16>(100).unwrap(); }writer.finalize().unwrap();
    let asset=store.put_asset(&source,"audio/wav",1.0,8000,1).unwrap();
    let mut take=take(&project,&asset);let request=generation_request(&mut take);
    store.put_take(&take).unwrap();
    store.connection.execute("INSERT INTO take_requests VALUES(?1,?2)",params![take["id"].as_str(),encode(&request).unwrap()]).unwrap();
    let mut edited=project.clone();edited["readingBookmarks"]=json!([{"id":"opening","label":"Opening","takeId":take["id"],"assetSha256":asset["sha256"],"seconds":0.75}]);
    let saved=save(&mut store,&edited,project["revisionId"].clone()).unwrap();
    let pin:i64=store.connection.query_row("SELECT count(*) FROM revision_takes WHERE revision_id=?1 AND take_id=?2",params![saved["revisionId"].as_str(),take["id"].as_str()],|row|row.get(0)).unwrap();assert_eq!(pin,1);
    drop(store);let mut store=directory.open();
    assert_eq!(store.execute("getProject",&json!({"id":project["id"]})).unwrap()["readingBookmarks"],saved["readingBookmarks"]);
    let snapshot=store.portable_snapshot(project["id"].as_str().unwrap(),saved["revisionId"].as_str().unwrap()).unwrap();
    let imported=store.commit_portable_snapshot(&snapshot).unwrap();
    let bookmark=&imported["readingBookmarks"][0];assert_ne!(bookmark["takeId"],take["id"]);assert_eq!(bookmark["assetSha256"],asset["sha256"]);assert_eq!(bookmark["seconds"],0.75);
    let loaded=store.timing_take(bookmark["takeId"].as_str().unwrap()).unwrap();assert_eq!(loaded["projectId"],imported["id"]);
    for (field,value) in [("assetSha256",json!("0".repeat(64))),("seconds",json!(1.01)),("takeId",json!("missing"))] {
        let mut damaged=snapshot.clone();let revision=damaged["revisions"].as_array_mut().unwrap().iter_mut().find(|value|value["revisionId"]==saved["revisionId"]).unwrap();
        revision["readingBookmarks"][0][field]=value.clone();damaged["project"]["readingBookmarks"][0][field]=value;
        assert!(store.validate_portable_snapshot(&damaged).is_err());
    }
}

#[test]
fn invalid_reading_bookmarks_cannot_create_a_revision() {
    let directory=TestDirectory::new();let mut store=directory.open();let project=save(&mut store,&draft(),Value::Null).unwrap();
    let bookmark=json!({"id":"mark","label":"Opening","takeId":"missing","assetSha256":"a".repeat(64),"seconds":0});
    for value in [json!([bookmark]),json!([bookmark,bookmark]),json!({}),json!([{"id":"empty","label":" ","takeId":"missing","assetSha256":"a".repeat(64),"seconds":0}])] {
        let mut edited=project.clone();edited["readingBookmarks"]=value;assert!(save(&mut store,&edited,project["revisionId"].clone()).is_err());
    }
    let count:i64=store.connection.query_row("SELECT count(*) FROM revisions",[],|row|row.get(0)).unwrap();assert_eq!(count,1);
}
