use super::*;

#[test]
fn timing_windows_cover_the_take_once_with_bounded_overlap(){
    let plan=chunks(1200.25).unwrap();assert_eq!(plan.len(),3);
    assert_eq!(plan[0],json!({"index":0,"from":0.0,"to":601.0,"keepFrom":0.0,"keepTo":600.0}));
    assert_eq!(plan[1],json!({"index":1,"from":599.0,"to":1200.25,"keepFrom":600.0,"keepTo":1200.0}));
    assert_eq!(plan[2],json!({"index":2,"from":1199.0,"to":1200.25,"keepFrom":1200.0,"keepTo":1200.25}));
    for duration in [0.0,-1.0,f64::NAN,f64::INFINITY,7.0*24.0*3600.0+1.0]{assert!(chunks(duration).is_err());}
}

#[test]
fn duration_pricing_counts_uploaded_overlap_and_verified_billing_increments(){
    let plan=chunks(601.0).unwrap();
    let price=json!({"perMinute":0.006,"billingIncrementSeconds":60,"currency":"USD","source":"Synthetic contract fixture","effectiveFrom":"2000-01-01","effectiveTo":"2099-01-01"});
    assert!((estimate(&price,&plan,chrono::Utc::now().date_naive()).unwrap().unwrap()-0.072).abs()<1e-12);
    assert_eq!(estimate(&Value::Null,&plan,chrono::Utc::now().date_naive()).unwrap(),None);
    for (field,value) in [("perMinute",json!(-1)),("billingIncrementSeconds",json!(0)),("currency",json!("usd")),("source",json!("")),("effectiveFrom",json!("2099-01-01")),("effectiveTo",json!("2000-01-01"))]{let mut invalid=price.clone();invalid[field]=value;assert!(estimate(&invalid,&plan,chrono::Utc::now().date_naive()).is_err());}
}

#[test]
fn overlap_retention_preserves_repeated_words_without_synthesizing_boundaries(){
    let windows=chunks(601.0).unwrap();
    let first=parse_chunk(&json!({"text":"Again again","words":[{"word":"Again","start":599.1,"end":599.5},{"word":"again","start":600.1,"end":600.5}],"language":"english","usage":{"type":"duration","seconds":601}}),&windows[0],601.0).unwrap();
    let second=parse_chunk(&json!({"text":"Again again","words":[{"word":"Again","start":0.1,"end":0.5},{"word":"again","start":1.1,"end":1.5}],"language":"english"}),&windows[1],601.0).unwrap();
    let result=combine(&[first,second],601.0).unwrap();assert_eq!(result["transcript"],"Again again");assert_eq!(result["words"].as_array().unwrap().len(),2);assert_eq!(result["words"][1]["start"],600.1);
}

#[test]
fn timing_requires_measured_ordered_word_data_and_reports_absent_timestamps(){
    let window=&chunks(1.0).unwrap()[0];
    for response in [json!({"text":"Hello"}),json!({"text":"Hello","words":[]}),json!({"text":"Hello","words":[{"word":"Hello","start":0,"end":2}]}),json!({"text":"Hello","words":[{"word":"Hello","start":0.8,"end":0.9},{"word":"there","start":0.1,"end":0.2}]}),json!({"text":"Hello","words":[{"word":"Hello","start":0,"end":1}],"usage":{"type":"tokens"}})]{assert!(parse_chunk(&response,window,1.0).is_err());}
    let silence=parse_chunk(&json!({"text":"","words":[]}),window,1.0).unwrap();assert!(combine(&[silence],1.0).unwrap()["words"].as_array().unwrap().is_empty());
}

#[test]
fn timing_identity_pins_audio_language_model_and_preprocessing(){
    let original=request_hash("audio",Some("de"),"encoder");
    assert_ne!(original,request_hash("other",Some("de"),"encoder"));assert_ne!(original,request_hash("audio",Some("en"),"encoder"));assert_ne!(original,request_hash("audio",Some("de"),"new-encoder"));
    assert!(validate_language(&json!("de-DE")).is_err());assert!(validate_language(&json!("DE")).is_err());assert_eq!(validate_language(&Value::Null).unwrap(),None);assert_eq!(validate_language(&json!("de")).unwrap(),Some("de"));
}

#[test]
fn word_timing_cannot_extend_past_the_source_even_within_one_resampled_frame(){
    let window=&chunks(1.0).unwrap()[0];
    let outside=1.0+0.5/SAMPLE_RATE as f64;
    assert!(parse_chunk(&json!({"text":"word","words":[{"word":"word","start":0.5,"end":outside}]}),window,1.0).is_err());
    assert!(combine(&[json!({"words":[{"text":"word","start":0.5,"end":outside}]})],1.0).is_err());
    assert!(parse_chunk(&json!({"text":"word","words":[{"word":"word","start":0.5,"end":1.0}]}),window,1.0).is_ok());
}
