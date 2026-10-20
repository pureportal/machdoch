use std::collections::{HashMap,HashSet};
use std::sync::Arc;
use std::time::{Duration,Instant};
use serde_json::Value;
use super::remote_assets::VerifiedAsset;

pub struct Session {
    pub epoch:u64,
    pub touched:Instant,
    pub cancel_on_disconnect:bool,
    pub assets:HashSet<String>,
    pub takes:HashSet<String>,
    pub verified_assets:HashMap<String,Arc<VerifiedAsset>>,
    pub downloads:HashMap<String,Value>,
    pub jobs:HashSet<String>,
    pub playback_leases:HashSet<String>,
}

impl Session {
    pub fn new(epoch:u64,cancel_on_disconnect:bool)->Self{
        Self{epoch,touched:Instant::now(),cancel_on_disconnect,assets:HashSet::new(),takes:HashSet::new(),verified_assets:HashMap::new(),downloads:HashMap::new(),jobs:HashSet::new(),playback_leases:HashSet::new()}
    }
}

pub fn expire_session(sessions:&mut HashMap<String,Session>,client:&str,epoch:u64)->Option<Session>{
    let session=sessions.get(client)?;
    if session.epoch!=epoch||session.touched.elapsed()<Duration::from_secs(45){return None;}
    sessions.remove(client)
}

pub fn epoch_session<'a>(sessions:&'a mut HashMap<String,Session>,client:&str,epoch:u64)->Result<&'a mut Session,String>{
    sessions.get_mut(client).filter(|session|session.epoch==epoch).ok_or("The speech session ended before the operation completed. Reconnect before reading audio or starting more work.".into())
}

pub fn authorize_take(session: &Session, operation: &str, value: &Value) -> Result<(), String> {
    let field = match operation {
        "updateTake" | "takeRequest" | "takeProvenance" => "id",
        "align" | "regenerate" | "listTimings" | "getTiming" => "takeId",
        _ => return Err("Unsupported remote take operation.".into()),
    };
    let id = value[field].as_str().ok_or("Choose a take.")?;
    if !session.takes.contains(id) { return Err("Open the requested take in this client's project first.".into()); }
    Ok(())
}

pub fn complete_session_operation(sessions: &mut HashMap<String, Session>, client: &str, epoch: u64, operation: &str, result: &Value) -> Result<(), String> {
    let session = epoch_session(sessions, client, epoch)?;
    if operation == "getTiming" { authorize_take(session, operation, result)?; }
    if operation=="retainPlayback"{session.playback_leases.insert(result["id"].as_str().ok_or("The playback lease ID is missing.")?.to_owned());}
    if matches!(operation, "render" | "retry" | "beginLive" | "align" | "regenerate" | "compareVoices" | "designVoice" | "createVoice") {
        session.jobs.insert(result["id"].as_str().ok_or("The speech job ID is missing.")?.to_string());
    }
    Ok(())
}

pub fn authorize_playback(session:&Session,input:&Value)->Result<(),String>{
    for id in input["assetIds"].as_array().ok_or("Choose playback assets.")?{
        if id.as_str().is_none_or(|id|!session.assets.contains(id)){return Err("Open the audio in this client's speech project before retaining playback.".into());}
    }
    Ok(())
}

