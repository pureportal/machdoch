use super::{store::AssetReservation,SpeechService};
use serde_json::Value;
use sha2::{Digest,Sha256};
use std::fs::File;
use std::io::{Read,Seek,SeekFrom};
use std::path::PathBuf;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub struct SpeechAssetReader {
    pub asset: Value,
    pub path: PathBuf,
    file: File,
    _reservation: AssetReservation,
}

impl SpeechAssetReader {
    pub fn read_bytes(&mut self, maximum: u64) -> Result<Vec<u8>,String> {
        self._reservation.ensure_live()?;
        let expected=self.asset["bytes"].as_u64().filter(|bytes|*bytes<=maximum).ok_or("Trim this audio within the upload size limit.")?;
        self.file.seek(SeekFrom::Start(0)).map_err(|_|"Speech audio could not seek.")?;
        let mut bytes=Vec::new();std::io::Read::by_ref(&mut self.file).take(maximum+1).read_to_end(&mut bytes).map_err(|_|"Speech audio could not be read.")?;
        if bytes.len() as u64!=expected || format!("{:x}",Sha256::digest(&bytes))!=self.asset["sha256"].as_str().ok_or("The audio digest is missing.")? { return Err("Speech audio changed during its upload integrity check.".into()); }
        self._reservation.ensure_live()?;
        Ok(bytes)
    }
}

pub fn retain(service: &Arc<SpeechService>, ids: &[String]) -> Result<AssetReservation,String> {
    service.with_store(|store| {
        let mut reservation=store.reserve_assets()?;
        reservation.retain(store,ids)?;
        Ok(reservation)
    })
}

pub fn open(service: &Arc<SpeechService>, id: &str, cancel: Option<&CancellationToken>) -> Result<SpeechAssetReader,String> {
    let reservation=retain(service,&[id.to_owned()])?;
    let (mut file,asset)=service.with_store(|store|store.asset_reader(id))?;
    let modified=file.metadata().and_then(|metadata|metadata.modified()).map_err(|_|"Stored audio metadata could not be read.")?;
    let expected=asset["bytes"].as_u64().ok_or("The stored audio byte length is invalid.")?;
    let mut digest=Sha256::new();let mut bytes=0u64;let mut buffer=[0u8;65536];
    loop {
        reservation.ensure_live()?;
        if cancel.is_some_and(CancellationToken::is_cancelled) { return Err("Speech cancelled.".into()); }
        let length=file.read(&mut buffer).map_err(|_|"Stored speech audio could not be read.")?;if length==0 { break; }
        bytes=bytes.checked_add(length as u64).filter(|value|*value<=expected).ok_or("Stored speech audio exceeded its recorded byte length.")?;digest.update(&buffer[..length]);
    }
    if bytes!=expected || format!("{:x}",digest.finalize())!=id { return Err("Stored speech audio failed its SHA-256 integrity check. Restore it before using it again.".into()); }
    if file.metadata().and_then(|metadata|metadata.modified()).map_err(|_|"Stored audio metadata could not be read.")?!=modified { return Err("Stored speech audio changed during verification. Restore it before using it again.".into()); }
    let path=PathBuf::from(asset["path"].as_str().ok_or("The stored audio path is invalid.")?);
    Ok(SpeechAssetReader{asset,path,file,_reservation:reservation})
}
