use super::SpeechService;
use serde_json::Value;
use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Arc;
use zip::write::SimpleFileOptions;
use sha2::{Digest,Sha256};

struct ManifestSize(usize);

impl Write for ManifestSize{
    fn write(&mut self,bytes:&[u8])->std::io::Result<usize>{
        self.0=self.0.checked_add(bytes.len()).filter(|size|*size<=64*1024*1024).ok_or_else(||std::io::Error::new(std::io::ErrorKind::InvalidData,"Project metadata exceeds 64 MiB."))?;Ok(bytes.len())
    }
    fn flush(&mut self)->std::io::Result<()>{Ok(())}
}

pub fn write(service: &Arc<SpeechService>, project: &Value, input: &Value, path: &Path) -> Result<(), String> {
    let (manifest,mut reservation) = service.with_store(|store| {
        let manifest=store.portable_snapshot(project["id"].as_str().ok_or("Choose a speech project.")?,project["revisionId"].as_str().ok_or("Choose a saved speech revision.")?)?;
        let mut reservation=store.reserve_assets()?;
        reservation.retain(store,&manifest["assets"].as_object().ok_or("Project assets are invalid.")?.keys().cloned().collect::<Vec<_>>())?;
        Ok((manifest,reservation))
    })?;
    let mut metadata_size=ManifestSize(0);serde_json::to_writer(&mut metadata_size,&manifest).map_err(|_|"Project metadata exceeds the local 64 MiB archive guard.")?;
    super::super::store::archive_permissions::validate(&manifest,&input["referencePermission"])?;
    let assets=manifest["assets"].as_object().ok_or("Project assets are invalid.")?;
    let bytes=assets.values().try_fold(metadata_size.0 as u64,|total,asset|{
        let bytes=asset["bytes"].as_u64().filter(|bytes|*bytes>0&&*bytes<=8*1024*1024*1024).ok_or("A project asset exceeds the local archive size guard.")?;
        total.checked_add(bytes).filter(|total|*total<=64*1024*1024*1024).ok_or("Project assets exceed the local 64 GiB archive guard.")
    })?;
    let available=crate::storage_space::available_storage_bytes(path.parent().ok_or("Choose an export directory.")?).ok_or("Free project archive storage could not be measured.")?;
    if available<bytes.saturating_add(64*1024*1024){return Err("Free more export storage before archiving this project.".into());}
    let file = OpenOptions::new().create_new(true).write(true).open(path).map_err(|_| "Project archive could not be created.")?;
    let mut archive = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    archive.start_file("manifest.json", options).map_err(|_| "Project archive could not be written.")?;
    serde_json::to_writer(&mut archive,&manifest).map_err(|_|"Project archive metadata could not be written. Check free storage.")?;
    for (id,asset) in assets {
        let expected=asset["bytes"].as_u64().ok_or("A project asset has no byte length.")?;
        archive.start_file(format!("blobs/{id}"), options.large_file(expected>=u64::from(u32::MAX))).map_err(|_| "Project archive asset could not be written.")?;
        let mut source = service.with_store(|store| store.asset_reader(id).map(|(file,_)|file))?;
        let mut digest=Sha256::new();let mut copied=0u64;let mut buffer=[0u8;65_536];
        loop{
            reservation.ensure_live()?;
            let length=source.read(&mut buffer).map_err(|_|"A project asset could not be read.")?;if length==0{break;}
            copied=copied.checked_add(length as u64).filter(|copied|*copied<=expected).ok_or("A project asset changed while it was being archived.")?;
            archive.write_all(&buffer[..length]).map_err(|_|"Project archive storage is full.")?;digest.update(&buffer[..length]);
        }
        if copied!=expected||format!("{:x}",digest.finalize())!=*id{return Err("A project asset changed while it was being archived. Restore it before exporting again.".into());}
    }
    archive.finish().map_err(|_| "Project archive could not be finalized.")?.sync_all().map_err(|_| "Project archive could not be saved.")?;
    service.with_store(|store|reservation.release(store))
}

