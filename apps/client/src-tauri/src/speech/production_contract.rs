use serde_json::{json, Value};
use std::collections::HashSet;

pub fn validate(input: &Value, preview: bool) -> Result<(), String> {
    let fields = input
        .as_object()
        .ok_or("Submit production settings as an object.")?;
    let common = [
        "projectId",
        "revisionId",
        "takeIds",
        "clipIds",
        "sampleRate",
        "channels",
        "loudnessLufs",
        "truePeakDb",
        "range",
        "includeBackground",
    ];
    let specific = if preview {
        &["reuseCache"][..]
    } else {
        &["format", "bitrate", "outputPath", "overwrite", "referencePermission"][..]
    };
    if fields
        .keys()
        .any(|key| !common.contains(&key.as_str()) && !specific.contains(&key.as_str()))
    {
        return Err("The production request contains unsupported settings.".into());
    }
    if ["loudnessLufs", "truePeakDb"]
        .iter()
        .any(|key| !fields.contains_key(*key))
    {
        return Err("Set both normalization fields, using null for unnormalized output.".into());
    }
    if input.get("referencePermission").is_some()&&input["format"]!="archive"{return Err("Reference redistribution permission applies only to portable project archives.".into());}
    for key in ["projectId", "revisionId"] {
        if key == "revisionId" && !preview && !fields.contains_key(key) {
            continue;
        }
        if input[key]
            .as_str()
            .is_none_or(|id| id.is_empty() || id.len() > 128)
        {
            return Err("Choose a saved project and revision before producing audio.".into());
        }
    }
    let ids = input["takeIds"]
        .as_array()
        .filter(|ids| ids.len() <= 10000)
        .ok_or("Submit at most 10,000 explicit production takes.")?;
    let mut unique = HashSet::new();
    for id in ids {
        let id = id
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 128)
            .ok_or("Choose valid production take IDs.")?;
        if !unique.insert(id) {
            return Err(
                "Choose distinct production takes or place repeated clips on the timeline.".into(),
            );
        }
    }
    if fields.contains_key("includeBackground") && !input["includeBackground"].is_boolean() {
        return Err("Choose whether to include background audio.".into());
    }
    if let Some(clips)=input.get("clipIds"){
        let clips=clips.as_array().filter(|clips|!clips.is_empty()&&clips.len()<=10000).ok_or("Choose 1 to 10,000 explicit timeline clips.")?;
        let mut unique=HashSet::new();
        for id in clips{let id=id.as_str().filter(|id|!id.is_empty()&&id.len()<=128).ok_or("Choose valid timeline clip IDs.")?;if !unique.insert(id){return Err("Choose distinct timeline clips.".into());}}
        if !ids.is_empty(){return Err("Choose explicit takes or timeline clips for this export.".into());}
    }
    let key = if preview { "reuseCache" } else { "overwrite" };
    if !input[key].is_boolean() {
        return Err(format!("Choose an explicit {key} setting."));
    }
    if !preview
        && input["outputPath"]
            .as_str()
            .is_none_or(|path| path.trim().is_empty())
    {
        return Err("Choose an export path.".into());
    }
    let preset = json!({"format":if preview{json!("wav")}else{input["format"].clone()},"bitrate":if preview{json!(0)}else{input["bitrate"].clone()},"sampleRate":input["sampleRate"],"channels":input["channels"],"loudnessLufs":input["loudnessLufs"],"truePeakDb":input["truePeakDb"]});
    super::super::store::validate_export_preset(&preset)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Value {
        json!({"projectId":"book","revisionId":"revision","takeIds":[],"sampleRate":48000,"channels":2,"loudnessLufs":null,"truePeakDb":null,"includeBackground":true,"reuseCache":true})
    }
    #[test]
    fn rejects_ambiguous_production_boundaries() {
        validate(&request(), true).unwrap();
        for (key, value) in [
            ("takeIds", json!(["a", "a"])),
            ("takeIds", json!([null])),
            ("reuseCache", Value::Null),
            ("includeBackground", json!("true")),
            ("sampleRate", json!(48000.5)),
            ("channels", json!(3)),
            ("loudnessLufs", json!(-16)),
            ("unknown", json!(1)),
        ] {
            let mut input = request();
            input[key] = value;
            assert!(validate(&input, true).is_err(), "{key}");
        }
        let mut input = request();
        input.as_object_mut().unwrap().remove("reuseCache");
        assert!(validate(&input, true).is_err());
    }
}
