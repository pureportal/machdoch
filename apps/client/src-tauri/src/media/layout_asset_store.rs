use std::fs;
use rusqlite::{params, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};
use super::{database, transform, MediaResult, MediaRuntimePaths};

pub(crate) fn source_assets(layout: &Value, variant: usize) -> Vec<(String, String)> {
    let mut sources = Vec::new();
    let evidence = &layout["variants"][variant];
    for input in evidence["inputs"].as_array().into_iter().flatten() {
        if let Some(id) = input.pointer("/source/assetId").and_then(Value::as_str) {
            sources.push((id.into(), format!("layout:{}", input["id"].as_str().unwrap_or("layer"))));
        }
        if let Some(id) = input.pointer("/preparedAsset/assetId").and_then(Value::as_str) {
            sources.push((id.into(), format!("layout-prepared:{}", input["id"].as_str().unwrap_or("layer"))));
        }
    }
    for step in evidence["refinement"]["steps"].as_array().into_iter().flatten() {
        for (field, role) in [("baseAssetId", "layout-reference"), ("maskAssetId", "layout-mask"), ("outputAssetId", "layout-refinement-output")] {
            if let Some(id) = step[field].as_str() { sources.push((id.into(), role.into())); }
        }
    }
    sources.sort();
    sources.dedup();
    sources
}

pub(crate) fn read(paths: &MediaRuntimePaths, key: &str) -> MediaResult<Option<(Vec<u8>, Value)>> {
    let row = database::open(paths)?.query_row(
        "SELECT b.relative_path, b.digest, a.operation_json FROM assets a JOIN blobs b ON b.digest=a.blob_digest WHERE a.id=?1 AND a.deleted_at IS NULL AND b.available=1",
        [format!("asset:layout:{key}")], |row| Ok((row.get::<_,String>(0)?, row.get::<_,String>(1)?, row.get::<_,String>(2)?)),
    ).optional().map_err(|error| error.to_string())?;
    let Some((relative, digest, operation)) = row else { return Ok(None); };
    let bytes = fs::read(paths.blobs.join(relative)).map_err(|error| format!("Restore the cached layout asset: {error}"))?;
    if format!("{:x}", Sha256::digest(&bytes)) != digest { return Err("Cached layout asset failed verification. Remove it before regenerating.".into()); }
    let operation = serde_json::from_str(&operation).map_err(|error| error.to_string())?;
    Ok(Some((bytes, operation)))
}

pub(crate) fn publish(paths: &MediaRuntimePaths, run_id: &str, key: &str, bytes: &[u8], provenance: Value) -> MediaResult<Value> {
    let image = transform::decode_image_bytes(bytes)?;
    let digest = format!("{:x}", Sha256::digest(bytes));
    let relative = transform::cas_relative_path(&digest);
    transform::publish_cas_bytes(paths, &relative, &digest, bytes)?;
    let asset_id = format!("asset:layout:{key}");
    let operation = serde_json::json!({"kind":"layout-layer","assetId":asset_id,"digest":digest,"generation":provenance});
    let mut connection = database::open(paths)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    transaction.execute("INSERT OR IGNORE INTO blobs(digest,byte_size,mime_type,relative_path,created_at) VALUES (?1,?2,'image/png',?3,?4)",
        params![digest, bytes.len() as i64, relative.to_string_lossy(), database::now()]).map_err(|error| error.to_string())?;
    transaction.execute("INSERT INTO assets(id,run_id,blob_digest,kind,mime_type,byte_size,width,height,created_at,output_index,fixture,operation_json) VALUES (?1,?2,?3,'image','image/png',?4,?5,?6,?7,(SELECT MAX(10000,COALESCE(MAX(output_index),0)+1) FROM assets WHERE run_id=?2),0,?8)",
        params![asset_id,run_id,digest,bytes.len() as i64,image.width(),image.height(),database::now(),operation.to_string()]).map_err(|error| format!("Could not retain layout asset: {error}"))?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(operation)
}
