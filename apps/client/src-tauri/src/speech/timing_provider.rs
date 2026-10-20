use futures_util::StreamExt;
use serde_json::Value;
use sha2::{Digest,Sha256};
use std::path::{Path,PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool,Ordering};
use std::time::Duration;
use tokio::io::{AsyncReadExt};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

const ENDPOINT:&str="https://api.openai.com/v1/audio/transcriptions";
const MAX_UPLOAD:u64=20*1024*1024;
const MAX_RESPONSE:usize=8*1024*1024;

fn command(binary:&Path)->Command{
    let mut command=Command::new(binary);
    command.kill_on_drop(true).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]command.creation_flags(0x08000000);
    command
}

async fn run(mut command:Command,cancel:&CancellationToken)->Result<Vec<u8>,String>{
    let mut child=command.spawn().map_err(|_|"The pinned audio processor could not start.")?;
    let output=child.stdout.take().ok_or("Audio processor output is unavailable.")?;
    let errors=child.stderr.take().ok_or("Audio processor diagnostics are unavailable.")?;
    let work=async{
        let stdout=async{let mut bytes=Vec::new();output.take(128*1024+1).read_to_end(&mut bytes).await.map_err(|_|"Audio metadata could not be read.")?;if bytes.len()>128*1024{return Err("Audio metadata exceeded its local guard.".to_string());}Ok(bytes)};
        let stderr=async{let mut bytes=Vec::new();errors.take(128*1024+1).read_to_end(&mut bytes).await.map_err(|_|"Audio processor diagnostics could not be read.")?;if bytes.len()>128*1024{return Err("The audio processor exceeded its diagnostic guard.".to_string());}Ok(())};
        let status=async{child.wait().await.map_err(|_|"The audio processor could not finish.".to_string())};
        let (status,bytes,_)=tokio::try_join!(status,stdout,stderr)?;
        if !status.success(){return Err("Audio preprocessing failed. Restore the original take or reimport valid audio before retrying.".into());}
        Ok(bytes)
    };
    tokio::select!{biased;_=cancel.cancelled()=>Err("Transcription cancelled.".into()),result=tokio::time::timeout(Duration::from_secs(900),work)=>result.map_err(|_|"Audio preprocessing timed out.")?}
}

pub async fn verify_source(path:PathBuf,asset:Value,probe:&Path,cancel:&CancellationToken)->Result<(),String>{
    let source=path.clone();let expected=asset["sha256"].as_str().ok_or("The take audio hash is missing.")?.to_owned();
    let bytes=asset["bytes"].as_u64().ok_or("The take audio size is missing.")?;let token=cancel.clone();
    tokio::task::spawn_blocking(move||{
        use std::io::Read;
        let mut file=std::fs::File::open(source).map_err(|_|"The source take could not be opened.")?;
        if file.metadata().map_err(|_|"The source take could not be inspected.")?.len()!=bytes{return Err("The source take size changed. Restore the original audio.".to_string());}
        let mut hash=Sha256::new();let mut buffer=[0u8;65536];
        loop{if token.is_cancelled(){return Err("Transcription cancelled.".into());}let count=file.read(&mut buffer).map_err(|_|"The source take could not be verified.")?;if count==0{break;}hash.update(&buffer[..count]);}
        if format!("{:x}",hash.finalize())!=expected{return Err("The source take failed its audio integrity check. Restore the original audio.".into());}
        Ok(())
    }).await.map_err(|_|"Audio integrity verification could not finish.")??;
    let mut inspect=command(probe);inspect.args(["-v","error","-select_streams","a:0","-show_entries","stream=sample_rate,channels:format=duration","-of","json"]).arg(&path);
    let metadata:Value=serde_json::from_slice(&run(inspect,cancel).await?).map_err(|_|"The audio probe returned invalid metadata.")?;
    let stream=metadata["streams"].as_array().filter(|streams|streams.len()==1).and_then(|streams|streams.first()).ok_or("The source take has no readable audio stream.")?;
    let rate=stream["sample_rate"].as_str().and_then(|value|value.parse::<u64>().ok()).ok_or("The source sample rate is unavailable.")?;
    let duration=metadata["format"]["duration"].as_str().and_then(|value|value.parse::<f64>().ok()).filter(|value|value.is_finite()).ok_or("The source duration is unavailable.")?;
    if Some(rate)!=asset["sampleRate"].as_u64()||stream["channels"]!=asset["channels"]||(duration-asset["duration"].as_f64().ok_or("The saved take duration is invalid.")?).abs()>1.0/rate as f64{return Err("The source audio metadata differs from the saved take. Restore the original asset before transcription.".into());}
    Ok(())
}

