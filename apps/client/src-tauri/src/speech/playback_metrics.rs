use super::*;
use std::collections::BTreeMap;

pub(super) fn schema(connection:&Connection)->Result<(),String>{
    connection.execute_batch("CREATE TABLE IF NOT EXISTS speech_playback_measurements(id TEXT PRIMARY KEY,owner TEXT NOT NULL,session_id TEXT NOT NULL,event TEXT NOT NULL,recorded_at TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE INDEX IF NOT EXISTS speech_playback_measurement_owner ON speech_playback_measurements(owner,recorded_at,id);
        CREATE INDEX IF NOT EXISTS speech_playback_measurement_retention ON speech_playback_measurements(recorded_at,id);").map_err(error)
}

fn metric_id(value:&Value,field:&str)->Result<(),String>{
    let id=text(value,field,36,36)?;
    if id.bytes().enumerate().any(|(index,byte)|if [8,13,18,23].contains(&index){byte!=b'-'}else{!byte.is_ascii_hexdigit()}){return Err("A playback measurement identifier is invalid.".into());}Ok(())
}

fn number(value:&Value,field:&str,maximum:f64)->Result<f64,String>{
    value[field].as_f64().filter(|value|value.is_finite()&&*value>=0.0&&*value<=maximum).ok_or_else(||format!("The playback measurement {field} is invalid."))
}

fn transport(value:&Value)->Result<&str,String>{
    value["outputTransport"].as_str().filter(|value|matches!(*value,"pcm"|"html-audio"|"system")).ok_or("Choose a measured playback transport.".into())
}

fn validate(value:&Value)->Result<(),String>{
    metric_id(value,"id")?;metric_id(value,"sessionId")?;number(value,"atMs",315_576_000_000.0)?;
    let event=text(value,"event",1,32)?;
    let mut allowed=vec!["id","sessionId","atMs","event"];
    match event{
        "intent"=>{},
        "opened"=>{allowed.extend(["openLatencyMs","outputTransport"]);number(value,"openLatencyMs",315_576_000_000.0)?;if value.get("outputTransport").is_some(){transport(value)?;}},
        "first-render"=>{allowed.extend(["outputTransport","timeToFirstAudioMs","openToFirstAudioMs"]);transport(value)?;let total=number(value,"timeToFirstAudioMs",315_576_000_000.0)?;if number(value,"openToFirstAudioMs",315_576_000_000.0)?>total{return Err("The first-render measurement clocks disagree.".into());}},
        "first-samples"=>{allowed.extend(["outputTransport","timeToFirstSamplesMs"]);if transport(value)?!="pcm"{return Err("Only PCM reports sample receipt measurements.".into());}number(value,"timeToFirstSamplesMs",315_576_000_000.0)?;},
        "pause-ack"|"stop-ack"=>{allowed.extend(["outputTransport","latencyMs"]);transport(value)?;number(value,"latencyMs",315_576_000_000.0)?;},
        "pcm-buffer"=>{
            allowed.extend(["outputTransport","sampleRate","maxBufferedFrames","maxBufferedAudioMs","underrunFrames","underrunCount"]);
            if transport(value)?!="pcm"{return Err("Only PCM reports ring-buffer measurements.".into());}
            let rate=required(value,"sampleRate")?.as_u64().filter(|rate|(8000..=192000).contains(rate)).ok_or("The playback measurement sample rate is invalid.")?;
            let frames=required(value,"maxBufferedFrames")?.as_u64().filter(|frames|*frames<=rate*5).ok_or("The playback measurement exceeds the five-second buffer.")?;
            let duration=number(value,"maxBufferedAudioMs",5000.0)?;if (duration-frames as f64/rate as f64*1000.0).abs()>0.000001{return Err("The playback buffer duration differs from its measured frames.".into());}
            let underrun=required(value,"underrunFrames")?.as_u64().filter(|frames|*frames<=9_007_199_254_740_991).ok_or("The underrun frame count is invalid.")?;
            required(value,"underrunCount")?.as_u64().filter(|count|*count<=underrun).ok_or("The underrun count is invalid.")?;
        },
        _=>return Err("Choose a supported playback measurement event.".into()),
    }
    fields(value,&allowed)
}

impl SpeechStore{
    pub(super) fn record_playback_metrics(&mut self,input:&Value,now:&str)->Result<Value,String>{
        fields(input,&["owner","samples"])?;let owner=text(input,"owner",1,512)?;parse_time(now)?;
        let samples=array(input,"samples",32)?;if samples.is_empty(){return Err("Supply at least one playback measurement.".into());}for sample in samples{validate(sample)?;}
        let transaction=self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
        for sample in samples{
            transaction.execute("INSERT INTO speech_playback_measurements VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO NOTHING",params![text(sample,"id",36,36)?,owner,text(sample,"sessionId",36,36)?,text(sample,"event",1,32)?,now,encode(sample)?]).map_err(error)?;
        }
        transaction.execute("DELETE FROM speech_playback_measurements WHERE julianday(recorded_at)<julianday(?1)-30",[now]).map_err(error)?;
        transaction.execute("DELETE FROM speech_playback_measurements WHERE owner=?1 AND id IN(SELECT id FROM speech_playback_measurements WHERE owner=?1 ORDER BY recorded_at DESC,id DESC LIMIT -1 OFFSET 2000)",[owner]).map_err(error)?;
        transaction.execute("DELETE FROM speech_playback_measurements WHERE id IN(SELECT id FROM speech_playback_measurements ORDER BY recorded_at DESC,id DESC LIMIT -1 OFFSET 10000)",[]).map_err(error)?;
        transaction.commit().map_err(error)?;Ok(Value::Null)
    }

    pub(crate) fn playback_performance(&self,owner:Option<&str>)->Result<Value,String>{
        let mut statement=self.connection.prepare("SELECT data,recorded_at FROM speech_playback_measurements WHERE (?1 IS NULL OR owner=?1) ORDER BY recorded_at DESC,id DESC LIMIT 10000").map_err(error)?;
        let rows=statement.query_map([owner],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).map_err(error)?;
        let mut groups:BTreeMap<(String,String),Vec<f64>>=BTreeMap::new();let mut buffers:BTreeMap<String,BTreeMap<String,f64>>=BTreeMap::new();let mut count=0;let mut oldest=None;let mut newest=None;
        for row in rows{
            let (data,recorded_at)=row.map_err(error)?;let sample=parse_json(data)?;validate(&sample)?;count+=1;if newest.is_none(){newest=Some(recorded_at.clone());}oldest=Some(recorded_at);
            let transport=sample["outputTransport"].as_str().unwrap_or("unreported");
            if sample["event"]=="pcm-buffer"{
                let values=buffers.entry(text(&sample,"sessionId",36,36)?.into()).or_default();
                for field in ["maxBufferedAudioMs","underrunFrames","underrunCount"]{let value=number(&sample,field,9_007_199_254_740_991.0)?;values.entry(field.into()).and_modify(|previous|*previous=previous.max(value)).or_insert(value);}
                continue;
            }
            let fields: &[&str]=match sample["event"].as_str(){Some("opened")=>&["openLatencyMs"],Some("first-render")=>&["timeToFirstAudioMs","openToFirstAudioMs"],Some("first-samples")=>&["timeToFirstSamplesMs"],Some("pause-ack"|"stop-ack")=>&["latencyMs"],Some("pcm-buffer")=>&["maxBufferedAudioMs","underrunFrames","underrunCount"],_=>&[]};
            for field in fields{if let Some(number)=sample[*field].as_f64(){let name=if *field=="latencyMs"{format!("{}LatencyMs",sample["event"].as_str().ok_or("A playback event is missing.")?)}else{field.to_string()};groups.entry((transport.into(),name)).or_default().push(number);}}
        }
        for values in buffers.into_values(){for (field,value) in values{groups.entry(("pcm".into(),field)).or_default().push(value);}}
        let groups=groups.into_iter().map(|((transport,metric),mut values)|{values.sort_by(f64::total_cmp);let percentile=|percent:usize|values[(values.len()*percent).div_ceil(100)-1];let aggregation=if matches!(metric.as_str(),"maxBufferedAudioMs"|"underrunFrames"|"underrunCount"){"session-maximum"}else{"event-observations"};json!({"transport":transport,"metric":metric,"aggregation":aggregation,"count":values.len(),"p50":percentile(50),"p95":percentile(95)})}).collect::<Vec<_>>();
        Ok(json!({"scope":"browser-runtime","sampleCount":count,"oldestRecordedAt":oldest,"newestRecordedAt":newest,"groups":groups}))
    }
}
