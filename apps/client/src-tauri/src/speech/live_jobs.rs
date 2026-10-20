use super::{identifier, live_input, settings, timestamp, SpeechService};
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub fn begin(service: &Arc<SpeechService>, mut input: Value) -> Result<Value,String> {
    let maximum=input.as_object_mut().ok_or("Supply a live speech request.")?.remove("maxCharacters").and_then(|value|value.as_u64()).ok_or("Reserve a maximum answer character count.")?;
    let job=service.with_store(|store|{
        let settings=settings::settings(store)?;
        super::admission::admit_live(store,input,settings,timestamp(),identifier()?,maximum)
    })?;
    service.emit(&job);
    service.wake.notify_one();
    Ok(job)
}

pub fn text(service: Arc<SpeechService>, id: String, cancel: CancellationToken, direction: String) -> impl futures_util::Stream<Item=String> + Send {
    futures_util::stream::unfold((service,id,cancel,false,true,direction),|(service,id,cancel,finished,first,direction)|async move{
        if finished{return None;}
        loop {
            if cancel.is_cancelled(){return None;}
            let value=service.with_store(|store|live_input::consume(store,&id));
            match value {
                Ok(Some((mut text,finished)))=>{
                    if first&&!direction.is_empty(){text=format!("[{direction}]{text}");}
                    return Some((text,(service,id,cancel,finished,false,direction)));
                },
                Ok(None)=>tokio::select!{_=cancel.cancelled()=>return None,_=tokio::time::sleep(std::time::Duration::from_millis(40))=>{}},
                Err(message)=>{
                    use tauri::Emitter;
                    if service.app.emit("machdoch://speech-error",serde_json::json!({"jobId":id,"message":message})).is_err(){eprintln!("Live input failed; inspect Jobs.");}
                    cancel.cancel();
                    return None;
                },
            }
        }
    })
}
