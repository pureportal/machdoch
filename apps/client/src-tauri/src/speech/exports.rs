use super::{identifier, settings, timestamp, SpeechService};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[path = "audio_export.rs"]
mod audio_export;
#[path = "export_text.rs"]
mod export_text;
#[path = "production_contract.rs"]
mod production_contract;
#[path = "project_archive.rs"]
mod project_archive;

pub fn encoder() -> Result<PathBuf, String> {
    media_binary("binary", "binarySha256")
}

pub fn probe() -> Result<PathBuf, String> {
    media_binary("ffprobe", "ffprobeSha256")
}

fn media_binary(path_field: &str, digest_field: &str) -> Result<PathBuf, String> {
    let root = Path::new(settings::model_root()).join("speech/encoder");
    let manifest: Value =
        serde_json::from_reader(File::open(root.join("manifest.json")).map_err(|_| {
            "Install the pinned speech encoder before exporting audio.".to_string()
        })?)
        .map_err(|_| "The speech encoder manifest is damaged.".to_string())?;
    if manifest["schema"] != "machdoch-speech-encoder" || manifest["version"] != 1 {
        return Err("The speech encoder manifest is unsupported.".to_string());
    }
    let binary = root
        .join(
            manifest[path_field]
                .as_str()
                .ok_or("The pinned media binary path is missing.")?,
        )
        .canonicalize()
        .map_err(|_| "The pinned speech media binary is missing.".to_string())?;
    if !binary.starts_with(
        root.canonicalize()
            .map_err(|_| "The speech encoder location is unavailable.")?,
    ) {
        return Err("The speech encoder must stay inside the configured model root.".to_string());
    }
    if hash_file(&binary)?
        != manifest[digest_field]
            .as_str()
            .ok_or("The media binary digest is missing.")?
    {
        return Err(
            "The speech media runtime failed its integrity check. Reinstall the pinned package."
                .to_string(),
        );
    }
    Ok(binary)
}

pub async fn execute(
    service: &Arc<SpeechService>,
    operation: &str,
    input: &Value,
) -> Result<Value, String> {
    match operation {
        "importProject" => project_archive::import(service, input),
        "mediaHandoff" => {
            let project_id = input["projectId"]
                .as_str()
                .ok_or("Choose a speech project.")?;
            let take = service.with_store(|store| {
                let project=store.execute("getProject",&json!({"id":project_id}))?;
                let mut takes = store.production_takes(project_id,&json!([input["takeId"]]),1)?;
                let timing=store.apply_project_timing(&project,&mut takes)?;
                let mut take=takes
                    .as_array()
                    .and_then(|values| values.iter().find(|take| take["id"] == input["takeId"]))
                    .cloned()
                    .ok_or("Choose a rendered take from this project.".to_string())?;
                if let Some(record)=timing.as_array().and_then(|records|records.iter().find(|record|record["takeId"]==take["id"])){take["timingEvidence"]=record.clone();}
                Ok(take)
            })?;
            let asset_id =
                super::super::media::import_speech_asset(&service.app, &take, project_id).await?;
            Ok(json!({"assetId":asset_id,"sourceProjectId":project_id}))
        }
        "export" => export(service, input).await,
        "previewTimeline" => preview(service, input).await,
        _ => Err("Unknown speech export operation.".to_string()),
    }
}

