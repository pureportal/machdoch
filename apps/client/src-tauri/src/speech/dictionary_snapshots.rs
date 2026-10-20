use super::store::SpeechStore;
use rusqlite::{params,OptionalExtension};
use serde_json::{json,Value};
use std::collections::{HashMap,HashSet};

fn identity(value:&Value)->Result<&str,String>{
    value.as_str().filter(|value|!value.is_empty()&&value.len()<=128&&value.bytes().all(|byte|byte.is_ascii_alphanumeric()||b"_-".contains(&byte))).ok_or_else(||"Choose a saved dictionary and revision.".into())
}

pub fn list(store:&SpeechStore,input:&Value)->Result<Value,String>{
    let fields=input.as_object().ok_or("Choose a dictionary history page.")?;
    if fields.len()!=3||fields.keys().any(|field|!matches!(field.as_str(),"id"|"offset"|"limit")){return Err("Supply a dictionary ID, offset and page limit.".into());}
    let id=identity(&input["id"])?;
    let offset=input["offset"].as_u64().filter(|value|*value<=i64::MAX as u64).ok_or("Use a nonnegative dictionary history offset.")?;
    let limit=input["limit"].as_u64().filter(|value|(1..=100).contains(value)).ok_or("Use a dictionary history page of 1 to 100 revisions.")?;
    let total:i64=store.connection.query_row("SELECT count(*) FROM dictionary_revisions WHERE dictionary_id=?1",[id],|row|row.get(0)).map_err(|error|error.to_string())?;
    if total==0{return Err("The dictionary is unavailable. Reload the saved dictionaries.".into());}
    let mut statement=store.connection.prepare("SELECT data FROM dictionary_revisions WHERE dictionary_id=?1 ORDER BY rowid DESC LIMIT ?2 OFFSET ?3").map_err(|error|error.to_string())?;
    let rows=statement.query_map(params![id,limit as i64,offset as i64],|row|row.get::<_,String>(0)).map_err(|error|error.to_string())?;
    let revisions=rows.map(|data|serde_json::from_str::<Value>(&data.map_err(|error|error.to_string())?).map_err(|_|"A dictionary revision is damaged.".to_owned())).collect::<Result<Vec<_>,_>>()?;
    Ok(json!({"revisions":revisions,"total":total}))
}

pub fn resolve(store:&SpeechStore,input:&Value,profile:&mut Value)->Result<Option<Vec<Value>>,String>{
    let Some(selection)=input.get("dictionaryRevisions")else{return Ok(None)};
    if profile["backend"]!="fish-cloud"{return Err("Pinned dictionary rendering requires Fish Cloud.".into());}
    let selection=selection.as_array().filter(|values|values.len()<=3).ok_or("Choose up to three pinned dictionary revisions.")?;
    let mut dictionaries=Vec::new();let mut ids=HashSet::new();let mut ordered=Vec::new();
    for item in selection{
        let fields=item.as_object().ok_or("Choose a saved dictionary revision.")?;
        if fields.len()!=2||fields.keys().any(|field|!matches!(field.as_str(),"id"|"revision")){return Err("Supply only the dictionary ID and immutable revision.".into());}
        let id=identity(&item["id"])?;let revision=identity(&item["revision"])?;
        if !ids.insert(id){return Err("Choose only one revision of each dictionary in a request.".into());}
        let data:String=store.connection.query_row("SELECT data FROM dictionary_revisions WHERE dictionary_id=?1 AND revision=?2",params![id,revision],|row|row.get(0)).optional().map_err(|error|error.to_string())?.ok_or("This dictionary revision is unavailable. Reload its history before rendering.")?;
        let dictionary:Value=serde_json::from_str(&data).map_err(|_|"The pinned dictionary revision is damaged.")?;
        if dictionary["id"]!=id||dictionary["revision"]!=revision{return Err("The dictionary revision failed its identity check.".into());}
        ordered.push(json!(id));dictionaries.push(dictionary);
    }
    validate_set(&dictionaries)?;
    profile["dictionaryIds"]=json!(ordered);
    Ok(Some(dictionaries))
}

