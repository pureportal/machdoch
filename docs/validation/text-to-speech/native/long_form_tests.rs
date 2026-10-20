use super::*;
use std::io::Read;
use sha2::{Digest,Sha256};

fn verification_profile()->Value {
    let manifest=include_str!("Cargo.toml");
    let optimization=|package:&str| {
        let header=format!("[profile.test.package.{package}]");
        manifest.split_once(&header).expect("Declare the physical verification package profile.").1.lines().take_while(|line|!line.trim().starts_with('[')).find_map(|line|line.trim().strip_prefix("opt-level = ")).expect("Declare its test optimization level.").parse::<u8>().unwrap()
    };
    json!({"declaredRootTestOptimization":optimization("machdoch-speech-verification"),"declaredSha2TestOptimization":optimization("sha2"),"cargoManifestSha256":format!("{:x}",Sha256::digest(manifest.as_bytes())),"debugAssertionsEnabled":cfg!(debug_assertions),"scope":"Declared test profiles embedded at compile time; invocation flags are recorded separately"})
}

#[repr(C)]
struct MemoryCounters{cb:u32,page_fault_count:u32,peak_working_set:usize,working_set:usize,quota_peak_paged:usize,quota_paged:usize,quota_peak_nonpaged:usize,quota_nonpaged:usize,pagefile:usize,peak_pagefile:usize}
#[cfg(windows)]
#[link(name="kernel32")]
extern "system"{fn GetCurrentProcess()->*mut std::ffi::c_void;}
#[cfg(windows)]
#[link(name="psapi")]
extern "system"{fn GetProcessMemoryInfo(process:*mut std::ffi::c_void,counters:*mut MemoryCounters,size:u32)->i32;}

fn peak_working_set()->Option<usize>{
    #[cfg(windows)]
    {let mut value:MemoryCounters=unsafe{std::mem::zeroed()};let size=std::mem::size_of::<MemoryCounters>() as u32;value.cb=size;assert_ne!(unsafe{GetProcessMemoryInfo(GetCurrentProcess(),&mut value,size)},0);Some(value.peak_working_set)}
    #[cfg(not(windows))]
    {None}
}

fn put_segment(store:&mut SpeechStore,project:&Value,profile:&Value,segment:&Value,asset:&Value,id:&str)->Result<Value,String>{
    let now=timestamp();let request=json!({"segment":segment,"profile":profile,"dictionaries":[],"references":{},"connection":{"backend":"fish-cloud","model":"drama-3","url":null,"runtimeVersion":null}});
    let hash=crate::cache::request_hash(segment,profile,&request["dictionaries"],&request["references"],&request["connection"])?;
    let take=json!({"id":id,"projectId":project["id"],"revisionId":project["revisionId"],"segmentId":segment["id"],"spokenText":segment["spokenText"],"chapter":segment["chapter"],"asset":asset,"createdAt":now,"generatedAt":now,"reusedFromTakeId":null,"backend":"fish-cloud","model":"drama-3","requestHash":hash,"parentTakeId":null,"favorite":false,"rating":null,"note":"","alignment":[]});
    store.put_take(&take)?;store.connection.execute("INSERT INTO take_requests VALUES(?1,?2)",rusqlite::params![id,request.to_string()]).map_err(|error|error.to_string())?;Ok(take)
}

fn signal(path:&std::path::Path,frame:u64,count:usize)->(f64,usize){
    let mut reader=crate::wave_file::WaveReader::open(path).unwrap();let scale=2f64.powi(i32::from(reader.spec().bits_per_sample)-1);assert_eq!(reader.spec().channels,1);reader.seek_frame(frame).unwrap();let mut peak=0f64;let mut crossings=0;let mut previous=0f64;
    for sample in reader.take(count){let sample=match sample.unwrap(){crate::wave_file::WaveSample::Integer(value)=>f64::from(value)/scale,crate::wave_file::WaveSample::Float(value)=>f64::from(value)};peak=peak.max(sample.abs());if previous<=0.0&&sample>0.0{crossings+=1;}previous=sample;}
    (peak,crossings)
}

