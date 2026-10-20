use super::*;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
#[path="long_form_tests.rs"]
mod long_form;

struct Fixture {
    directory: PathBuf,
    service: Arc<SpeechService>,
    project: Value,
    take_ids: Vec<String>,
    _cleanup: Cleanup,
}

struct Cleanup(PathBuf);

#[tokio::test]
async fn selected_asr_timing_exports_measured_subtitles_and_preserves_original_archive_take(){
    let fixture=Fixture::new();
    let take=fixture.service.with_store(|store|Ok(store.execute("listTakes",&json!({"projectId":fixture.project["id"]}))?.as_array().unwrap().iter().find(|take|take["id"]==fixture.take_ids[0]).unwrap().clone())).unwrap();
    let saved=fixture.service.with_store(|store|{
        let input=json!({"owner":"timing-export-test","takeId":take["id"],"provider":"openai","model":"whisper-1","language":null,"pricing":null,"budgetLimit":null,"cloudConsent":true,"reuseCache":false});
        let mut job=store.admit_timing(input,&json!({"cloudConsent":true,"budgetLimit":null}),&"f".repeat(64),true,timestamp(),"timing-job".into())?;
        job["state"]=json!("running");store.put_job(&job)?;
        let duration=take["asset"]["duration"].as_f64().unwrap();let window=crate::transcript_timing::chunks(duration)?[0].clone();
        let mut chunk=crate::transcript_timing::parse_chunk(&json!({"text":"Measured.","words":[{"word":"Measured.","start":0.25,"end":0.75}]}),&window,duration)?;
        let measured=timestamp();chunk["window"]=window.clone();chunk["audioSha256"]=json!("a".repeat(64));chunk["uploadDuration"]=json!(duration);chunk["admittedAt"]=job["createdAt"].clone();chunk["receivedAt"]=json!(measured);
        job["completedSegments"]=json!(1);store.put_timing_chunk(&job,0,&chunk)?;
        let record=json!({"id":"export-timing","takeId":take["id"],"assetId":take["asset"]["id"],"assetSha256":take["asset"]["sha256"],"provider":"openai","model":"whisper-1","languageHint":null,"transcript":"Measured.","words":chunk["words"],"createdAt":timestamp(),"measuredAt":measured,"jobId":"timing-job","requestHash":crate::transcript_timing::request_hash(take["asset"]["sha256"].as_str().unwrap(),None,&"f".repeat(64)),"provenance":{"encoderSha256":"f".repeat(64),"sourceDuration":duration,"admittedAt":job["createdAt"],"sampleRate":16000,"channels":1,"pipeline":1,"chunks":[{"window":window,"audioSha256":chunk["audioSha256"],"responseSha256":chunk["responseSha256"],"uploadDuration":duration,"providerText":chunk["providerText"],"language":null,"usage":null}]},"pricing":null,"estimatedCost":null,"reusedFromTimingId":null});
        job["timingId"]=json!("export-timing");store.put_timing(&record,&job)?;job["state"]=json!("completed");store.put_job(&job)?;
        let mut project=fixture.project.clone();project["timingSelections"]=json!({(take["id"].as_str().unwrap()):"export-timing"});
        store.execute("saveProject",&json!({"project":project,"expectedRevisionId":fixture.project["revisionId"]}))
    }).unwrap();
    let base=json!({"projectId":saved["id"],"revisionId":saved["revisionId"],"takeIds":[take["id"]],"format":"srt","sampleRate":24000,"channels":1,"bitrate":128000,"loudnessLufs":null,"truePeakDb":null,"overwrite":false});
    let mut input=base.clone();let srt=fixture.directory.join("measured.srt");input["outputPath"]=json!(srt);
    exports::execute(&fixture.service,"export",&input).await.unwrap();
    let subtitles=std::fs::read_to_string(srt).unwrap();assert!(subtitles.contains("00:00:00,250 --> 00:00:00,750"));assert!(subtitles.contains("Measured."));
    let transcript=fixture.directory.join("measured.json");input["format"]=json!("json");input["outputPath"]=json!(transcript);exports::execute(&fixture.service,"export",&input).await.unwrap();
    let exported:Value=serde_json::from_slice(&std::fs::read(transcript).unwrap()).unwrap();assert_eq!(exported["timingResults"][0]["model"],"whisper-1");assert_eq!(exported["clips"][0]["take"]["alignment"][0]["text"],"Measured.");
    let archive=fixture.service.with_store(|store|store.portable_snapshot(saved["id"].as_str().unwrap(),saved["revisionId"].as_str().unwrap())).unwrap();
    assert_eq!(archive["takes"].as_array().unwrap().iter().find(|item|item["id"]==take["id"]).unwrap()["alignment"],take["alignment"]);
    assert_eq!(archive["timingResults"][0]["words"][0]["text"],"Measured.");
    let raw=fixture.service.with_store(|store|store.timing_take(take["id"].as_str().unwrap())).unwrap();assert_eq!(raw,take);
}

fn decoded_samples(path:&std::path::Path)->Vec<f32>{
    let output=std::process::Command::new(exports::encoder().unwrap()).args(["-v","error","-i"]).arg(path).args(["-map","0:a:0","-ar","24000","-ac","1","-f","f32le","-"]).output().unwrap();
    assert!(output.status.success());
    output.stdout.chunks_exact(4).map(|sample|f32::from_le_bytes(sample.try_into().unwrap())).collect()
}