pub fn validate_set(dictionaries:&[Value])->Result<(),String>{
    if dictionaries.len()>3{return Err("Use up to three pronunciation dictionaries.".into());}
    let mut known=HashMap::new();
    for dictionary in dictionaries{
        validate_rules(dictionary)?;
        for rule in dictionary["rules"].as_array().ok_or("Supply dictionary rules.")?{
            let text=rule["text"].as_str().ok_or("Supply literal dictionary text.")?;
            let key=if rule["caseSensitive"]==true{text.into()}else{text.to_ascii_lowercase()};
            let value=(&rule["phonemes"],&rule["alphabet"]);
            if known.insert(key,value).is_some_and(|previous|previous!=value){return Err("A pronunciation rule conflicts with an earlier dictionary. Resolve the conflict before rendering.".into());}
        }
    }
    Ok(())
}

pub fn validate_rules(dictionary:&Value)->Result<(),String>{
    let rules=dictionary["rules"].as_array().filter(|rules|rules.len()<=5000).ok_or("Use up to 5,000 pronunciation rules per dictionary.")?;
    for rule in rules{
        let text=rule["text"].as_str().ok_or("Supply literal dictionary text.")?;
        let phonemes=rule["phonemes"].as_str().ok_or("Supply dictionary phonemes.")?;
        if text.trim().is_empty()||text.chars().count()>256||text.chars().any(|value|value.is_control()||"<>[]".contains(value)){return Err("Use nonempty literal dictionary text up to 256 characters, without control markup.".into());}
        if phonemes.chars().count()>1024||!valid_phonemes(phonemes,rule["alphabet"].as_str().ok_or("Choose a phoneme alphabet.")?){return Err("Use valid dictionary phonemes within 1,024 characters in the selected alphabet.".into());}
    }
    Ok(())
}

fn valid_phonemes(value:&str,alphabet:&str)->bool{
    if value.trim().is_empty(){return false;}
    value.split_whitespace().all(|token|match alphabet{
        "arpabet"=>{
            let base=token.trim_end_matches(['0','1','2']);let stressed=base.len()!=token.len();
            let vowel=matches!(base,"AA"|"AE"|"AH"|"AO"|"AW"|"AY"|"EH"|"ER"|"EY"|"IH"|"IY"|"OW"|"OY"|"UH"|"UW");
            (token.len()-base.len()<=1)&&(!stressed||vowel)&&(vowel||matches!(base,"B"|"CH"|"D"|"DH"|"F"|"G"|"HH"|"JH"|"K"|"L"|"M"|"N"|"NG"|"P"|"R"|"S"|"SH"|"T"|"TH"|"V"|"W"|"Y"|"Z"|"ZH"))
        },
        "pinyin"=>{
            let base=token.trim_end_matches(['1','2','3','4','5']);
            let latin=|value:char|value.is_ascii_alphabetic()||value.is_alphabetic()&&matches!(value,'\u{00c0}'..='\u{024f}'|'\u{1e00}'..='\u{1eff}')||matches!(value,'\u{0300}'..='\u{036f}');
            !base.is_empty()&&token.len()-base.len()<=1&&base.chars().all(latin)&&(base.len()==token.len()||base.chars().all(|value|value.is_ascii_lowercase()||matches!(value,'ü'|'v')))
        },
        "romaji"=>{
            let mut letter=false;let mut pitch=false;
            for value in token.chars().flat_map(char::to_lowercase){
                if matches!(value,'0'|'1'){if !letter||pitch{return false;}pitch=true;}
                else if value.is_ascii_lowercase()||"āīūēōâîûêô'-".contains(value){letter=true;pitch=false;}
                else{return false;}
            }
            letter
        },
        _=>false,
    })
}

#[cfg(test)]
#[path="dictionary_snapshot_tests.rs"]
mod tests;
