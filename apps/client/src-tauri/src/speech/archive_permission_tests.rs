use super::*;

fn manifest()->Value{
    let original="a".repeat(64);let trimmed="b".repeat(64);
    json!({"project":{"id":"project","revisionId":"revision"},"references":{(trimmed.clone()):{"transcript":"A recorded reference sentence.","rightsEvidence":"Permission to clone only"}},"originals":[{"assetId":trimmed,"originalAssetId":original}],"assets":{(original):{"bytes":1024},(trimmed):{"bytes":512}}})
}

fn permission(inventory:&Value)->Value{json!({"inventorySha256":inventory["inventorySha256"],"assetIds":inventory["references"].as_array().unwrap().iter().map(|reference|reference["assetId"].clone()).collect::<Vec<_>>(),"rightsEvidence":"The recording owner permits both files in this archive."})}

#[test]
fn archive_reference_inventory_includes_originals_without_inventing_rights_and_is_stable_across_script_revisions(){
    let mut data=manifest();let observed=inventory(&data).unwrap();let references=observed["references"].as_array().unwrap();assert_eq!(references.len(),2);
    assert_eq!(references[0]["original"],true);assert_eq!(references[0]["rightsEvidence"],Value::Null);assert_eq!(references[1]["rightsEvidence"],"Permission to clone only");
    data["project"]["revisionId"]=json!("later-script-revision");assert_eq!(inventory(&data).unwrap()["inventorySha256"],observed["inventorySha256"]);
    data["references"]["b".repeat(64)]["rightsEvidence"]=json!("Changed permission record");assert_ne!(inventory(&data).unwrap()["inventorySha256"],observed["inventorySha256"]);
}

#[test]
fn archive_requires_a_separate_exact_complete_reference_permission_record(){
    let data=manifest();let observed=inventory(&data).unwrap();let approved=permission(&observed);assert!(validate(&data,&Value::Null).unwrap_err().contains("redistribute"));validate(&data,&approved).unwrap();
    for invalid in [json!({"inventorySha256":observed["inventorySha256"],"assetIds":["b".repeat(64)],"rightsEvidence":"Approved"}),json!({"inventorySha256":"c".repeat(64),"assetIds":approved["assetIds"],"rightsEvidence":"Approved"}),json!({"inventorySha256":observed["inventorySha256"],"assetIds":approved["assetIds"],"rightsEvidence":" "}),json!({"inventorySha256":observed["inventorySha256"],"assetIds":["a".repeat(64),"a".repeat(64)],"rightsEvidence":"Approved"})]{assert!(validate(&data,&invalid).is_err());}
    let mut extra=approved.clone();extra["cloningPermission"]=json!(true);assert!(validate(&data,&extra).is_err());
    let mut another=data.clone();another["project"]["id"]=json!("different-project");assert!(validate(&another,&approved).unwrap_err().contains("changed"));
}

#[test]
fn archives_without_reference_recordings_need_no_redistribution_declaration(){
    let data=json!({"project":{"id":"project","revisionId":"revision"},"references":{},"originals":[],"assets":{}});validate(&data,&Value::Null).unwrap();assert_eq!(inventory(&data).unwrap()["references"],json!([]));assert!(validate(&data,&json!({"rightsEvidence":"Unrelated"})).is_err());
}