#[tokio::test]
#[ignore="Run with the prepared 48-chapter fixture to verify actual eight-hour assembly and native memory."]
async fn full_book_assembly_preserves_all_48_chapters_and_selective_replacement_with_bounded_native_memory(){
    let definition=PathBuf::from(std::env::var("MACHDOCH_TTS_BOOK_FIXTURE").expect("Run prepare-long-form.mjs and set MACHDOCH_TTS_BOOK_FIXTURE."));assert!(std::fs::metadata(&definition).unwrap().len()<16*1024*1024);
    let book:Value=serde_json::from_reader(std::fs::File::open(&definition).unwrap()).unwrap();assert_eq!(book["syntheticAudio"],true);assert_eq!(book["providerExecution"],false);let segments=book["segments"].as_array().unwrap();assert_eq!(segments.len(),48);
    let fixture=Fixture::new();let profile=json!({"id":"long-form-profile","name":"Synthetic book verification","backend":"fish-cloud","model":"drama-3","voiceId":"synthetic-voice","direction":"","temperature":0.7,"topP":0.7,"chunkLength":200,"minChunkLength":50,"latency":"normal","dictionaryIds":[],"playbackRate":1});
    let (production,source_peak)=fixture.service.with_store(|store|{
        store.execute("saveProfile",&json!({"profile":profile}))?;let mut project=fixture.project.clone();project["source"]=book["source"].clone();project["cast"]=book["cast"].clone();project["profileId"]=profile["id"].clone();let head=project["revisionId"].clone();let mut project=store.execute("saveProject",&json!({"project":project,"expectedRevisionId":head}))?;
        let source=std::path::Path::new(book["audio"][0].as_str().unwrap());let asset=store.put_asset(source,"audio/wav",600.0,8000,1)?;let mut selected=serde_json::Map::new();let mut clips=Vec::new();
        for (index,segment) in segments.iter().enumerate(){let id=format!("book-take-{index}");put_segment(store,&project,&profile,segment,&asset,&id)?;selected.insert(segment["id"].as_str().unwrap().to_string(),json!(id));clips.push(json!({"id":format!("clip-{index}"),"takeId":id,"start":index*600,"in":0,"out":600,"gain":0.25+index as f64/128.0,"fadeIn":0,"fadeOut":0,"track":0}));}
        project["selectedTakes"]=Value::Object(selected);project["timeline"]=json!(clips);let head=project["revisionId"].clone();Ok((store.execute("saveProject",&json!({"project":project,"expectedRevisionId":head}))?,signal(source,0,8000).0))
    }).unwrap();
    let master=fixture.directory.join("eight-hour-book.wav");let request=json!({"projectId":production["id"],"revisionId":production["revisionId"],"takeIds":[],"format":"wav","outputPath":master,"overwrite":false,"sampleRate":8000,"channels":1,"bitrate":0,"loudnessLufs":null,"truePeakDb":null,"includeBackground":false});let started=std::time::Instant::now();let output=exports::execute(&fixture.service,"export",&request).await.unwrap();let assembly_seconds=started.elapsed().as_secs_f64();
    let reader=crate::wave_file::WaveReader::open(&master).unwrap();assert_eq!(reader.frames(),230_400_000);assert_eq!(reader.spec().sample_rate,8000);assert_eq!(reader.spec().channels,1);assert_eq!(reader.spec().bits_per_sample,24);
    let mut peaks=Vec::new();for index in 0..48{let (peak,crossings)=signal(&master,(index*600+300)*8000,8000);let expected=source_peak*(0.25+index as f64/128.0);assert!((peak-expected).abs()<0.00002,"Chapter {index}: {peak} != {expected}");assert!((996..=998).contains(&crossings));peaks.push(peak);}
    let revised=fixture.service.with_store(|store|{
        let mut project=production.clone();project["source"]=book["revisedSource"].clone();let head=project["revisionId"].clone();let mut project=store.execute("saveProject",&json!({"project":project,"expectedRevisionId":head}))?;
        let asset=store.put_asset(std::path::Path::new(book["audio"][1].as_str().unwrap()),"audio/wav",600.0,8000,1)?;let segment=&book["revisedSegments"][23];assert_ne!(segment["id"],segments[23]["id"]);put_segment(store,&project,&profile,segment,&asset,"replacement-take")?;
        let selected=project["selectedTakes"].as_object_mut().unwrap();selected.remove(segments[23]["id"].as_str().unwrap());selected.insert(segment["id"].as_str().unwrap().to_string(),json!("replacement-take"));project["timeline"][23]["takeId"]=json!("replacement-take");
        for index in (0..48).filter(|index|*index!=23){assert_eq!(project["selectedTakes"][segments[index]["id"].as_str().unwrap()],format!("book-take-{index}"));}
        let head=project["revisionId"].clone();store.execute("saveProject",&json!({"project":project,"expectedRevisionId":head}))
    }).unwrap();
    let replacement=fixture.directory.join("replacement-chapter.wav");let mut changed=request;changed["revisionId"]=revised["revisionId"].clone();changed["outputPath"]=json!(replacement);changed["clipIds"]=json!(["clip-23"]);changed["range"]=json!({"from":23*600,"to":24*600});exports::execute(&fixture.service,"export",&changed).await.unwrap();assert_eq!(crate::wave_file::WaveReader::open(&replacement).unwrap().frames(),4_800_000);assert!((498..=500).contains(&signal(&replacement,300*8000,8000).1));assert_eq!(exports::hash_file(&master).unwrap(),output["sha256"]);
    let memory=peak_working_set();if let Some(bytes)=memory{assert!(bytes<512*1024*1024,"Native peak working set: {bytes}");}
    let report=json!({"syntheticAudio":true,"providerExecution":false,"verificationProfile":verification_profile(),"sourceUtf8Bytes":book["utf8Bytes"],"chapters":48,"durationSeconds":28800,"sampleRate":8000,"channels":1,"bitsPerSample":24,"frames":230400000,"sourceSegments":48,"unchangedSegmentsAfterEdit":47,"chapterPeaks":peaks,"allChapterSignalsVerified":true,"selectiveReplacementFrames":4800000,"originalMasterSha256":output["sha256"],"originalMasterUnchanged":true,"assemblySeconds":assembly_seconds,"nativePeakWorkingSetBytes":memory,"externalEncoderMemoryIncluded":false});std::fs::write(std::env::var("MACHDOCH_TTS_BOOK_REPORT").expect("Set MACHDOCH_TTS_BOOK_REPORT."),serde_json::to_vec_pretty(&report).unwrap()).unwrap();
}