pub fn hash_file(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|_| "The speech file could not be read.".to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "The speech file could not be hashed.".to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn commit(temporary: &Path, destination: &Path, overwrite: bool) -> Result<Value, String> {
    if overwrite {
        std::fs::rename(temporary, destination)
            .map_err(|_| "The export could not replace the selected file.".to_string())?;
    } else {
        std::fs::hard_link(temporary,destination).map_err(|_|"The export already exists or cannot be created. Choose a new path or confirm overwrite.".to_string())?;
        std::fs::remove_file(temporary)
            .map_err(|_| "The temporary export could not be removed.".to_string())?;
    }
    Ok(
        json!({"path":destination.to_string_lossy(),"sha256":hash_file(destination)?,"bytes":std::fs::metadata(destination).map_err(|_|"The exported file is unavailable.")?.len()}),
    )
}

async fn export(service: &Arc<SpeechService>, input: &Value) -> Result<Value, String> {
    production_contract::validate(input, false)?;
    let destination = PathBuf::from(
        input["outputPath"]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .ok_or("Choose an export path.")?,
    );
    if !destination.is_absolute() {
        return Err("Choose an absolute export path.".to_string());
    }
    let overwrite = input["overwrite"] == true;
    if destination.exists() && !overwrite {
        return Err(
            "This export already exists. Choose a new path or confirm overwrite.".to_string(),
        );
    }
    let parent = destination
        .parent()
        .filter(|path| path.is_dir())
        .ok_or("Choose an existing export directory.")?;
    let temporary = parent.join(format!(".speech-{}.part", identifier()?));
    let project_id = input["projectId"]
        .as_str()
        .ok_or("Choose a speech project.")?;
    let (project, takes, timing_results) = production_snapshot(service, input)?;
    let format = input["format"].as_str().ok_or("Choose an export format.")?;
    validate_export_input(&project, &takes, input, format)?;
    let result=async{
        match format{
            "archive"=>project_archive::write(service,&project,input,&temporary)?,
            "txt"=>write_new(&temporary,export_text::transcript(&clips(&project,&takes,input)?)?.as_bytes())?,
            "json"=>{
                let selected=clips(&project,&takes,input)?;
                let transcript=export_text::transcript(&selected)?;
                write_new(&temporary,serde_json::to_string_pretty(&json!({"schema":"machdoch-speech-transcript","version":1,"projectId":project["id"],"revisionId":project["revisionId"],"transcript":transcript,"timingResults":timing_results,"clips":selected.iter().map(|(clip,take)|json!({"clip":clip,"take":take})).collect::<Vec<_>>()})).map_err(|_|"Transcript could not be encoded.")?.as_bytes())?;
            },
            "srt"|"vtt"=>write_new(&temporary,subtitles(&project,&takes,input,format)?.as_bytes())?,
            "wav"|"mp3"|"opus"|"flac"|"m4b"=>audio_export::encode(service,&project,&takes,input,&temporary,format).await?,
            _=>return Err("Choose a supported speech export format.".to_string()),
        }
        let result=commit(&temporary,&destination,overwrite)?;
        service.with_store(|store|{store.connection.execute("INSERT INTO speech_exports VALUES(?1,?2,?3,?4)",rusqlite::params![identifier()?,project_id,json!({"input":input,"revisionId":project["revisionId"],"timingResults":timing_results,"output":result}).to_string(),timestamp()]).map_err(|error|error.to_string())?;Ok(())})?;
        Ok(result)
    }.await;
    if temporary.exists() {
        std::fs::remove_file(&temporary)
            .map_err(|_| "The temporary export could not be removed.".to_string())?;
    }
    result
}

fn production_snapshot(
    service: &Arc<SpeechService>,
    input: &Value,
) -> Result<(Value, Value, Value), String> {
    let project_id = input["projectId"]
        .as_str()
        .ok_or("Choose a speech project.")?;
    service.with_store(|store| {
        let current = store.execute("getProject", &json!({"id":project_id}))?;
        let project = if let Some(revision_id) = input["revisionId"].as_str() {
            let data: String = store
                .connection
                .query_row(
                    "SELECT data FROM revisions WHERE project_id=?1 AND id=?2",
                    rusqlite::params![project_id, revision_id],
                    |row| row.get(0),
                )
                .map_err(|_| "The submitted export revision is unavailable.")?;
            serde_json::from_str(&data).map_err(|_| "The submitted export revision is damaged.")?
        } else {
            current
        };
        if input["format"]=="archive" { return Ok((project,json!([]),json!([]))); }
        let explicit=input["takeIds"].as_array().ok_or("Choose explicit production takes or a timeline.")?;
        let ids=if explicit.is_empty(){
            let timeline=project["timeline"].as_array().ok_or("The production timeline is unavailable.")?;
            let selected=input["clipIds"].as_array();
            let mut seen=std::collections::HashSet::new();
            json!(timeline.iter().filter(|clip|selected.is_none_or(|ids|ids.contains(&clip["id"]))).filter_map(|clip|if seen.insert(clip["takeId"].to_string()){Some(clip["takeId"].clone())}else{None}).collect::<Vec<_>>())
        }else{json!(explicit)};
        let mut takes=store.production_takes(project_id,&ids,10_000)?;
        let timings=store.apply_project_timing(&project,&mut takes)?;
        Ok((project,takes,timings))
    })
}

fn validate_export_input(
    project: &Value,
    takes: &Value,
    input: &Value,
    format: &str,
) -> Result<(), String> {
    if input["loudnessLufs"].is_null() != input["truePeakDb"].is_null() {
        return Err("Set both target loudness and true peak, or leave both unset.".into());
    }
    if format == "archive" && input.get("range").is_some() {
        return Err(
            "Portable archives contain the whole project. Clear the export range before archiving."
                .into(),
        );
    }
    if let Some((_, to)) = selected_range(input)? {
        let speech = source_clips(project, takes, input)?;
        let mut duration = speech
            .iter()
            .map(|(clip, _)| {
                Ok(
                    finite(clip, "start", 0.0, f64::MAX)? + finite(clip, "out", 0.0, f64::MAX)?
                        - finite(clip, "in", 0.0, f64::MAX)?,
                )
            })
            .collect::<Result<Vec<f64>, String>>()?
            .into_iter()
            .fold(0.0, f64::max);
        if input["includeBackground"].as_bool().unwrap_or_else(||input["takeIds"].as_array().is_some_and(|ids|ids.is_empty()))
        {
            for clip in project["backgroundTracks"].as_array().into_iter().flatten() {
                duration = duration.max(
                    finite(clip, "start", 0.0, f64::MAX)? + finite(clip, "out", 0.0, f64::MAX)?
                        - finite(clip, "in", 0.0, f64::MAX)?,
                );
            }
        }
        if to > duration + 0.000001 {
            return Err("Choose an export range within the measured timeline.".into());
        }
    }
    Ok(())
}

async fn preview(service: &Arc<SpeechService>, input: &Value) -> Result<Value, String> {
    production_contract::validate(input, true)?;
    let (project, takes, _timing_results) = production_snapshot(service, input)?;
    validate_export_input(&project, &takes, input, "wav")?;
    let mut request = input.clone();
    request
        .as_object_mut()
        .ok_or("The preview request is invalid.")?
        .remove("reuseCache");
    let encoder_digest = hash_file(&encoder()?)?;
    let id=format!("{:x}",Sha256::digest(serde_json::to_vec(&json!({"request":request,"revisionId":project["revisionId"],"encoder":encoder_digest})).map_err(|_|"The preview request could not be encoded.")?));
    if input["reuseCache"] == true {
        let cached = service.with_store(|store| {
            let data: Option<String> = store
                .connection
                .query_row("SELECT data FROM speech_mixes WHERE id=?1", [&id], |row| {
                    row.get(0)
                })
                .optional()
                .map_err(|_| "The mixed-audio cache could not be read.")?;
            data.map(|data| {
                serde_json::from_str::<Value>(&data).map_err(|_| {
                    "The mixed-audio cache is damaged. Rebuild the preview.".to_string()
                })
            })
            .transpose()
        })?;
        if let Some(mut cached) = cached {
            cached["asset"] = service
                .with_store(|store| store.execute("asset", &json!({"id":cached["asset"]["id"]})))?;
            return Ok(cached);
        }
    }
    let path = service
        .with_store(|store| Ok(store.root.join(format!("preview-{}.wav", identifier()?))))?;
    let result=async{
        audio_export::encode(service,&project,&takes,input,&path,"wav").await?;
        let measured=path.clone();let (duration,rate,channels)=tokio::task::spawn_blocking(move||super::reference_audio::inspect_wav(&measured)).await.map_err(|_|"The mixed-audio check stopped.")??;
        super::asset_commit::import(service,&path,duration,rate,channels,None,|store,asset|{
            store.execute("getProject",&json!({"id":project["id"]}))?;
            let result=json!({"id":id,"asset":asset,"projectId":project["id"],"revisionId":project["revisionId"]});
            store.connection.execute("INSERT INTO speech_mixes VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET asset_id=excluded.asset_id,data=excluded.data",rusqlite::params![id,project["id"].as_str(),asset["id"].as_str(),result.to_string()]).map_err(|_|"The mixed-audio preview could not be saved.")?;
            Ok(result)
        })
    }.await;
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|_| "The preview working audio could not be removed.")?;
    }
    result
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|_| "The export file could not be created.".to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "The export could not be saved. Check available disk space.".to_string())
}