#[tokio::test]
async fn imported_audio_validates_decoded_sources_preserves_originals_and_permission(){
    let fixture=Fixture::new();
    let source=fixture.directory.join("source-0.wav");
    let digest=exports::hash_file(&source).unwrap();
    assert!(audio_import::import(&fixture.service,&json!({"path":source,"rightsEvidence":""})).await.is_err());
    for format in ["wav","mp3","flac"]{
        let path=if format=="wav"{source.clone()}else{
            let target=fixture.directory.join(format!("import.{format}"));
            assert!(std::process::Command::new(exports::encoder().unwrap()).args(["-v","error","-nostdin","-i"]).arg(&source).arg(&target).status().unwrap().success());target
        };
        let imported=audio_import::import(&fixture.service,&json!({"path":path,"rightsEvidence":"Self-created synthetic test recording"})).await.unwrap();
        assert_eq!(imported["provenance"]["sourceSha256"],exports::hash_file(&path).unwrap());
        assert_eq!(imported["asset"]["sampleRate"],24_000);
        assert_eq!(imported["asset"]["channels"],1);
        assert!((imported["asset"]["duration"].as_f64().unwrap()-1.0).abs()<0.15);
        assert_eq!(exports::hash_file(&source).unwrap(),digest);
    }
    let damaged=fixture.directory.join("invalid.wav");std::fs::write(&damaged,b"This is not audio").unwrap();
    assert!(audio_import::import(&fixture.service,&json!({"path":damaged,"rightsEvidence":"Synthetic test"})).await.is_err());
    assert!(std::fs::read_dir(fixture.service.with_store(|store|Ok(store.root.clone())).unwrap()).unwrap().all(|entry|!entry.unwrap().file_name().to_string_lossy().starts_with("audio-")));
}

#[tokio::test]
async fn background_mix_ducks_only_to_voices_and_range_matches_full_fades_and_envelope(){
    let fixture=Fixture::new();
    let source=fixture.directory.join("background.wav");
    let mut writer=hound::WavWriter::create(&source,hound::WavSpec{channels:1,sample_rate:24000,bits_per_sample:32,sample_format:hound::SampleFormat::Float}).unwrap();
    for _ in 0..72000{writer.write_sample(0.1f32).unwrap();}writer.finalize().unwrap();
    let imported=audio_import::import(&fixture.service,&json!({"path":source,"rightsEvidence":"Self-created synthetic music bus"})).await.unwrap();
    let mut project=fixture.project.clone();
    project["timeline"]=json!([{"id":"voice","takeId":fixture.take_ids[0],"start":0.5,"in":0,"out":1,"gain":0.5,"fadeIn":0,"fadeOut":0,"track":0}]);
    project["backgroundTracks"]=json!([{"id":"music","assetId":imported["asset"]["id"],"name":"Music","role":"music","start":0,"in":0,"out":3,"gain":1,"fadeIn":0.4,"fadeOut":0.4,"track":1,"ducking":{"thresholdDbfs":-36,"reductionDb":-18,"attackMs":5,"releaseMs":50}}]);
    project["exportSettings"]=json!({"format":"wav","sampleRate":24000,"channels":1,"bitrate":128000,"loudnessLufs":null,"truePeakDb":null});
    let saved=fixture.service.with_store(|store|store.execute("saveProject",&json!({"project":project,"expectedRevisionId":fixture.project["revisionId"]}))).unwrap();
    let preview=json!({"projectId":saved["id"],"revisionId":saved["revisionId"],"takeIds":[],"sampleRate":24000,"channels":1,"loudnessLufs":null,"truePeakDb":null,"includeBackground":true,"reuseCache":true});
    let full=exports::execute(&fixture.service,"previewTimeline",&preview).await.unwrap();
    let cached=exports::execute(&fixture.service,"previewTimeline",&preview).await.unwrap();
    assert_eq!(full,cached);
    let samples=decoded_samples(std::path::Path::new(full["asset"]["path"].as_str().unwrap()));
    assert_eq!(samples.len(),72000);
    let mean=|from:usize,to:usize|samples[from..to].iter().copied().sum::<f32>()/(to-from)as f32;
    assert!((mean(10800,11760)-0.1).abs()<0.002);
    assert!(mean(24000,26400)<0.02,"Music must attenuate under the voice bus");
    assert!((mean(55200,60000)-0.1).abs()<0.002,"Music must recover after voice release");
    let mut range=preview.clone();range["range"]=json!({"from":0.2,"to":2.8});
    let selected=exports::execute(&fixture.service,"previewTimeline",&range).await.unwrap();
    let selected_samples=decoded_samples(std::path::Path::new(selected["asset"]["path"].as_str().unwrap()));
    assert_eq!(selected_samples.len(),62400);
    assert!(selected_samples.iter().zip(&samples[4800..67200]).all(|(a,b)|(a-b).abs()<0.000001),"Range must retain the full mix's fades and ducking history");
    let jobs=fixture.service.with_store(|store|store.execute("listJobs",&json!({}))).unwrap();assert!(jobs.as_array().unwrap().is_empty());
    let mut archive=fixture.request("archive");archive["revisionId"]=saved["revisionId"].clone();archive["takeIds"]=json!([]);
    let bundle=exports::execute(&fixture.service,"export",&archive).await.unwrap();
    let restored=exports::execute(&fixture.service,"importProject",&json!({"path":bundle["path"]})).await.unwrap();
    assert_eq!(restored["backgroundTracks"],saved["backgroundTracks"]);assert_eq!(restored["exportSettings"],saved["exportSettings"]);
    let origins=fixture.service.with_store(|store|store.connection.query_row("SELECT data FROM speech_audio_sources WHERE asset_id=?1",[imported["asset"]["id"].as_str()],|row|row.get::<_,String>(0)).map_err(|e|e.to_string())).unwrap();assert!(origins.contains("Self-created synthetic music bus"));
    let mut invalid=preview.clone();invalid["range"]=json!({"from":0,"to":4});assert!(exports::execute(&fixture.service,"previewTimeline",&invalid).await.is_err());
    invalid=preview.clone();invalid["truePeakDb"]=json!(-1);assert!(exports::execute(&fixture.service,"previewTimeline",&invalid).await.is_err());
}

