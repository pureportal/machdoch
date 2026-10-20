use super::*;
use serde_json::json;

fn response(parts:Value)->Value{json!({"candidates":[{"finishReason":"STOP","content":{"parts":parts}}]})}

#[test]
fn google_audio_preserves_every_ordered_part_and_buffers_incomplete_pcm_frames(){
    let part=|bytes:&[u8]|json!({"inlineData":{"mimeType":"audio/L16;codec=pcm;rate=24000","data":STANDARD.encode(bytes)}});
    let value=response(json!([part(&[1]),part(&[0,2]),part(&[0])]));
    assert_eq!(pcm(&value).unwrap(),[1,0,2,0]);
    assert_eq!(&super::super::pcm::wav_header(4).unwrap()[24..28],&24_000u32.to_le_bytes());
}

#[test]
fn google_audio_rejects_incomplete_ambiguous_internal_and_mismatched_formats_without_echoing_provider_content(){
    let valid=response(json!([{"inlineData":{"mimeType":"audio/L16;rate=24000","data":STANDARD.encode([1,0])}}]));
    let mut invalid=Vec::new();
    for reason in ["OTHER","MAX_TOKENS","SAFETY"]{let mut value=valid.clone();value["candidates"][0]["finishReason"]=json!(reason);value["candidates"][0]["finishMessage"]=json!("private transcript must not be echoed");invalid.push(value);}
    let mut value=valid.clone();value["candidates"][0].as_object_mut().unwrap().remove("finishReason");invalid.push(value);
    let mut value=valid.clone();value["candidates"].as_array_mut().unwrap().push(valid["candidates"][0].clone());invalid.push(value);
    let mut value=valid.clone();value["candidates"][0]["content"]["parts"][0]["thought"]=json!(true);invalid.push(value);
    let mut value=valid.clone();value["candidates"][0]["content"]["parts"][0]["thought"]=json!("true");invalid.push(value);
    let mut value=valid.clone();value["candidates"][0]["content"]["parts"][0]["thoughtSignature"]=json!("private transcript must not be echoed");invalid.push(value);
    let mut value=valid.clone();value["candidates"][0]["content"]["parts"][0]["text"]=json!("private transcript must not be echoed");invalid.push(value);
    let mut value=valid.clone();value["promptFeedback"]=json!({"blockReason":"private transcript must not be echoed"});invalid.push(value);
    for mime in ["audio/unknown","audio/wav","audio/L16;rate=16000","audio/L16;channels=2","audio/L16;codec=mp3","audio/L16;rate=24000;rate=24000"]{let mut value=valid.clone();value["candidates"][0]["content"]["parts"][0]["inlineData"]["mimeType"]=json!(mime);invalid.push(value);}
    for data in ["","!bad!",&STANDARD.encode([1])]{let mut value=valid.clone();value["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]=json!(data);invalid.push(value);}
    invalid.push(response(json!([])));invalid.push(response(json!([{"text":"private transcript must not be echoed"}])));
    for value in invalid{let error=pcm(&value).unwrap_err();assert!(!error.contains("private transcript"));}
}
