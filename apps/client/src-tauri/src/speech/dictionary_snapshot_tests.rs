use super::*;

struct Directory(std::path::PathBuf);

impl Directory{
    fn new()->Self{let mut bytes=[0u8;16];getrandom::fill(&mut bytes).unwrap();Self(std::env::temp_dir().join(format!("speech-dictionaries-{:x}",u128::from_le_bytes(bytes))))}
    fn open(&self)->SpeechStore{SpeechStore::open(self.0.clone()).unwrap()}
}

impl Drop for Directory{fn drop(&mut self){std::fs::remove_dir_all(&self.0).unwrap();}}

fn dictionary()->Value{json!({"id":"dict","name":"Names","revision":"","rules":[{"id":"rule","text":"Machdoch","phonemes":"M AA K","alphabet":"arpabet","caseSensitive":true}]})}

fn profile()->Value{json!({"id":"profile","name":"Test","backend":"fish-cloud","model":"drama-3","voiceId":"voice","direction":"calm","normalize":false,"temperature":0.7,"topP":0.7,"chunkLength":300,"minChunkLength":50,"latency":"normal","dictionaryIds":["dict"],"playbackRate":1})}

fn snapshot(store:&SpeechStore,id:&str)->Value{let data:String=store.connection.query_row("SELECT snapshot FROM speech_requests WHERE job_id=?1",[id],|row|row.get(0)).unwrap();serde_json::from_str(&data).unwrap()}

#[test]
fn history_pages_preserve_order_and_pin_old_rules_without_changing_saved_profiles_or_dictionaries(){
    let directory=Directory::new();let mut store=directory.open();
    let first=store.execute("saveDictionary",&json!({"dictionary":dictionary()})).unwrap();
    let mut edit=first.clone();edit["rules"][0]["phonemes"]=json!("M AA K D AA K");let second=store.execute("saveDictionary",&json!({"dictionary":edit})).unwrap();
    let profile=profile();store.execute("saveProfile",&json!({"profile":profile})).unwrap();
    let page=store.execute("dictionaryRevisions",&json!({"id":"dict","offset":0,"limit":1})).unwrap();assert_eq!(page["total"],2);assert_eq!(page["revisions"],json!([second]));
    assert_eq!(store.execute("dictionaryRevisions",&json!({"id":"dict","offset":1,"limit":1})).unwrap()["revisions"],json!([first]));
    assert_eq!(store.execute("dictionaryRevisions",&json!({"id":"dict","offset":2,"limit":1})).unwrap()["revisions"],json!([]));
    assert!(store.execute("dictionaryRevisions",&json!({"id":"dict","offset":0,"limit":101})).is_err());
    let base=json!({"owner":"rehearsal","projectId":null,"revisionId":"rehearsal-source","profileId":"profile","segments":[{"id":"context","text":"<|speaker:0|>Hello Machdoch.","spokenText":"Hello Machdoch.","chapter":null,"voiceIds":["voice"],"referenceAssetIds":[]}],"takes":1,"priority":100,"reuseCache":false,"cloudConsent":true,"budgetLimit":null});
    let settings=json!({"connections":[{"backend":"fish-cloud","model":"drama-3","configured":true}],"cloudConsent":true,"answerCharacterLimit":1000,"pricing":null,"budgetLimit":null,"answerBudgetLimit":null});
    let mut old=base.clone();old["dictionaryRevisions"]=json!([{"id":"dict","revision":first["revision"]}]);
    super::super::admission::admit(&mut store,old,settings.clone(),"2026-10-20T00:00:00.000Z".into(),"old".into()).unwrap();
    assert_eq!(snapshot(&store,"old")["dictionaries"],json!([first]));assert_eq!(snapshot(&store,"old")["profile"]["normalize"],false);
    let mut baseline=base.clone();baseline["dictionaryRevisions"]=json!([]);
    super::super::admission::admit(&mut store,baseline,settings.clone(),"2026-10-20T00:00:00.000Z".into(),"baseline".into()).unwrap();
    assert_eq!(snapshot(&store,"baseline")["dictionaries"],json!([]));assert_eq!(snapshot(&store,"baseline")["profile"]["dictionaryIds"],json!([]));
    assert_eq!(store.execute("listProfiles",&json!({})).unwrap(),json!([profile]));assert_eq!(store.execute("listDictionaries",&json!({})).unwrap(),json!([second]));
    for selection in [json!([{"id":"dict","revision":"missing"}]),json!([{"id":"dict","revision":first["revision"]},{"id":"dict","revision":second["revision"]}])]{
        let mut invalid=base.clone();invalid["dictionaryRevisions"]=selection;assert!(super::super::admission::admit(&mut store,invalid,settings.clone(),"2026-10-20T00:00:00.000Z".into(),"invalid".into()).is_err());
    }
    assert_eq!(store.connection.query_row("SELECT count(*) FROM jobs",[],|row|row.get::<_,i64>(0)).unwrap(),2);
}

#[test]
fn native_dictionary_validation_rejects_bad_notation_and_counts_unicode_characters(){
    let mut valid=dictionary();valid["rules"][0]["text"]=json!("世".repeat(256));validate_rules(&valid).unwrap();
    valid["rules"][0]["text"]=json!("世".repeat(257));assert!(validate_rules(&valid).is_err());
    for (alphabet,value,expected) in [("arpabet","HH AH0",true),("arpabet","HH2",false),("arpabet","AH00",false),("pinyin","ni3 hao3",true),("pinyin","nǐ hǎo",true),("pinyin","ni9",false),("pinyin","×",false),("romaji","ha0shi1ga0",true),("romaji","ha01shi",false),("romaji","shi2",false)]{assert_eq!(valid_phonemes(value,alphabet),expected,"{alphabet}: {value}");}
    let mut first=dictionary();first["rules"][0]["caseSensitive"]=json!(false);let mut second=first.clone();second["rules"][0]["text"]=json!("MACHDOCH");second["rules"][0]["phonemes"]=json!("M AE K");assert!(validate_set(&[first,second]).is_err());
    let directory=Directory::new();let mut store=directory.open();let mut invalid=dictionary();invalid["rules"][0]["alphabet"]=json!("romaji");invalid["rules"][0]["phonemes"]=json!("ha01shi");assert!(store.execute("saveDictionary",&json!({"dictionary":invalid})).is_err());
}
