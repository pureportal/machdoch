use serde_json::{json,Value};
use sha2::{Digest,Sha256};

pub const MODEL:&str="whisper-1";
pub const SAMPLE_RATE:u64=16_000;
pub const CHUNK_SECONDS:f64=600.0;
pub const MAX_WORDS:usize=100_000;

pub fn chunks(duration:f64)->Result<Vec<Value>,String>{
    if !duration.is_finite()||duration<=0.0||duration>7.0*24.0*3600.0{return Err("Choose an audio take within the local seven-day timing guard.".into());}
    let count=(duration/CHUNK_SECONDS).ceil() as usize;
    Ok((0..count).map(|index|{
        let keep_from=index as f64*CHUNK_SECONDS;
        let keep_to=(keep_from+CHUNK_SECONDS).min(duration);
        let from=(keep_from-1.0).max(0.0);
        let to=(keep_to+1.0).min(duration);
        json!({"index":index,"from":from,"to":to,"keepFrom":keep_from,"keepTo":keep_to})
    }).collect())
}

pub fn request_hash(asset_sha:&str,language:Option<&str>,encoder_sha:&str)->String{
    format!("{:x}",Sha256::digest(json!({"assetSha256":asset_sha,"provider":"openai","model":MODEL,"language":language,"response_format":"verbose_json","timestamp_granularities":["word"],"pipeline":1,"encoderSha256":encoder_sha,"sampleRate":SAMPLE_RATE,"channels":1,"chunkSeconds":CHUNK_SECONDS,"overlapSeconds":1}).to_string().as_bytes()))
}

pub fn validate_language(language:&Value)->Result<Option<&str>,String>{
    if language.is_null(){return Ok(None);}
    let language=language.as_str().filter(|language|language.len()==2&&language.bytes().all(|byte|byte.is_ascii_lowercase())).ok_or("Use a two-letter language hint or leave it unset for detection.")?;
    Ok(Some(language))
}

pub fn estimate(pricing:&Value,chunks:&[Value],at:chrono::NaiveDate)->Result<Option<f64>,String>{
    if pricing.is_null(){return Ok(None);}
    let fields=pricing.as_object().ok_or("Enter a duration price record.")?;
    let required=["perMinute","billingIncrementSeconds","currency","source","effectiveFrom","effectiveTo"];
    if fields.len()!=required.len()||required.iter().any(|key|!fields.contains_key(*key)){return Err("Include the rate, billing increment, currency, source and effective dates.".into());}
    let rate=pricing["perMinute"].as_f64().filter(|rate|rate.is_finite()&&(0.0..=1_000_000.0).contains(rate)).ok_or("Enter a nonnegative rate per minute.")?;
    let increment=pricing["billingIncrementSeconds"].as_u64().filter(|increment|(1..=3600).contains(increment)).ok_or("Enter the verified billing increment in seconds, from 1 to 3,600.")? as f64;
    if pricing["currency"].as_str().is_none_or(|currency|currency.len()!=3||!currency.bytes().all(|byte|byte.is_ascii_uppercase())){return Err("Use a three-letter uppercase billing currency.".into());}
    if pricing["source"].as_str().is_none_or(|source|source.trim().is_empty()||source.len()>4096||source.chars().any(char::is_control)){return Err("Record the source of this transcription rate.".into());}
    let mut dates=Vec::new();
    for field in ["effectiveFrom","effectiveTo"]{let value=pricing[field].as_str().ok_or("Enter effective pricing dates.")?;let date=chrono::NaiveDate::parse_from_str(value,"%Y-%m-%d").map_err(|_|"Use YYYY-MM-DD pricing dates.")?;if date.format("%Y-%m-%d").to_string()!=value{return Err("Use YYYY-MM-DD pricing dates.".into());}dates.push(date);}
    if dates[0]>dates[1]||at<dates[0]||at>dates[1]{return Err("The transcription rate is outside its effective dates. Verify the current account rate.".into());}
    let seconds=chunks.iter().map(|chunk|{
        let seconds=chunk["to"].as_f64().ok_or("The transcription chunk end is missing.")?-chunk["from"].as_f64().ok_or("The transcription chunk start is missing.")?;
        Ok((seconds/increment).ceil()*increment)
    }).collect::<Result<Vec<f64>,String>>()?.iter().sum::<f64>();
    Ok(Some(seconds/60.0*rate))
}