#[tokio::test]
#[ignore="Run with a retained real ZIP64 project archive containing the actual RF64 asset larger than 4 GiB."]
async fn retained_large_zip64_archive_imports_and_exports_with_verified_audio_and_bounded_memory(){
    let source=PathBuf::from(std::env::var("MACHDOCH_TTS_LARGE_ARCHIVE").expect("Set MACHDOCH_TTS_LARGE_ARCHIVE to the retained physical producer archive."));
    let mut archive=zip::ZipArchive::new(std::fs::File::open(&source).unwrap()).unwrap();
    let manifest:Value=serde_json::from_reader(archive.by_name("manifest.json").unwrap().take(64*1024*1024)).unwrap();
    let large=manifest["assets"].as_object().unwrap().iter().filter(|(_,asset)|asset["bytes"].as_u64().is_some_and(|bytes|bytes>u64::from(u32::MAX))).map(|(id,asset)|(id.clone(),asset.clone())).collect::<Vec<_>>();assert_eq!(large.len(),1);let (id,asset)=&large[0];
    assert_eq!(archive.by_name(&format!("blobs/{id}")).unwrap().size(),asset["bytes"].as_u64().unwrap());drop(archive);
    let fixture=Fixture::new();let started=std::time::Instant::now();
    let mut metadata=MetadataProbe::start(fixture.service.clone());
    metadata.phase.store(1,std::sync::atomic::Ordering::SeqCst);
    let imported=exports::execute(&fixture.service,"importProject",&json!({"path":source})).await.unwrap();assert_eq!(imported["source"],manifest["project"]["source"]);
    let takes=fixture.service.with_store(|store|store.execute("listTakes",&json!({"projectId":imported["id"],"limit":10}))).unwrap();assert!(takes.as_array().unwrap().iter().any(|take|take["asset"]["id"]==*id&&take["asset"]["bytes"]==asset["bytes"]));
    let mut request=fixture.request("archive");request["projectId"]=imported["id"].clone();request["revisionId"]=imported["revisionId"].clone();request["takeIds"]=json!([]);
    metadata.phase.store(2,std::sync::atomic::Ordering::SeqCst);
    let output=exports::execute(&fixture.service,"export",&request).await.unwrap();let output_path=PathBuf::from(output["path"].as_str().unwrap());let mut archived=zip::ZipArchive::new(std::fs::File::open(&output_path).unwrap()).unwrap();let mut entry=archived.by_name(&format!("blobs/{id}")).unwrap();assert_eq!(entry.size(),asset["bytes"].as_u64().unwrap());let mut header=[0u8;4];entry.read_exact(&mut header).unwrap();assert_eq!(&header,b"RF64");drop(entry);drop(archived);
    let metadata=metadata.finish();
    for phase in &metadata { assert!(phase["observations"].as_u64().unwrap()>=2);assert!(phase["maximumQueryMs"].as_f64().unwrap()<1000.0,"Metadata query stalled: {phase}"); }
    let memory=peak_working_set();if let Some(bytes)=memory{assert!(bytes<512*1024*1024,"Native peak working set: {bytes}");}
    let report=json!({"syntheticAudio":true,"providerExecution":false,"verificationProfile":verification_profile(),"inputArchive":source,"sourceBytes":asset["bytes"],"sourceSha256":id,"currentImportVerified":true,"currentExportVerified":true,"archiveBytes":std::fs::metadata(output_path).unwrap().len(),"nativePeakWorkingSetBytes":memory,"elapsedSeconds":started.elapsed().as_secs_f64(),"metadataQueries":metadata,"metadataSamplingIntervalMs":100,"metadataMaximumQueryGuardMs":1000});
    std::fs::write(std::env::var("MACHDOCH_TTS_RETAINED_ZIP64_REPORT").expect("Set MACHDOCH_TTS_RETAINED_ZIP64_REPORT."),serde_json::to_vec_pretty(&report).unwrap()).unwrap();
}