pub fn import(service: &Arc<SpeechService>, input: &Value) -> Result<Value, String> {
    let source = File::open(input["path"].as_str().ok_or("Choose a project archive.")?).map_err(|_| "Project archive could not be opened.")?;
    let mut archive = zip::ZipArchive::new(source).map_err(|_| "Choose a valid project archive.")?;
    if archive.len() > 10_001 { return Err("Project archive has too many entries.".into()); }
    let mut names = HashSet::new();
    let mut total = 0u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|_| "Project archive entry is damaged.")?;
        let name = entry.name();
        if entry.enclosed_name().is_none() || entry.is_dir() || !names.insert(name.to_string()) || !(name == "manifest.json" || (name.starts_with("blobs/") && name[6..].len() == 64 && name[6..].bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))) {
            return Err("The project archive contains an unsafe or unsupported path.".into());
        }
        let bound = if name == "manifest.json" { 64 * 1024 * 1024 } else { 8 * 1024 * 1024 * 1024 };
        total = total.checked_add(entry.size()).ok_or("Project archive size overflowed.")?;
        if entry.size() > bound || total > 64 * 1024 * 1024 * 1024 { return Err("Project archive exceeds the local import size guard.".into()); }
    }
    let mut metadata = Vec::new();
    archive.by_name("manifest.json").map_err(|_| "Project archive manifest is missing.")?.take(64 * 1024 * 1024 + 1).read_to_end(&mut metadata).map_err(|_| "Project archive manifest could not be read.")?;
    if metadata.len() > 64 * 1024 * 1024 { return Err("Project archive metadata exceeds its size guard.".into()); }
    let manifest: Value = serde_json::from_slice(&metadata).map_err(|_| "Project archive manifest is malformed.")?;
    if manifest["schema"] != "machdoch-speech-project" || manifest["version"] != 1 { return Err("This project archive schema is unsupported.".into()); }
    let assets = manifest["assets"].as_object().ok_or("Project archive asset metadata is missing.")?;
    if assets.len() + 1 != names.len() || assets.keys().any(|id| !names.contains(&format!("blobs/{id}"))) { return Err("Project archive assets differ from the declared inventory.".into()); }
    let mut reservation=service.with_store(|store| {
        store.validate_portable_snapshot(&manifest)?;
        let mut reservation=store.reserve_assets()?;
        reservation.protect(store,&assets.keys().cloned().collect::<Vec<_>>())?;
        Ok(reservation)
    })?;
    let result=(|| {
        for (id, metadata) in assets {
            let mut entry=archive.by_name(&format!("blobs/{id}")).map_err(|_|"A project archive asset is missing.")?;
            let bytes=metadata["bytes"].as_u64().filter(|bytes|*bytes==entry.size()).ok_or("An archived asset has an inconsistent byte length.")?;
            if metadata["mimeType"]!="audio/wav" { return Err("Import WAV audio assets in a portable speech project.".into()); }
            let duration=metadata["duration"].as_f64().ok_or("An archived audio duration is missing.")?;
            let rate=metadata["sampleRate"].as_u64().and_then(|value|u32::try_from(value).ok()).ok_or("An archived sample rate is invalid.")?;
            let channels=metadata["channels"].as_u64().and_then(|value|u16::try_from(value).ok()).ok_or("An archived channel count is invalid.")?;
            let stage=super::super::store::StagedAsset::from_reader(&reservation,&mut entry,bytes,"audio/wav",duration,rate,channels,None)?;
            if stage.id()!=id { return Err("A project archive asset failed its integrity check.".into()); }
            let published=stage.publish(&reservation,None)?;
            service.with_store(|store|store.commit_staged_asset(&reservation,&published))?;
        }
        service.with_store(|store|store.commit_portable_snapshot(&manifest))
    })();
    let released=service.with_store(|store|reservation.release(store));
    match (result,released) {
        (Ok(value),Ok(())) => Ok(value),
        (Err(error),Ok(())) | (Ok(_),Err(error)) => Err(error),
        (Err(error),Err(cleanup)) => Err(format!("{error} {cleanup}")),
    }
}
