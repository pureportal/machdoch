use super::*;

#[test]
fn provider_response_preserves_only_self_hosted_request_completion_and_actual_token_counts(){
    let value=sglang("runtime-request",&json!({"type":"speech.audio.done","finish_reason":"stop","usage":{"input_tokens":0,"output_tokens":4,"total_tokens":4,"private":"PRIVATE_CONTENT"}})).unwrap();assert_eq!(value,json!({"provider":"sglang","requestId":"runtime-request","finishReason":"stop","usage":{"input_tokens":0,"output_tokens":4,"total_tokens":4}}));validate(&value,"sglang").unwrap();assert!(!value.to_string().contains("PRIVATE"));assert_eq!(sglang("request",&json!({"type":"speech.audio.done","finish_reason":"stop","usage":null})).unwrap(),json!({"provider":"sglang","requestId":"request","finishReason":"stop"}));
    for terminal in [json!({"type":"speech.audio.done","finish_reason":"length"}),json!({"type":"speech.audio.done","finish_reason":"stop","usage":{"input_tokens":-1}})]{assert!(sglang("request",&terminal).is_err());}let mut forged=value;forged["modelVersion"]=json!("invented");assert!(validate(&forged,"sglang").is_err());
}

#[test]
fn provider_response_retains_actual_google_model_ids_and_counts_without_copying_private_content_or_inventing_missing_usage(){
    let response=json!({"modelVersion":"gemini-3.1-flash-tts-preview","responseId":"response-123","usageMetadata":{"promptTokenCount":5,"cachedContentTokenCount":0,"candidatesTokenCount":8,"totalTokenCount":13,"privateDebug":"PRIVATE_USAGE_DEBUG"},"candidates":[{"content":{"parts":[{"text":"PRIVATE_SPOKEN_CONTENT"}]}}],"privateHeader":"PRIVATE_KEY"});
    let evidence=google(&response).unwrap();assert_eq!(evidence,json!({"provider":"google","modelVersion":"gemini-3.1-flash-tts-preview","responseId":"response-123","usageMetadata":{"promptTokenCount":5,"cachedContentTokenCount":0,"candidatesTokenCount":8,"totalTokenCount":13}}));validate(&evidence,"google").unwrap();assert!(!evidence.to_string().contains("PRIVATE_"));
    assert!(google(&json!({})).unwrap().is_null());assert!(google(&json!({"usageMetadata":{"privateDebug":"PRIVATE"}})).unwrap().is_null());
    assert_eq!(google(&json!({"responseId":"reported","usageMetadata":{"promptTokenCount":null}})).unwrap(),json!({"provider":"google","responseId":"reported"}));
}

#[test]
fn provider_response_rejects_invalid_metadata_and_mismatched_or_extra_stored_fields(){
    for response in [json!({"modelVersion":"invalid\nversion"}),json!({"responseId":42}),json!({"usageMetadata":false}),json!({"usageMetadata":{"promptTokenCount":-1}}),json!({"usageMetadata":{"totalTokenCount":1.5}}),json!({"usageMetadata":{"candidatesTokenCount":true}}),json!({"usageMetadata":{"totalTokenCount":9_007_199_254_740_992u64}})]{assert!(google(&response).is_err());}
    let evidence=google(&json!({"responseId":"returned"})).unwrap();assert!(validate(&evidence,"openai").is_err());assert!(validate(&evidence,"fish-cloud").is_err());let mut extra=evidence;extra["private"]=json!("forbidden");assert!(validate(&extra,"google").is_err());
    assert!(validate(&json!({"provider":"google","usageMetadata":{"unknown":5}}),"google").is_err());
}

#[test]
fn provider_response_captures_only_documented_openai_ids_and_processing_time_headers(){
    let mut headers=reqwest::header::HeaderMap::new();headers.insert("x-request-id","req-returned".parse().unwrap());headers.insert("openai-processing-ms","12.5".parse().unwrap());headers.insert("authorization","Bearer PRIVATE".parse().unwrap());headers.insert("openai-organization","PRIVATE_ORGANIZATION".parse().unwrap());
    let evidence=openai(&headers).unwrap();assert_eq!(evidence,json!({"provider":"openai","requestId":"req-returned","processingMs":12.5}));validate(&evidence,"openai").unwrap();assert!(!evidence.to_string().contains("PRIVATE"));assert!(openai(&reqwest::header::HeaderMap::new()).unwrap().is_null());
    for time in ["NaN","-1","Infinity","invalid"]{headers.insert("openai-processing-ms",time.parse().unwrap());assert!(openai(&headers).is_err());}
}