pub async fn prepare(source:&Path,encoder:&Path,output:&Path,window:&Value,cancel:&CancellationToken)->Result<Value,String>{
    let from=window["from"].as_f64().ok_or("The transcription window is missing.")?;
    let duration=window["to"].as_f64().ok_or("The transcription window is missing.")?-from;
    let required=(duration*16000.0*2.0).ceil() as u64+65536;
    let directory=output.parent().ok_or("The transcription working directory is unavailable.")?;
    if crate::storage_space::available_storage_bytes(directory).ok_or("Available transcription working storage could not be measured.")?<required+64*1024*1024{return Err("Free working disk space before transcribing this take.".into());}
    let mut encode=command(encoder);
    encode.args(["-v","error","-nostdin","-n","-ss",&format!("{from:.9}"),"-i"]).arg(source).args(["-map","0:a:0","-vn","-t",&format!("{duration:.9}"),"-ar","16000","-ac","1","-c:a","pcm_s16le","-f","wav"]).arg(output);
    run(encode,cancel).await?;
    let metadata=std::fs::metadata(output).map_err(|_|"The transcription upload could not be inspected.")?;
    if metadata.len()>MAX_UPLOAD||metadata.len()==0{return Err("The transcription upload exceeded the local 20 MiB guard.".into());}
    let reader=super::wave_file::WaveReader::open(output)?;
    let spec=reader.spec();let actual=reader.frames() as f64/16000.0;
    if spec.sample_rate!=16000||spec.channels!=1||spec.bits_per_sample!=16||spec.sample_format!=hound::SampleFormat::Int||(actual-duration).abs()>1.0/16000.0{return Err("The prepared audio differs from its exact transcription window.".into());}
    let path=output.to_path_buf();
    let digest=tokio::task::spawn_blocking(move||{
        use std::io::Read;let mut file=std::fs::File::open(path).map_err(|_|"Prepared audio could not be opened.")?;let mut buffer=[0u8;65536];let mut digest=Sha256::new();loop{let count=file.read(&mut buffer).map_err(|_|"Prepared audio could not be hashed.")?;if count==0{break;}digest.update(&buffer[..count]);}Ok::<_,String>(format!("{:x}",digest.finalize()))
    }).await.map_err(|_|"Prepared audio verification could not finish.")??;
    Ok(serde_json::json!({"audioSha256":digest,"uploadDuration":actual}))
}

pub async fn transcribe(client:&reqwest::Client,key:&str,path:&Path,language:Option<&str>,cancel:&CancellationToken,dispatched:&AtomicBool)->Result<Value,String>{
    transcribe_at(client,ENDPOINT,key,path,language,cancel,dispatched).await
}

async fn transcribe_at(client:&reqwest::Client,endpoint:&str,key:&str,path:&Path,language:Option<&str>,cancel:&CancellationToken,dispatched:&AtomicBool)->Result<Value,String>{
    if cancel.is_cancelled(){return Err("Transcription cancelled.".into());}
    if key.trim().is_empty(){return Err("Configure the OpenAI API key before transcribing audio.".into());}
    let file=tokio::fs::File::open(path).await.map_err(|_|"Prepared audio could not be opened for upload.")?;
    let length=file.metadata().await.map_err(|_|"Prepared audio size is unavailable.")?.len();
    if length==0||length>MAX_UPLOAD{return Err("Keep each upload within the local 20 MiB guard.".into());}
    let stream=futures_util::stream::try_unfold(file,|mut file|async move{let mut bytes=vec![0u8;65536];let count=file.read(&mut bytes).await?;if count==0{Ok::<_,std::io::Error>(None)}else{bytes.truncate(count);Ok(Some((bytes,file)))}});
    let part=reqwest::multipart::Part::stream_with_length(reqwest::Body::wrap_stream(stream),length).file_name("speech.wav").mime_str("audio/wav").map_err(|_|"The transcription upload format is invalid.")?;
    let mut form=reqwest::multipart::Form::new().part("file",part).text("model",super::transcript_timing::MODEL).text("response_format","verbose_json").text("timestamp_granularities[]","word");
    if let Some(language)=language{form=form.text("language",language.to_owned());}
    let work=async{
        dispatched.store(true,Ordering::SeqCst);
        let response=client.post(endpoint).bearer_auth(key).timeout(Duration::from_secs(900)).multipart(form).send().await.map_err(|_|"The OpenAI transcription request was interrupted. Review usage before retrying.")?;
        let status=response.status();
        if !status.is_success(){let code=status.as_u16();if (400..500).contains(&code)&&code!=408{dispatched.store(false,Ordering::SeqCst);}return Err(if code==404{"The OpenAI transcription model is unavailable. Check account access before retrying.".into()}else{crate::speech_error::response_error("OpenAI",code)});}
        let mut chunks=response.bytes_stream();let mut bytes=Vec::new();
        while let Some(chunk)=chunks.next().await{let chunk=chunk.map_err(|_|"The transcription response was interrupted.")?;if bytes.len()+chunk.len()>MAX_RESPONSE{return Err("The transcription response exceeded its local guard. Align a shorter take.".into());}bytes.extend_from_slice(&chunk);}
        serde_json::from_slice(&bytes).map_err(|_|"The transcription provider returned invalid JSON. Review usage before retrying.".into())
    };
    tokio::select!{biased;_=cancel.cancelled()=>Err("Transcription cancelled.".into()),result=work=>result}
}

#[cfg(test)]
#[path="timing_provider_tests.rs"]
mod tests;
