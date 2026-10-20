use super::*;

const NOW:&str="2026-10-20T00:00:00.000Z";
fn metric(index:u64,milliseconds:u64)->Value{json!({"id":format!("00000000-0000-4000-8000-{index:012x}"),"sessionId":format!("11111111-0000-4000-8000-{index:012x}"),"atMs":10000,"event":"first-render","outputTransport":"pcm","timeToFirstAudioMs":milliseconds,"openToFirstAudioMs":milliseconds})}

#[test]
fn playback_measurements_persist_scoped_actual_percentiles_without_private_identifiers(){
    let directory=TestDirectory::new();let mut store=directory.open();
    let values=(1..=20).map(|value|metric(value,value)).collect::<Vec<_>>();store.record_playback_metrics(&json!({"owner":"PRIVATE_OWNER","samples":values}),NOW).unwrap();store.record_playback_metrics(&json!({"owner":"FOREIGN_OWNER","samples":[metric(100,999)]}),NOW).unwrap();drop(store);
    let mut store=directory.open();store.record_playback_metrics(&json!({"owner":"PRIVATE_OWNER","samples":[metric(20,20)]}),NOW).unwrap();let summary=store.playback_performance(Some("PRIVATE_OWNER")).unwrap();assert_eq!(summary["sampleCount"],20);let groups=summary["groups"].as_array().unwrap();let first=groups.iter().find(|value|value["metric"]=="timeToFirstAudioMs").unwrap();assert_eq!(first["count"],20);assert_eq!(first["p50"],10.0);assert_eq!(first["p95"],19.0);let encoded=summary.to_string();for private in ["PRIVATE_OWNER","FOREIGN_OWNER","sessionId","00000000-","11111111-"]{assert!(!encoded.contains(private));}
}

#[test]
fn playback_measurements_reject_private_fields_and_invalid_clocks_atomically(){
    let directory=TestDirectory::new();let mut store=directory.open();
    for field in ["script","voiceId","url","secret","owner"]{let mut value=metric(1,1);value[field]=json!("PRIVATE");assert!(store.record_playback_metrics(&json!({"owner":"owner","samples":[metric(2,2),value]}),NOW).is_err());}
    let mut invalid=metric(1,1);invalid["atMs"]=json!(-1);assert!(store.record_playback_metrics(&json!({"owner":"owner","samples":[invalid]}),NOW).is_err());
    let mut invalid=metric(1,1);invalid["id"]=json!("PRIVATE_SCRIPT");assert!(store.record_playback_metrics(&json!({"owner":"owner","samples":[invalid]}),NOW).is_err());
    assert_eq!(store.playback_performance(None).unwrap()["sampleCount"],0);
    let mut buffer=metric(1,0);buffer.as_object_mut().unwrap().remove("timeToFirstAudioMs");buffer.as_object_mut().unwrap().remove("openToFirstAudioMs");buffer["event"]=json!("pcm-buffer");buffer["sampleRate"]=json!(8000);buffer["maxBufferedFrames"]=json!(40000);buffer["maxBufferedAudioMs"]=json!(5000);buffer["underrunFrames"]=json!(128);buffer["underrunCount"]=json!(1);store.record_playback_metrics(&json!({"owner":"owner","samples":[buffer.clone()]}),NOW).unwrap();buffer["maxBufferedFrames"]=json!(40001);assert!(store.record_playback_metrics(&json!({"owner":"owner","samples":[buffer]}),NOW).is_err());
}

#[test]
fn playback_measurement_retention_expires_old_observations_and_bounds_each_owner(){
    let directory=TestDirectory::new();let mut store=directory.open();let transaction=store.connection.transaction().unwrap();
    for index in 1..=2020{let value=metric(index,index);transaction.execute("INSERT INTO speech_playback_measurements VALUES(?1,'owner',?2,'first-render',?3,?4)",params![value["id"].as_str(),value["sessionId"].as_str(),NOW,value.to_string()]).unwrap();}
    let old=metric(3000,0);transaction.execute("INSERT INTO speech_playback_measurements VALUES(?1,'old-owner',?2,'first-render','2026-09-01T00:00:00.000Z',?3)",params![old["id"].as_str(),old["sessionId"].as_str(),old.to_string()]).unwrap();transaction.commit().unwrap();
    store.record_playback_metrics(&json!({"owner":"owner","samples":[metric(4000,0)]}),NOW).unwrap();assert_eq!(store.playback_performance(Some("owner")).unwrap()["sampleCount"],2000);assert_eq!(store.playback_performance(Some("old-owner")).unwrap()["sampleCount"],0);
}