#[tokio::test]
async fn explicit_clip_exports_preserve_trims_and_fades_and_exclude_other_clips_and_background(){
    let fixture=Fixture::new();
    let source=fixture.directory.join("batch-music.wav");
    let mut writer=hound::WavWriter::create(&source,hound::WavSpec{channels:1,sample_rate:24000,bits_per_sample:32,sample_format:hound::SampleFormat::Float}).unwrap();
    for _ in 0..144000{writer.write_sample(0.1f32).unwrap();}writer.finalize().unwrap();
    let imported=audio_import::import(&fixture.service,&json!({"path":source,"rightsEvidence":"Synthetic batch export check"})).await.unwrap();
    let mut project=fixture.project.clone();
    project["timeline"]=json!([{"id":"chosen","takeId":fixture.take_ids[0],"start":2,"in":0.25,"out":0.75,"gain":0.5,"fadeIn":0.05,"fadeOut":0.05,"track":0},{"id":"other","takeId":fixture.take_ids[1],"start":4,"in":0,"out":1,"gain":1,"fadeIn":0,"fadeOut":0,"track":0}]);
    project["backgroundTracks"]=json!([{"id":"music","assetId":imported["asset"]["id"],"name":"Music","role":"music","start":0,"in":0,"out":6,"gain":1,"fadeIn":0,"fadeOut":0,"track":1,"ducking":null}]);
    let saved=fixture.service.with_store(|store|store.execute("saveProject",&json!({"project":project,"expectedRevisionId":fixture.project["revisionId"]}))).unwrap();
    let request=json!({"projectId":saved["id"],"revisionId":saved["revisionId"],"takeIds":[],"clipIds":["chosen"],"range":{"from":2,"to":2.5},"sampleRate":24000,"channels":1,"loudnessLufs":null,"truePeakDb":null,"includeBackground":false,"reuseCache":true});
    let result=exports::execute(&fixture.service,"previewTimeline",&request).await.unwrap();
    let samples=decoded_samples(std::path::Path::new(result["asset"]["path"].as_str().unwrap()));
    assert_eq!(samples.len(),12000);assert!(samples.iter().copied().sum::<f32>().abs()/(samples.len()as f32)<0.0001);
    assert!(samples.iter().copied().map(f32::abs).fold(0.0,f32::max)<0.123);
    assert!(samples[..120].iter().all(|sample|sample.abs()<0.013));
    let mut wrong=request.clone();wrong["clipIds"]=json!(["missing"]);assert!(exports::execute(&fixture.service,"previewTimeline",&wrong).await.is_err());
    wrong=request.clone();wrong["takeIds"]=json!([fixture.take_ids[0]]);assert!(exports::execute(&fixture.service,"previewTimeline",&wrong).await.is_err());
}

impl Drop for Cleanup {
    fn drop(&mut self) { std::fs::remove_dir_all(&self.0).unwrap(); }
}

impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!("speech-export-{}", identifier().unwrap()));
        std::fs::create_dir_all(&directory).unwrap();
        let mut store = SpeechStore::open(directory.join("store")).unwrap();
        let project = store.execute("saveProject", &json!({"expectedRevisionId":null,"project":{"id":"book","title":"Synthetic export fixture","source":"# Arrival\nHello world.\n# Departure\nAuf Wiedersehen.","cast":[],"profileId":null,"revisionId":"","parentRevisionId":null,"createdAt":"","updatedAt":"","archived":false,"location":null,"timeline":[],"selectedTakes":{},"bookmarks":[],"variants":[]}})).unwrap();
        let mut take_ids = Vec::new();
        for (index, title, text) in [(0, "Arrival", "Hello world."), (1, "Departure", "Auf Wiedersehen.")] {
            let path = directory.join(format!("source-{index}.wav"));
            let mut writer = hound::WavWriter::create(&path, hound::WavSpec { channels:1, sample_rate:24_000, bits_per_sample:16, sample_format:hound::SampleFormat::Int }).unwrap();
            for sample in 0..24_000 { writer.write_sample(((sample as f64*std::f64::consts::TAU*440.0/24_000.0).sin()*8000.0) as i16).unwrap(); }
            writer.finalize().unwrap();
            let asset = store.put_asset(&path, "audio/wav", 1.0, 24_000, 1).unwrap();
            let id = format!("take-{index}");
            let now = timestamp();
            let request=json!({"segment":{"id":format!("segment-{index}"),"text":text,"spokenText":text,"chapter":{"id":format!("chapter-{index}"),"title":title},"voiceIds":["synthetic-fixture"],"referenceAssetIds":[]},"profile":{"id":"fixture","name":"Synthetic export fixture","backend":"fish-cloud","model":"drama-3","direction":"","temperature":0.7,"topP":0.7,"chunkLength":300,"minChunkLength":50,"latency":"normal","dictionaryIds":[],"playbackRate":1},"dictionaries":[],"references":{},"connection":{"backend":"fish-cloud","model":"drama-3","url":null,"runtimeVersion":null}});
            let hash=crate::cache::request_hash(&request["segment"],&request["profile"],&request["dictionaries"],&request["references"],&request["connection"]).unwrap();
            store.put_take(&json!({"id":id,"projectId":project["id"],"revisionId":project["revisionId"],"segmentId":format!("segment-{index}"),"spokenText":text,"chapter":{"id":format!("chapter-{index}"),"title":title},"asset":asset,"createdAt":now,"generatedAt":now,"reusedFromTakeId":null,"backend":"fish-cloud","model":"drama-3","requestHash":hash,"parentTakeId":null,"favorite":false,"rating":null,"note":"","alignment":[{"text":text,"start":0.0,"end":1.0}]})).unwrap();
            store.connection.execute("INSERT INTO take_requests VALUES(?1,?2)",rusqlite::params![id,request.to_string()]).unwrap();
            take_ids.push(id);
        }
        let cleanup = Cleanup(directory.clone());
        Self { directory, service:Arc::new(SpeechService { store:Mutex::new(store), app:crate::TestApp }), project, take_ids, _cleanup:cleanup }
    }

    fn request(&self, format: &str) -> Value {
        json!({"projectId":self.project["id"],"takeIds":self.take_ids,"format":format,"outputPath":self.directory.join(format!("export.{format}")),"overwrite":false,"sampleRate":24_000,"channels":1,"bitrate":128000,"loudnessLufs":null,"truePeakDb":null})
    }

    fn chat_audio(&self) -> Value {
        self.service.with_store(|store| {
            let takes=store.execute("listTakes",&json!({"projectId":self.project["id"]}))?;
            let mut take=takes.as_array().unwrap().iter().find(|take|take["id"]==self.take_ids[0]).unwrap().clone();
            let mut request=store.execute("takeRequest",&json!({"id":take["id"]}))?;
            take["id"]=json!("chat-take");
            take["projectId"]=Value::Null;
            take["revisionId"]=json!("answer-revision");
            take["segmentId"]=json!("answer-1");
            take["chapter"]=Value::Null;
            request["segment"]["id"]=take["segmentId"].clone();
            request["segment"]["chapter"]=Value::Null;
            take["requestHash"]=json!(crate::cache::request_hash(&request["segment"],&request["profile"],&request["dictionaries"],&request["references"],&request["connection"])?);
            let now=timestamp();
            let mut job=json!({"id":"chat-job","owner":"chat:session","projectId":null,"revisionId":"answer-revision","state":"running","completedSegments":0,"totalSegments":1,"takeIds":[],"error":null,"createdAt":now,"updatedAt":now,"priority":100,"attempt":1,"parentJobId":null});
            store.put_job(&job)?;
            job["state"]=json!("completed");job["completedSegments"]=json!(1);job["takeIds"]=json!([take["id"]]);
            store.put_completed_segment(&take,&job,&request)?;
            Ok(take)
        }).unwrap()
    }

    fn save_answer_input(&self) -> Value {
        json!({"owner":"chat:session","alternateOwner":"chat:auto:session","answerId":"answer-1","revision":"answer-revision","sessionId":"session","source":"Hello world.","title":"Saved answer"})
    }
}

#[tokio::test]
async fn archive_streaming_digest_rejects_same_length_corruption_before_publishing(){
    let fixture=Fixture::new();
    let path=fixture.service.with_store(|store|{
        let take=store.execute("listTakes",&json!({"projectId":fixture.project["id"]}))?[0].clone();
        store.asset_path(take["asset"]["id"].as_str().unwrap())
    }).unwrap();
    let mut bytes=std::fs::read(&path).unwrap();let last=bytes.len()-1;bytes[last]^=1;std::fs::write(&path,bytes).unwrap();
    let input=fixture.request("archive");let error=exports::execute(&fixture.service,"export",&input).await.unwrap_err();
    assert!(error.contains("changed while it was being archived"),"{error}");
    assert!(!std::path::Path::new(input["outputPath"].as_str().unwrap()).exists());
}

#[tokio::test]
async fn archive_rejects_cloning_only_permission_before_writing_and_preserves_explicit_redistribution_evidence(){
    let fixture=Fixture::new();
    let saved=fixture.service.with_store(|store|{
        let asset=store.execute("listTakes",&json!({"projectId":fixture.project["id"]}))?[0]["asset"].clone();
        store.connection.execute("INSERT INTO speech_references VALUES(?1,'Synthetic reference sentence','Cloning permission only')",[asset["id"].as_str().unwrap()]).map_err(|error|error.to_string())?;
        let mut project=fixture.project.clone();project["cast"]=json!([{"id":"narrator","name":"Narrator","referenceAssetIds":[asset["id"]],"direction":"","rightsEvidence":"Cloning permission only"}]);
        store.execute("saveProject",&json!({"project":project,"expectedRevisionId":fixture.project["revisionId"]}))
    }).unwrap();
    let mut request=fixture.request("archive");request["revisionId"]=saved["revisionId"].clone();
    assert!(exports::execute(&fixture.service,"export",&request).await.unwrap_err().contains("redistribute"));assert!(!std::path::Path::new(request["outputPath"].as_str().unwrap()).exists());
    let inventory=fixture.service.with_store(|store|store.execute("archiveReferences",&json!({"projectId":saved["id"],"revisionId":saved["revisionId"]}))).unwrap();
    request["referencePermission"]=json!({"inventorySha256":inventory["inventorySha256"],"assetIds":inventory["references"].as_array().unwrap().iter().map(|reference|reference["assetId"].clone()).collect::<Vec<_>>(),"rightsEvidence":"Synthetic owner permits bundling the recording."});
    let result=exports::execute(&fixture.service,"export",&request).await.unwrap();let imported=exports::execute(&fixture.service,"importProject",&json!({"path":result["path"]})).await.unwrap();assert_eq!(imported["cast"][0]["referenceAssetIds"],saved["cast"][0]["referenceAssetIds"]);
    fixture.service.with_store(|store|{let receipt:String=store.connection.query_row("SELECT snapshot FROM speech_exports WHERE project_id=?1",[saved["id"].as_str().unwrap()],|row|row.get(0)).map_err(|error|error.to_string())?;let receipt:Value=serde_json::from_str(&receipt).map_err(|error|error.to_string())?;assert_eq!(receipt["input"]["referencePermission"],request["referencePermission"]);Ok(())}).unwrap();
}

