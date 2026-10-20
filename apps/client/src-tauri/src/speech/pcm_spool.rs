use std::io::SeekFrom;
use std::path::{Path,PathBuf};
use std::time::Instant;
use tokio::io::{AsyncSeekExt,AsyncWriteExt};

pub(crate) struct PcmAudio{pub sample_rate:u32,pub channels:u16,pub frames:u64,pub first_audio_ms:Option<f64>}

pub(crate) struct PcmSpool{
    file:Option<tokio::fs::File>,path:PathBuf,bytes:u64,committed:bool,
    rate:u32,channels:u16,started:Instant,first_audio_ms:Option<f64>,
}

impl PcmSpool{
    pub(crate) fn create(path:&Path,rate:u32,channels:u16)->Result<Self,String>{
        super::pcm::wav_header_for(u64::from(channels)*2,rate,channels)?;
        let file=std::fs::OpenOptions::new().create_new(true).write(true).read(true).open(path).map_err(|_|"Could not create the speech WAV output; choose a new writable path.")?;
        Ok(Self{file:Some(tokio::fs::File::from_std(file)),path:path.into(),bytes:0,committed:false,rate,channels,started:Instant::now(),first_audio_ms:None})
    }
    fn file(&mut self)->Result<&mut tokio::fs::File,String>{self.file.as_mut().ok_or("Speech WAV output is closed.".into())}
    pub(crate) async fn reserve_header(&mut self)->Result<(),String>{self.file()?.write_all(&[0;44]).await.map_err(|_|"Could not write the speech WAV header.".into())}
    pub(crate) async fn append(&mut self,audio:&[u8])->Result<(),String>{
        let bytes=self.bytes.checked_add(audio.len() as u64).filter(|bytes|*bytes<=u64::from(u32::MAX-36)).ok_or("Speech exceeded the WAV output guard.")?;
        for fragment in audio.chunks(65_536){self.file()?.write_all(fragment).await.map_err(|_|"Could not write the speech audio. Check free storage.")?;}
        self.bytes=bytes;if bytes>=u64::from(self.channels)*2&&self.first_audio_ms.is_none(){self.first_audio_ms=Some(self.started.elapsed().as_secs_f64()*1000.0);}Ok(())
    }
    pub(crate) async fn finish(&mut self)->Result<PcmAudio,String>{
        let header=super::pcm::wav_header_for(self.bytes,self.rate,self.channels)?;let expected=self.bytes+44;let file=self.file()?;
        file.seek(SeekFrom::Start(0)).await.map_err(|_|"Could not finalize the speech WAV.")?;file.write_all(&header).await.map_err(|_|"Could not finalize the speech WAV.")?;file.flush().await.map_err(|_|"Could not flush the speech WAV.")?;file.sync_all().await.map_err(|_|"Could not save the speech WAV.")?;
        if file.metadata().await.map_err(|_|"Could not verify the speech WAV.")?.len()!=expected{return Err("Speech WAV sample count does not match its file length.".into());}
        Ok(PcmAudio{sample_rate:self.rate,channels:self.channels,frames:self.bytes/(u64::from(self.channels)*2),first_audio_ms:self.first_audio_ms})
    }
    pub(crate) fn retain(&mut self){self.committed=true;}
    pub(crate) async fn discard(&mut self)->Result<(),String>{
        let failed=if let Some(mut file)=self.file.take(){let failed=file.flush().await.is_err();drop(file);failed}else{false};tokio::fs::remove_file(&self.path).await.map_err(|_|"Incomplete speech output could not be removed.")?;self.committed=true;if failed{return Err("Writing incomplete speech output failed; the output was removed.".into());}Ok(())
    }
}

impl Drop for PcmSpool{fn drop(&mut self){if !self.committed{drop(self.file.take());if std::fs::remove_file(&self.path).is_err()&&self.path.exists(){eprintln!("Incomplete speech output could not be removed.");}}}}

#[cfg(test)]
mod tests{
    use super::*;
    #[tokio::test]
    async fn first_audio_requires_a_complete_frame_and_dynamic_format_is_finalized_exactly(){
        let path=std::env::temp_dir().join(format!("speech-pcm-measured-{}.wav",crate::speech::identifier().unwrap()));let mut spool=PcmSpool::create(&path,44100,2).unwrap();spool.reserve_header().await.unwrap();spool.append(&[0,0,0]).await.unwrap();assert!(spool.first_audio_ms.is_none());spool.append(&[0]).await.unwrap();let first=spool.first_audio_ms.unwrap();assert!(first>=0.0);spool.append(&[0,0,0,0]).await.unwrap();assert_eq!(spool.first_audio_ms,Some(first));let result=spool.finish().await.unwrap();assert_eq!(result.frames,2);assert_eq!(result.first_audio_ms,Some(first));assert_eq!(super::super::reference_audio::inspect_wav(&path).unwrap(),(2.0/44100.0,44100,2));spool.discard().await.unwrap();assert!(!path.exists());
    }
}
