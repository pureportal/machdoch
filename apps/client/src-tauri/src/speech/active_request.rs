use std::time::Instant;
use tokio_util::sync::CancellationToken;

pub struct ActiveRequest{
    owner:String,
    token:CancellationToken,
    started:Instant,
    cancellation:Option<(Instant,f64)>,
    ordinal:i64,
}

impl ActiveRequest{
    pub fn new(owner:String,token:CancellationToken,ordinal:i64)->Self{Self{owner,token,started:Instant::now(),cancellation:None,ordinal}}
    pub fn cancel(&mut self,owner:&str,entered:Instant)->Result<(),String>{
        if owner!=self.owner{return Err("The job does not belong to this speech owner.".into());}
        if self.cancellation.is_none(){let now=Instant::now();self.cancellation=Some((now,entered.elapsed().as_secs_f64()*1000.0));}
        self.token.cancel();Ok(())
    }
    pub fn measurements(&self)->serde_json::Value{
        serde_json::json!({"ordinal":self.ordinal,"workerRunningMs":self.started.elapsed().as_secs_f64()*1000.0,"cancellationInitiatedMs":self.cancellation.map(|(_,delay)|delay),"cancellationWorkerReleasedMs":self.cancellation.map(|(requested,_)|requested.elapsed().as_secs_f64()*1000.0)})
    }
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn active_cancellation_is_owner_scoped_and_does_not_need_the_metadata_store(){
        let token=CancellationToken::new();let mut request=ActiveRequest::new("owner".into(),token.clone(),1);let held_store=std::sync::Mutex::new(());let _guard=held_store.lock().unwrap();
        assert!(request.cancel("other",Instant::now()).is_err());assert!(!token.is_cancelled());assert!(request.measurements()["cancellationInitiatedMs"].is_null());
        request.cancel("owner",Instant::now()).unwrap();assert!(token.is_cancelled());let measured=request.measurements();assert!(measured["cancellationInitiatedMs"].as_f64().unwrap()<250.0);assert!(measured["cancellationWorkerReleasedMs"].as_f64().unwrap()>=0.0);let first=request.cancellation;request.cancel("owner",Instant::now()).unwrap();assert_eq!(first,request.cancellation);
    }
}