pub fn parse_chunk(response:&Value,chunk:&Value,total_duration:f64)->Result<Value,String>{
    let text=response["text"].as_str().filter(|text|text.len()<=2*1024*1024).ok_or("The transcription response is missing its transcript.")?;
    let words=response["words"].as_array().filter(|words|words.len()<=MAX_WORDS).ok_or("The selected transcription model returned no valid word timestamps.")?;
    if !text.trim().is_empty()&&words.is_empty(){return Err("This transcription has text but no word timing. Choose the timestamp-capable model explicitly.".into());}
    let from=chunk["from"].as_f64().ok_or("The transcription chunk start is missing.")?;
    let to=chunk["to"].as_f64().ok_or("The transcription chunk end is missing.")?;
    let keep_from=chunk["keepFrom"].as_f64().ok_or("The transcription retention window is missing.")?;
    let keep_to=chunk["keepTo"].as_f64().ok_or("The transcription retention window is missing.")?;
    let mut retained=Vec::new();
    let mut previous=0.0;
    for word in words{
        let word_text=word["word"].as_str().filter(|text|!text.trim().is_empty()&&text.len()<=4096).ok_or("The transcription returned an invalid timed word.")?;
        let start=word["start"].as_f64().filter(|value|value.is_finite()&&*value>=previous).ok_or("The transcription word order or start time is invalid.")?;
        let end=word["end"].as_f64().filter(|value|value.is_finite()&&*value>=start&&*value<=to-from).ok_or("The transcription word extends outside its measured audio chunk.")?;
        previous=start;
        let midpoint=from+(start+end)/2.0;
        if midpoint<keep_from||midpoint>=keep_to&&keep_to<total_duration{continue;}
        if from+end>total_duration{return Err("The transcription timing extends beyond the source take.".into());}
        retained.push(json!({"text":word_text,"start":from+start,"end":from+end}));
    }
    let usage=match response.get("usage"){
        None=>Value::Null,
        Some(usage) if usage["type"]=="duration"=>json!({"type":"duration","seconds":usage["seconds"].as_f64().filter(|value|value.is_finite()&&*value>=0.0).ok_or("The provider's duration usage is invalid.")?}),
        Some(_)=>return Err("The timestamp model returned an unexpected usage contract.".into()),
    };
    let language=match response.get("language"){None=>Value::Null,Some(language)=>json!(language.as_str().filter(|value|!value.is_empty()&&value.len()<=128).ok_or("The detected language is invalid.")?)};
    Ok(json!({"providerText":text,"words":retained,"language":language,"usage":usage,"responseSha256":format!("{:x}",Sha256::digest(response.to_string().as_bytes()))}))
}

pub fn combine(chunks:&[Value],duration:f64)->Result<Value,String>{
    let mut words=Vec::new();let mut previous=0.0;let mut text_bytes=0usize;
    for chunk in chunks{
        for word in chunk["words"].as_array().ok_or("A completed transcription chunk is damaged.")?{
            let fields=word.as_object().ok_or("A timed word is invalid.")?;
            if fields.len()!=3||!["text","start","end"].iter().all(|key|fields.contains_key(*key))||word["text"].as_str().is_none_or(|text|text.trim().is_empty()||text.len()>4096){return Err("A timed word contains invalid transcript data.".into());}
            text_bytes+=word["text"].as_str().ok_or("A timed word is damaged.")?.len()+1;if text_bytes>4*1024*1024{return Err("The timed transcript exceeds the local 4 MiB text guard. Transcribe shorter takes.".into());}
            let start=word["start"].as_f64().filter(|start|start.is_finite()&&*start>=previous).ok_or("Chunk timing overlaps out of order. Review the transcription before retrying.")?;
            let end=word["end"].as_f64().filter(|end|end.is_finite()&&*end>=start&&*end<=duration).ok_or("A transcription word exceeds the source duration.")?;
            previous=start;let _=end;
            if words.len()>=MAX_WORDS{return Err("The transcription exceeds the local 100,000-word take guard. Align shorter production takes.".into());}
            words.push(word.clone());
        }
    }
    let text=words.iter().map(|word|word["text"].as_str().ok_or("A timed word is damaged.")).collect::<Result<Vec<_>,_>>()?.join(" ");
    Ok(json!({"transcript":text,"words":words}))
}

#[cfg(test)]
#[path="transcript_timing_tests.rs"]
mod tests;