#[tokio::test]
async fn rf64_master_from_the_pinned_encoder_validates_analyzes_and_trims_without_changing_the_original(){
    let fixture=Fixture::new();let source=fixture.directory.join("rf64-source.wav");let trimmed=fixture.directory.join("trimmed-rf64-reference.wav");
    let mut command=std::process::Command::new(exports::encoder().unwrap());
    #[cfg(windows)]
    {use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
    let output=command.args(["-v","error","-nostdin","-n","-f","lavfi","-i","sine=frequency=440:sample_rate=24000","-t","0.02","-c:a","pcm_s24le","-rf64","always","-f","wav"]).arg(&source).output().unwrap();assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
    let original=exports::hash_file(&source).unwrap();let bytes=std::fs::read(&source).unwrap();assert_eq!(&bytes[..4],b"RF64");
    let (duration,rate,channels)=reference_audio::inspect_wav(&source).unwrap();assert!((duration-0.02).abs()<1e-9);assert_eq!((rate,channels),(24000,1));
    let analyzed=crate::analysis::analyze(&source,16).unwrap();assert_eq!(analyzed["frames"],480);assert_eq!(analyzed["sampleCount"],480);
    reference_audio::trim(&source,&trimmed,0.005,0.015).unwrap();let (duration,rate,channels)=reference_audio::inspect_wav(&trimmed).unwrap();assert!((duration-0.01).abs()<1e-9);assert_eq!((rate,channels),(24000,1));assert_eq!(exports::hash_file(&source).unwrap(),original);
}

#[tokio::test]
async fn production_encoder_exports_decodable_formats_and_real_audiobook_chapters() {
    let fixture = Fixture::new();
    let encoder = exports::encoder().expect("Install the pinned encoder before running the real export fixture");
    for format in ["wav", "mp3", "opus", "flac", "m4b"] {
        let result = exports::execute(&fixture.service, "export", &fixture.request(format)).await.unwrap();
        let path = result["path"].as_str().unwrap();
        assert_eq!(exports::hash_file(std::path::Path::new(path)).unwrap(), result["sha256"]);
        let decoded = std::process::Command::new(&encoder).args(["-hide_banner", "-v", "error", "-i", path, "-map", "0:a:0", "-f", "s16le", "-ar", "24000", "-ac", "1", "-"]).output().unwrap();
        assert!(decoded.status.success(), "{format} did not decode");
        assert!((decoded.stdout.len() as i64-96_000).abs() < 6_000, "{format} duration differs from two measured seconds");
        if format == "m4b" {
            let probe = encoder.parent().unwrap().join(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" });
            let output = std::process::Command::new(probe).args(["-v", "error", "-show_chapters", "-of", "json", path]).output().unwrap();
            assert!(output.status.success());
            let chapters: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(chapters["chapters"].as_array().unwrap().len(), 2);
            assert_eq!(chapters["chapters"][0]["tags"]["title"], "Arrival");
            assert_eq!(chapters["chapters"][1]["tags"]["title"], "Departure");
        }
        assert!(exports::execute(&fixture.service, "export", &fixture.request(format)).await.is_err());
    }
}

#[tokio::test]
async fn production_transcript_and_subtitle_exports_use_selected_takes() {
    let fixture = Fixture::new();
    for format in ["txt", "srt", "vtt"] {
        let result = exports::execute(&fixture.service, "export", &fixture.request(format)).await.unwrap();
        let text = std::fs::read_to_string(result["path"].as_str().unwrap()).unwrap();
        assert!(text.contains("Hello world."));
        assert!(text.contains("Auf Wiedersehen."));
        assert!(!text.contains("# Arrival"));
        if format == "srt" { assert!(text.contains("00:00:01,000 --> 00:00:02,000")); }
        if format == "vtt" { assert!(text.starts_with("WEBVTT\n")); }
    }
}

#[test]
fn reference_upload_recovers_committed_chunks_and_preserves_original_on_trim() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::io::Write;
    let fixture = Fixture::new();
    let bytes = std::fs::read(fixture.directory.join("source-0.wav")).unwrap();
    let hash = exports::hash_file(&fixture.directory.join("source-0.wav")).unwrap();
    let begin = recordings::execute(&fixture.service, "beginRecording", &json!({"owner":"recorder-a","bytes":bytes.len(),"sha256":hash,"transcript":"Synthetic tone","rightsEvidence":"Generated test signal"})).unwrap();
    let request = json!({"owner":"recorder-a","id":begin["id"]});
    assert!(recordings::execute(&fixture.service, "finishRecording", &request).is_err());
    assert!(recordings::execute(&fixture.service, "writeRecording", &json!({"owner":"recorder-b","id":begin["id"],"offset":0,"audioBase64":STANDARD.encode(&bytes)})).is_err());
    let split = bytes.len()/2;
    recordings::execute(&fixture.service, "writeRecording", &json!({"owner":"recorder-a","id":begin["id"],"offset":0,"audioBase64":STANDARD.encode(&bytes[..split])})).unwrap();
    fixture.service.with_store(|store| {
        let path = store.root.join(format!("recording-{}.part",begin["id"].as_str().unwrap()));
        std::fs::OpenOptions::new().append(true).open(path).unwrap().write_all(b"uncommitted bytes").unwrap();
        Ok(())
    }).unwrap();
    let pending = recordings::execute(&fixture.service, "listRecordingUploads", &json!({"owner":"recorder-a"})).unwrap();
    assert_eq!(pending[0]["offset"], split);
    assert_eq!(recordings::execute(&fixture.service, "listRecordingUploads", &json!({"owner":"recorder-b"})).unwrap(), json!([]));
    assert!(recordings::execute(&fixture.service, "writeRecording", &json!({"owner":"recorder-a","id":begin["id"],"offset":0,"audioBase64":STANDARD.encode(&bytes)})).is_err());
    recordings::execute(&fixture.service, "writeRecording", &json!({"owner":"recorder-a","id":begin["id"],"offset":split,"audioBase64":STANDARD.encode(&bytes[split..])})).unwrap();
    let reference = recordings::execute(&fixture.service, "finishRecording", &request).unwrap();
    assert_eq!(reference["asset"]["id"], hash);
    assert_eq!(reference["originalAsset"], reference["asset"]);
    let trimmed = recordings::execute(&fixture.service, "trimReference", &json!({"owner":"recorder-a","assetId":hash,"from":0.25,"to":0.75,"transcript":"Trimmed synthetic tone"})).unwrap();
    assert_eq!(trimmed["originalAsset"]["id"], hash);
    assert_ne!(trimmed["asset"]["id"], hash);
    assert_eq!(trimmed["asset"]["duration"], 0.5);
    fixture.service.with_store(|store| {
        let original = store.asset_path(&hash)?;
        assert_eq!(exports::hash_file(&original)?, hash);
        let parent: String = store.connection.query_row("SELECT original_asset_id FROM speech_reference_originals WHERE asset_id=?1", [trimmed["asset"]["id"].as_str().unwrap()], |row| row.get(0)).unwrap();
        assert_eq!(parent, hash);
        Ok(())
    }).unwrap();
    let saved = recordings::execute(&fixture.service, "listReferences", &json!({"offset":0,"limit":1})).unwrap();
    assert_eq!(saved["total"], 2);
    assert_eq!(saved["references"].as_array().unwrap().len(), 1);
    assert!(recordings::execute(&fixture.service, "listReferences", &json!({"offset":u64::MAX,"limit":1})).is_err());
    assert_eq!(recordings::execute(&fixture.service, "listRecordingUploads", &json!({"owner":"recorder-a"})).unwrap(), json!([]));
}

#[test]
fn reference_upload_rejects_integrity_failures_and_cancels_owned_work() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let fixture = Fixture::new();
    let bytes = std::fs::read(fixture.directory.join("source-0.wav")).unwrap();
    let begin = recordings::execute(&fixture.service, "beginRecording", &json!({"owner":"recorder-a","bytes":bytes.len(),"sha256":"0".repeat(64),"transcript":"Synthetic tone","rightsEvidence":"Generated test signal"})).unwrap();
    recordings::execute(&fixture.service, "writeRecording", &json!({"owner":"recorder-a","id":begin["id"],"offset":0,"audioBase64":STANDARD.encode(&bytes)})).unwrap();
    assert!(recordings::execute(&fixture.service, "finishRecording", &json!({"owner":"recorder-a","id":begin["id"]})).unwrap_err().contains("integrity"));
    assert!(recordings::execute(&fixture.service, "cancelRecording", &json!({"owner":"recorder-b","id":begin["id"]})).is_err());
    recordings::execute(&fixture.service, "cancelRecording", &json!({"owner":"recorder-a","id":begin["id"]})).unwrap();
    fixture.service.with_store(|store| {
        assert!(!store.root.join(format!("recording-{}.part",begin["id"].as_str().unwrap())).exists());
        Ok(())
    }).unwrap();
}