struct MetadataProbe {
    phase:Arc<std::sync::atomic::AtomicUsize>,
    worker:Option<std::thread::JoinHandle<[Value;2]>>,
}

impl MetadataProbe {
    fn start(service:Arc<SpeechService>)->Self {
        let phase=Arc::new(std::sync::atomic::AtomicUsize::new(0));let observed=phase.clone();
        let worker=std::thread::spawn(move || {
            let mut counts=[0u64;2];let mut maximum=[0f64;2];
            loop {
                let current=observed.load(std::sync::atomic::Ordering::SeqCst);if current==3 { break; }
                if current>0 {
                    let started=std::time::Instant::now();
                    assert!(service.with_store(|store|store.execute("queue",&json!({}))).is_ok());
                    counts[current-1]+=1;maximum[current-1]=maximum[current-1].max(started.elapsed().as_secs_f64()*1000.0);
                }
                std::thread::park_timeout(std::time::Duration::from_millis(100));
            }
            [json!({"phase":"import","observations":counts[0],"maximumQueryMs":maximum[0]}),json!({"phase":"export","observations":counts[1],"maximumQueryMs":maximum[1]})]
        });
        Self{phase,worker:Some(worker)}
    }

    fn finish(&mut self)->[Value;2] {
        self.phase.store(3,std::sync::atomic::Ordering::SeqCst);
        let worker=self.worker.take().unwrap();worker.thread().unpark();worker.join().unwrap()
    }
}

impl Drop for MetadataProbe {
    fn drop(&mut self) {
        if let Some(worker)=self.worker.take() {
            self.phase.store(3,std::sync::atomic::Ordering::SeqCst);worker.thread().unpark();
            if worker.join().is_err() { eprintln!("Metadata observation worker failed during physical-test cleanup."); }
        }
    }
}

#[tokio::test]
#[ignore="Run with an actual RF64 WAV larger than 4 GiB to verify the ZIP64 project round trip."]
async fn actual_large_rf64_asset_survives_zip64_project_export_and_import(){
    let source=PathBuf::from(std::env::var("MACHDOCH_TTS_LARGE_WAVE").expect("Set MACHDOCH_TTS_LARGE_WAVE to the prepared RF64 fixture."));let length=std::fs::metadata(&source).unwrap().len();assert!(length>u64::from(u32::MAX));let (duration,rate,channels)=crate::reference_audio::inspect_wav(&source).unwrap();
    let fixture=Fixture::new();let asset=fixture.service.with_store(|store|{let asset=store.put_asset(&source,"audio/wav",duration,rate,channels)?;let original=store.execute("takeRequest",&json!({"id":fixture.take_ids[0]}))?;put_segment(store,&fixture.project,&original["profile"],&original["segment"],&asset,"large-take")?;Ok(asset)}).unwrap();
    let mut request=fixture.request("archive");request["takeIds"]=json!([]);let output=exports::execute(&fixture.service,"export",&request).await.unwrap();let archive_path=PathBuf::from(output["path"].as_str().unwrap());let mut archive=zip::ZipArchive::new(std::fs::File::open(&archive_path).unwrap()).unwrap();let mut entry=archive.by_name(&format!("blobs/{}",asset["id"].as_str().unwrap())).unwrap();assert_eq!(entry.size(),length);let mut header=[0u8;4];entry.read_exact(&mut header).unwrap();assert_eq!(&header,b"RF64");drop(entry);drop(archive);
    let imported=exports::execute(&fixture.service,"importProject",&json!({"path":archive_path})).await.unwrap();assert_ne!(imported["id"],fixture.project["id"]);let copied=fixture.service.with_store(|store|store.execute("listTakes",&json!({"projectId":imported["id"],"limit":10}))).unwrap();assert!(copied.as_array().unwrap().iter().any(|take|take["asset"]["id"]==asset["id"]&&take["asset"]["bytes"]==length));
    let report=json!({"syntheticAudio":true,"providerExecution":false,"verificationProfile":verification_profile(),"sourceBytes":length,"durationSeconds":duration,"sampleRate":rate,"channels":channels,"archiveBytes":std::fs::metadata(&archive_path).unwrap().len(),"zip64AssetBytes":length,"sourceSha256":asset["sha256"],"roundtripAssetDigestPreserved":true,"nativePeakWorkingSetBytes":peak_working_set()});std::fs::write(std::env::var("MACHDOCH_TTS_ZIP64_REPORT").expect("Set MACHDOCH_TTS_ZIP64_REPORT."),serde_json::to_vec_pretty(&report).unwrap()).unwrap();
}
