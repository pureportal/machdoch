use super::{store::{SpeechStore,StagedAsset},SpeechService};
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub fn import<T>(service: &Arc<SpeechService>, path: &Path, duration: f64, sample_rate: u32, channels: u16, cancel: Option<&CancellationToken>, commit: impl FnOnce(&mut SpeechStore,Value)->Result<T,String>) -> Result<T,String> {
    let mut reservation=service.with_store(|store|store.reserve_assets())?;
    let result=(|| {
        let stage=StagedAsset::from_file(&reservation,path,"audio/wav",duration,sample_rate,channels,cancel)?;
        service.with_store(|store|reservation.protect(store,&[stage.id().to_owned()]))?;
        let published=stage.publish(&reservation,cancel)?;
        service.with_store(|store| {
            if cancel.is_some_and(CancellationToken::is_cancelled) { return Err("Speech cancelled.".into()); }
            let asset=store.commit_staged_asset(&reservation,&published)?;
            commit(store,asset)
        })
    })();
    let released=service.with_store(|store|reservation.release(store));
    match (result,released) {
        (Ok(value),Ok(())) => Ok(value),
        (Err(error),Ok(())) | (Ok(_),Err(error)) => Err(error),
        (Err(error),Err(cleanup)) => Err(format!("{error} {cleanup}")),
    }
}