#[test]
fn reference_upload_claims_prevent_concurrent_mutation_and_expired_claims_can_be_recovered() {
    use base64::{engine::general_purpose::STANDARD,Engine};
    let fixture=Fixture::new();let source=fixture.directory.join("source-0.wav");let bytes=std::fs::read(&source).unwrap();let hash=exports::hash_file(&source).unwrap();
    let begin=recordings::execute(&fixture.service,"beginRecording",&json!({"owner":"recorder-a","bytes":bytes.len(),"sha256":hash,"transcript":"Synthetic tone","rightsEvidence":"Generated test signal"})).unwrap();
    let request=json!({"owner":"recorder-a","id":begin["id"]});
    fixture.service.with_store(|store| {
        store.connection.execute("INSERT INTO speech_recording_claims VALUES(?1,'worker-token',?2)",rusqlite::params![begin["id"].as_str(),(chrono::Utc::now()+chrono::Duration::hours(1)).to_rfc3339()]).unwrap();Ok(())
    }).unwrap();
    for operation in ["finishRecording","cancelRecording","writeRecording"] {
        let mut input=request.clone();input["offset"]=json!(0);input["audioBase64"]=json!(STANDARD.encode(&bytes));
        assert!(recordings::execute(&fixture.service,operation,&input).unwrap_err().contains("being imported"));
    }
    fixture.service.with_store(|store| {store.connection.execute("UPDATE speech_recording_claims SET expires_at='2000-01-01T00:00:00Z'",[]).unwrap();Ok(())}).unwrap();
    let mut write=request.clone();write["offset"]=json!(0);write["audioBase64"]=json!(STANDARD.encode(&bytes));recordings::execute(&fixture.service,"writeRecording",&write).unwrap();
    let saved=recordings::execute(&fixture.service,"finishRecording",&request).unwrap();assert_eq!(saved["asset"]["sha256"],hash);
    fixture.service.with_store(|store| {assert_eq!(store.connection.query_row("SELECT count(*) FROM speech_recording_claims",[],|row|row.get::<_,i64>(0)).unwrap(),0);Ok(())}).unwrap();
}