fn source_clips(
    project: &Value,
    takes: &Value,
    input: &Value,
) -> Result<Vec<(Value, Value)>, String> {
    let takes = takes.as_array().ok_or("Invalid speech takes")?;
    let timeline = project["timeline"]
        .as_array()
        .ok_or("Invalid production timeline")?;
    if let Some(ids)=input["clipIds"].as_array(){
        return ids.iter().map(|id|{
            let clip=timeline.iter().find(|clip|clip["id"]==*id).ok_or("An explicitly selected timeline clip is unavailable.")?;
            let take=takes.iter().find(|take|take["id"]==clip["takeId"]).ok_or("A selected timeline clip references an unavailable take.")?;
            Ok((clip.clone(),take.clone()))
        }).collect();
    }
    if input["takeIds"]
        .as_array()
        .is_some_and(|ids| ids.is_empty())
        && !timeline.is_empty()
    {
        return timeline
            .iter()
            .map(|clip| {
                takes
                    .iter()
                    .find(|take| take["id"] == clip["takeId"])
                    .cloned()
                    .map(|take| (clip.clone(), take))
                    .ok_or("The timeline references an unavailable take.".to_string())
            })
            .collect();
    }
    if input["takeIds"]
        .as_array()
        .is_some_and(|ids| ids.is_empty())
        && project["backgroundTracks"]
            .as_array()
            .is_some_and(|tracks| !tracks.is_empty())
    {
        return Ok(Vec::new());
    }
    let ids = input["takeIds"]
        .as_array()
        .filter(|ids| !ids.is_empty())
        .ok_or("Select production takes or create a timeline before exporting.")?;
    let mut position = 0f64;
    let mut clips = Vec::new();
    for id in ids {
        let take = takes
            .iter()
            .find(|take| take["id"] == *id)
            .ok_or("A selected take is unavailable.")?;
        let duration = take["asset"]["duration"]
            .as_f64()
            .ok_or("Take duration is missing.")?;
        clips.push((json!({"start":position,"in":0,"out":duration,"gain":1,"fadeIn":0,"fadeOut":0,"track":0}),take.clone()));
        position += duration;
    }
    Ok(clips)
}