#[cfg(test)]
mod tests{
    use super::*;
    use serde_json::json;
    #[test]
    fn playback_uses_explicit_asset_grants_and_stale_leases_cannot_attach_after_disconnect(){
        let mut session=Session::new(1,false);session.assets.insert("allowed".into());
        assert!(authorize_playback(&session,&json!({"assetIds":["allowed"]})).is_ok());assert!(authorize_playback(&session,&json!({"assetIds":["foreign"]})).is_err());
        let mut sessions=HashMap::from([("client".into(),session)]);complete_session_operation(&mut sessions,"client",1,"retainPlayback",&json!({"id":"player"})).unwrap();
        assert_eq!(sessions["client"].playback_leases,HashSet::from(["player".into()]));sessions.get_mut("client").unwrap().touched=Instant::now()-Duration::from_secs(46);
        let retired=expire_session(&mut sessions,"client",1).unwrap();assert!(!retired.cancel_on_disconnect);assert_eq!(retired.playback_leases,HashSet::from(["player".into()]));
        sessions.insert("client".into(),Session::new(2,false));assert!(complete_session_operation(&mut sessions,"client",1,"retainPlayback",&json!({"id":"late"})).is_err());assert!(sessions["client"].playback_leases.is_empty());
    }
    #[test]
    fn voice_requests_join_disconnect_ownership_and_stale_results_cannot_join_another_lease(){
        let mut sessions=HashMap::from([("client".to_owned(),Session::new(7,true))]);
        for (operation,id) in [("designVoice","design"),("createVoice","create")]{complete_session_operation(&mut sessions,"client",7,operation,&json!({"id":id})).unwrap();}
        assert_eq!(sessions["client"].jobs,HashSet::from(["design".to_owned(),"create".to_owned()]));
        sessions.insert("client".into(),Session::new(8,true));
        assert!(complete_session_operation(&mut sessions,"client",7,"designVoice",&json!({"id":"stale"})).is_err());assert!(sessions["client"].jobs.is_empty());
    }
    #[test]
    fn timing_requires_a_take_grant_and_results_cannot_disclose_another_clients_take(){
        let mut session=Session::new(1,true);session.takes.insert("owned".into());
        for operation in ["align","regenerate","listTimings","getTiming"]{
            assert!(authorize_take(&session,operation,&json!({"takeId":"owned"})).is_ok());
            assert!(authorize_take(&session,operation,&json!({"takeId":"other"})).is_err());
            assert!(authorize_take(&session,operation,&json!({"id":"owned"})).is_err());
        }
        for operation in ["takeRequest","takeProvenance","updateTake"]{assert!(authorize_take(&session,operation,&json!({"id":"owned"})).is_ok());assert!(authorize_take(&session,operation,&json!({"id":"other"})).is_err());}
        let mut sessions=HashMap::from([("client".into(),session)]);
        assert!(complete_session_operation(&mut sessions,"client",1,"getTiming",&json!({"id":"timing","takeId":"other"})).is_err());
        assert!(complete_session_operation(&mut sessions,"client",1,"getTiming",&json!({"id":"timing","takeId":"owned"})).is_ok());
        assert!(sessions["client"].jobs.is_empty());
    }
    #[test]
    fn timing_jobs_join_disconnect_cleanup_and_stale_completion_cannot_grant_a_new_lease(){
        let mut sessions=HashMap::from([("client".into(),Session::new(2,true))]);
        assert!(complete_session_operation(&mut sessions,"client",1,"align",&json!({"id":"old-job"})).is_err());
        assert!(sessions["client"].jobs.is_empty());
        complete_session_operation(&mut sessions,"client",2,"align",&json!({"id":"timing-job"})).unwrap();
        assert!(complete_session_operation(&mut sessions,"client",1,"regenerate",&json!({"id":"old-performance"})).is_err());
        complete_session_operation(&mut sessions,"client",2,"regenerate",&json!({"id":"performance-job"})).unwrap();
        assert!(complete_session_operation(&mut sessions,"client",1,"compareVoices",&json!({"id":"old-comparison"})).is_err());
        complete_session_operation(&mut sessions,"client",2,"compareVoices",&json!({"id":"comparison-job"})).unwrap();
        sessions.get_mut("client").unwrap().touched=Instant::now()-Duration::from_secs(46);
        let retired=expire_session(&mut sessions,"client",2).unwrap();
        assert_eq!(retired.jobs,HashSet::from(["timing-job".into(),"performance-job".into(),"comparison-job".into()]));assert!(retired.cancel_on_disconnect);
    }
    #[test]
    fn expired_cleanup_keeps_only_its_jobs_and_stale_completions_cannot_grant_to_a_new_lease(){
        let mut old=Session::new(1,true);
        old.touched=Instant::now()-Duration::from_secs(46);
        old.jobs.insert("old-job".into());
        let mut sessions=HashMap::from([("client".into(),old)]);
        let retired=expire_session(&mut sessions,"client",1).unwrap();
        sessions.insert("client".into(),Session::new(2,true));
        epoch_session(&mut sessions,"client",2).unwrap().jobs.insert("new-job".into());
        assert_eq!(retired.jobs,HashSet::from(["old-job".into()]));
        assert!(epoch_session(&mut sessions,"client",1).is_err());
        assert!(expire_session(&mut sessions,"client",1).is_none());
        assert_eq!(sessions["client"].jobs,HashSet::from(["new-job".into()]));
    }
    #[test]
    fn a_heartbeat_preserves_the_current_lease_and_retained_jobs_keep_their_disconnect_policy(){
        let mut sessions=HashMap::from([("client".into(),Session::new(1,false))]);
        assert!(expire_session(&mut sessions,"client",1).is_none());
        sessions.get_mut("client").unwrap().touched=Instant::now()-Duration::from_secs(46);
        assert!(!expire_session(&mut sessions,"client",1).unwrap().cancel_on_disconnect);
    }
}