#[tokio::test]
async fn portable_project_preserves_revisions_selected_takes_and_lineage_without_overwriting_existing_data() {
    let fixture = Fixture::new();
    let mut original = fixture.project.clone();
    original["source"] = json!("Updated script");
    original["selectedTakes"] = json!({"segment-0":fixture.take_ids[0]});
    original["timeline"] = json!([{"id":"clip-0","takeId":fixture.take_ids[0],"start":0,"in":0.25,"out":0.75,"gain":0.8,"fadeIn":0.05,"fadeOut":0.05,"track":0}]);
    let original = fixture.service.with_store(|store| store.execute("saveProject",&json!({"project":original,"expectedRevisionId":fixture.project["revisionId"]}))).unwrap();
    let output = exports::execute(&fixture.service,"export",&fixture.request("archive")).await.unwrap();
    let imported = exports::execute(&fixture.service,"importProject",&json!({"path":output["path"]})).await.unwrap();
    assert_ne!(imported["id"],original["id"]);
    assert_ne!(imported["revisionId"],original["revisionId"]);
    assert_eq!(imported["source"],original["source"]);
    assert_eq!(imported["timeline"][0]["in"],0.25);
    assert_ne!(imported["timeline"][0]["takeId"],original["timeline"][0]["takeId"]);
    assert_eq!(imported["selectedTakes"]["segment-0"],imported["timeline"][0]["takeId"]);
    fixture.service.with_store(|store| {
        let revisions = store.execute("revisions",&json!({"projectId":imported["id"],"offset":0,"limit":20}))?;
        assert_eq!(revisions["revisions"].as_array().unwrap().len(),2);
        let original_again = store.execute("getProject",&json!({"id":original["id"]}))?;
        assert_eq!(original_again,original);
        let takes = store.execute("listTakes",&json!({"projectId":imported["id"]}))?;
        assert_eq!(takes.as_array().unwrap().len(),2);
        let hash = exports::hash_file(&fixture.directory.join("source-0.wav"))?;
        assert!(takes.as_array().unwrap().iter().all(|take|take["asset"]["sha256"]==hash));
        for take in takes.as_array().unwrap() {
            let request=store.execute("takeRequest",&json!({"id":take["id"]}))?;
            assert_eq!(request["segment"]["spokenText"],take["spokenText"]);
            assert_eq!(crate::cache::request_hash(&request["segment"],&request["profile"],&request["dictionaries"],&request["references"],&request["connection"])?,take["requestHash"]);
        }
        Ok(())
    }).unwrap();
}