pub(super) fn selected_range(input: &Value) -> Result<Option<(f64, f64)>, String> {
    let Some(range) = input.get("range") else {
        return Ok(None);
    };
    let fields = range
        .as_object()
        .ok_or("Submit the export range as start and end values.")?;
    if fields.len() != 2 || !fields.contains_key("from") || !fields.contains_key("to") {
        return Err("Choose only the export range start and end.".into());
    }
    let from = finite(range, "from", 0.0, 7.0 * 24.0 * 3600.0)?;
    let to = finite(range, "to", from, 7.0 * 24.0 * 3600.0)?;
    if to <= from {
        return Err("The export range must end after it starts.".into());
    }
    Ok(Some((from, to)))
}

pub(super) struct ClipWindow {
    pub start: f64,
    pub from: f64,
    pub to: f64,
    pub crop_from: f64,
    pub crop_to: f64,
}

pub(super) fn clip_window(
    clip: &Value,
    range: Option<(f64, f64)>,
) -> Result<Option<ClipWindow>, String> {
    let start = finite(clip, "start", 0.0, 7.0 * 24.0 * 3600.0)?;
    let from = finite(clip, "in", 0.0, f64::MAX)?;
    let to = finite(clip, "out", from, f64::MAX)?;
    if to <= from {
        return Err("Trim out must follow trim in.".into());
    }
    let end = start + to - from;
    let (begin, finish, offset) = range.map_or((start, end, 0.0), |(left, right)| {
        (start.max(left), end.min(right), left)
    });
    if finish <= begin {
        return Ok(None);
    }
    Ok(Some(ClipWindow {
        start: begin - offset,
        from: from + begin - start,
        to: from + finish - start,
        crop_from: begin - start,
        crop_to: finish - start,
    }))
}

