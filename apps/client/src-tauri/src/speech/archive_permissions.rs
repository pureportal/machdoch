use super::*;
use std::collections::BTreeSet;
use std::io::{self, Write};
use sha2::{Digest, Sha256};

#[derive(serde::Serialize)]
struct PermissionProjection<'a> {
    #[serde(rename = "projectId")]
    project_id: &'a str,
    references: &'a [Value],
}

struct PermissionDigest(Sha256);

impl Write for PermissionDigest {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub fn inventory(manifest:&Value)->Result<Value,String>{
    let project=&manifest["project"];
    let project_id=identifier(project,"id")?;let revision_id=identifier(project,"revisionId")?;
    let references=manifest["references"].as_object().ok_or("The archive reference inventory is missing.")?;
    let mut ids:BTreeSet<String>=references.keys().cloned().collect();let mut originals=HashSet::new();
    for pair in manifest["originals"].as_array().ok_or("The archive recording origins are missing.")?{
        ids.insert(asset_identifier(&pair["assetId"])?.to_owned());
        let original=asset_identifier(&pair["originalAssetId"])?;ids.insert(original.to_owned());originals.insert(original.to_owned());
    }
    let mut recordings=Vec::new();
    for id in ids{
        asset_identifier(&json!(id))?;
        let bytes=manifest["assets"][&id]["bytes"].as_u64().filter(|bytes|*bytes>0).ok_or("An archived reference asset is missing.")?;
        let reference=&manifest["references"][&id];
        recordings.push(json!({"assetId":id,"bytes":bytes,"transcriptPreview":reference["transcript"].as_str().map(|text|text.chars().take(120).collect::<String>()),"rightsEvidence":reference["rightsEvidence"],"original":originals.contains(&id)}));
    }
    let mut writer = PermissionDigest(Sha256::new());
    serde_json::to_writer(&mut writer, &PermissionProjection { project_id, references: &recordings }).map_err(error)?;
    let hash = format!("{:x}", writer.0.finalize());
    Ok(json!({"projectId":project_id,"revisionId":revision_id,"inventorySha256":hash,"references":recordings}))
}

pub fn validate(manifest:&Value,permission:&Value)->Result<(),String>{
    let inventory=inventory(manifest)?;let references=inventory["references"].as_array().ok_or("The archive reference inventory is invalid.")?;
    if references.is_empty(){if !permission.is_null(){return Err("This archive contains no reference recordings to authorize.".into());}return Ok(());}
    if permission.is_null(){return Err("Review the archive's reference files and record permission to redistribute them before exporting.".into());}
    fields(permission,&["inventorySha256","assetIds","rightsEvidence"])?;
    if permission["inventorySha256"]!=inventory["inventorySha256"]{return Err("The archive reference files changed. Review their redistribution permission again.".into());}
    if text(permission,"rightsEvidence",1,4096)?.trim().is_empty(){return Err("Record permission to redistribute the reference recordings in this archive.".into());}
    let ids=array(permission,"assetIds",MAX_ITEMS)?;let mut allowed=HashSet::new();
    for id in ids{if !allowed.insert(asset_identifier(id)?){return Err("Remove duplicate archive reference permissions.".into());}}
    if allowed.len()!=references.len()||references.iter().any(|reference|reference["assetId"].as_str().is_none_or(|id|!allowed.contains(id))){return Err("Authorize every reference file in the reviewed archive inventory.".into());}
    Ok(())
}

#[cfg(test)]
#[path="archive_permission_tests.rs"]
mod tests;