#[tokio::test]
async fn production_mix_preserves_overlap_and_normalizes_using_measured_loudness() {
    let fixture = Fixture::new();
    let mut project = fixture.project.clone();
    project["timeline"] = json!([
        {"id":"clip-0","takeId":fixture.take_ids[0],"start":0.0,"in":0.0,"out":1.0,"gain":0.5,"fadeIn":0.0,"fadeOut":0.0,"track":0},
        {"id":"clip-1","takeId":fixture.take_ids[1],"start":0.5,"in":0.0,"out":1.0,"gain":0.5,"fadeIn":0.0,"fadeOut":0.0,"track":1}
    ]);
    fixture.service.with_store(|store| store.execute("saveProject",&json!({"project":project,"expectedRevisionId":fixture.project["revisionId"]}))).unwrap();
    let mut request=fixture.request("wav");
    request["takeIds"]=json!([]);
    request["loudnessLufs"]=json!(-20);
    request["truePeakDb"]=json!(-1);
    let result=exports::execute(&fixture.service,"export",&request).await.unwrap();
    let mut reader=hound::WavReader::open(result["path"].as_str().unwrap()).unwrap();
    assert_eq!(reader.duration(),36_000);
    let samples:Vec<i32>=reader.samples().map(Result::unwrap).collect();
    let rms=|from:usize,to:usize| (samples[from..to].iter().map(|value|(*value as f64).powi(2)).sum::<f64>()/(to-from) as f64).sqrt();
    let ratio=rms(15_000,21_000)/rms(3_000,9_000);
    assert!((1.95..2.05).contains(&ratio),"Mix changed the overlap amplitude ratio: {ratio}");
    let encoder=exports::encoder().unwrap();
    let log=std::process::Command::new(encoder).args(["-hide_banner","-nostats","-i",result["path"].as_str().unwrap(),"-af","loudnorm=I=-20:TP=-1:LRA=11:print_format=json","-f","null","-"]).output().unwrap();
    assert!(log.status.success());
    let log=String::from_utf8_lossy(&log.stderr);
    let start=log.rfind('{').unwrap();
    let end=start+log[start..].find('}').unwrap()+1;
    let values:Value=serde_json::from_str(&log[start..end]).unwrap();
    let measured=values["input_i"].as_str().unwrap().parse::<f64>().unwrap();
    assert!((measured+20.0).abs()<0.3,"Integrated loudness was {measured}");
    fixture.service.with_store(|store|{
        let mut project=store.execute("getProject",&json!({"id":fixture.project["id"]}))?;
        let previous=project["revisionId"].clone();
        for clip in project["timeline"].as_array_mut().unwrap(){clip["gain"]=json!(16);}
        store.execute("saveProject",&json!({"project":project,"expectedRevisionId":previous}))?;
        Ok(())
    }).unwrap();
    request["loudnessLufs"]=Value::Null;request["truePeakDb"]=Value::Null;
    let clipped=fixture.directory.join("clipped.wav");request["outputPath"]=json!(clipped);
    assert!(exports::execute(&fixture.service,"export",&request).await.unwrap_err().contains("mix clips"));
    assert!(!clipped.exists());
    assert!(!fixture.directory.read_dir().unwrap().any(|entry|entry.unwrap().file_name().to_string_lossy().starts_with(".speech-work-")));
}

#[test]
fn answer_audio_save_pins_completed_audio_and_generation_without_resynthesis_or_duplicate_projects() {
    let fixture=Fixture::new();
    let original=fixture.chat_audio();
    fixture.service.with_store(|store| {
        let input=fixture.save_answer_input();
        let saved=store.execute("saveAnswerAudio",&input)?;
        assert_eq!(saved["answerOrigin"],json!({"sessionId":"session","answerId":"answer-1","revision":"answer-revision"}));
        assert_eq!(saved["source"],"Hello world.");
        let takes=store.execute("listTakes",&json!({"projectId":saved["id"]}))?;
        let take=&takes[0];
        assert_eq!(take["asset"]["sha256"],original["asset"]["sha256"]);
        assert_eq!(take["requestHash"],original["requestHash"]);
        assert_eq!(take["generatedAt"],original["generatedAt"]);
        let generation=store.execute("takeRequest",&json!({"id":take["id"]}))?;
        assert_eq!(generation["segment"]["text"],"Hello world.");
        assert_eq!(generation["profile"]["name"],"Synthetic export fixture");
        assert_eq!(store.execute("saveAnswerAudio",&input)?["id"],saved["id"]);
        let jobs=store.execute("listJobs",&json!({"owner":"chat:session"}))?;
        assert_eq!(jobs.as_array().unwrap().len(),1);
        assert_eq!(jobs[0]["id"],"chat-job");
        let mut wrong=input.clone();wrong["owner"]=json!("chat:other");wrong["alternateOwner"]=json!("chat:auto:other");
        assert!(store.execute("saveAnswerAudio",&wrong).is_err());
        let mut wrong=input.clone();wrong["source"]=json!("Modified answer.");
        assert!(store.execute("saveAnswerAudio",&wrong).is_err());
        Ok(())
    }).unwrap();
}

#[test]
fn answer_audio_save_reuses_the_opened_script_project_and_preserves_studio_edits() {
    use sha2::{Digest,Sha256};
    let fixture=Fixture::new();
    fixture.chat_audio();
    fixture.service.with_store(|store| {
        let material=serde_json::to_vec(&json!(["session","answer-1","answer-revision"])).unwrap();
        let id=format!("answer-{:x}",Sha256::digest(material));
        let mut draft=fixture.project.clone();
        draft["id"]=json!(id);draft["source"]=json!("Hello world.");draft["title"]=json!("My edited project title");draft["revisionId"]=json!("");draft["parentRevisionId"]=Value::Null;
        draft["answerOrigin"]=json!({"sessionId":"session","answerId":"answer-1","revision":"answer-revision"});
        let mut project=store.execute("saveProject",&json!({"project":draft,"expectedRevisionId":null}))?;
        let source_revision=project["revisionId"].clone();
        let previous=project["revisionId"].clone();
        project["source"]=json!("Edits made in the studio.");
        let edited=store.execute("saveProject",&json!({"project":project,"expectedRevisionId":previous}))?;
        let saved=store.execute("saveAnswerAudio",&fixture.save_answer_input())?;
        assert_eq!(saved["id"],id);
        assert_eq!(saved["source"],edited["source"]);
        assert_eq!(saved["title"],edited["title"]);
        let takes=store.execute("listTakes",&json!({"projectId":id}))?;
        assert_eq!(takes.as_array().unwrap().len(),1);
        assert_eq!(takes[0]["revisionId"],source_revision);
        assert_eq!(takes[0]["spokenText"],"Hello world.");
        assert_eq!(saved["timeline"][0]["takeId"],takes[0]["id"]);
        assert_eq!(store.execute("saveAnswerAudio",&fixture.save_answer_input())?["revisionId"],saved["revisionId"]);
        Ok(())
    }).unwrap();
}