fn clips(project: &Value, takes: &Value, input: &Value) -> Result<Vec<(Value, Value)>, String> {
    let range = selected_range(input)?;
    source_clips(project, takes, input)?
        .into_iter()
        .filter_map(|(mut clip, take)| match clip_window(&clip, range) {
            Ok(Some(window)) => {
                clip["start"] = serde_json::json!(window.start);
                clip["in"] = serde_json::json!(window.from);
                clip["out"] = serde_json::json!(window.to);
                Some(Ok((clip, take)))
            }
            Ok(None) => None,
            Err(error) => Some(Err(error)),
        })
        .collect()
}

fn finite(value: &Value, field: &str, min: f64, max: f64) -> Result<f64, String> {
    value[field]
        .as_f64()
        .filter(|value| value.is_finite() && *value >= min && *value <= max)
        .ok_or_else(|| format!("Use a valid {field} value."))
}

fn subtitles(
    project: &Value,
    takes: &Value,
    input: &Value,
    format: &str,
) -> Result<String, String> {
    let mut words = Vec::new();
    for (clip, take) in clips(project, takes, input)? {
        let alignment = take["alignment"]
            .as_array()
            .filter(|values| !values.is_empty())
            .ok_or("Measured alignment is required for every subtitle take.")?;
        let from = clip["in"].as_f64().ok_or("Invalid trim")?;
        let to = clip["out"].as_f64().ok_or("Invalid trim")?;
        let offset = clip["start"].as_f64().ok_or("Invalid timeline time")? - from;
        for word in alignment {
            let start = word["start"].as_f64().ok_or("Invalid word alignment")?;
            let end = word["end"].as_f64().ok_or("Invalid word alignment")?;
            if (start < from && end > from) || (start < to && end > to) {
                return Err("A trim cuts through an aligned word. Adjust the trim or realign the edited audio before exporting subtitles.".to_string());
            }
            if start >= from && end <= to {
                words.push((
                    start + offset,
                    end + offset,
                    word["text"]
                        .as_str()
                        .ok_or("Missing aligned text")?
                        .replace(['\r', '\n'], " ")
                        .replace("-->", "→"),
                ));
            }
        }
    }
    words.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut result = if format == "vtt" {
        "WEBVTT\n\n".to_string()
    } else {
        String::new()
    };
    for (index, (start, end, text)) in words.into_iter().enumerate() {
        if format == "srt" {
            result += &format!("{}\n", index + 1)
        }
        result += &format!(
            "{} --> {}\n{text}\n\n",
            subtitle_time(start, format),
            subtitle_time(end, format)
        );
    }
    Ok(result)
}
fn subtitle_time(seconds: f64, format: &str) -> String {
    let ms = (seconds * 1000.0).round() as u64;
    format!(
        "{:02}:{:02}:{:02}{}{:03}",
        ms / 3600000,
        ms / 60000 % 60,
        ms / 1000 % 60,
        if format == "srt" { "," } else { "." },
        ms % 1000
    )
}
