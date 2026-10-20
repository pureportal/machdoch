use serde_json::Value;
use std::fs::{File,OpenOptions};
use std::io::{Read,Write};
use std::path::Path;

const MAX_CACHE_BYTES:u64=4_194_304;

pub fn read(path:&Path)->Result<Value,String>{
    let file=File::open(path).map_err(|_|"Audio analysis cache could not be read. Rebuild the audio analysis.")?;
    let metadata=file.metadata().map_err(|_|"Audio analysis cache could not be measured.")?;
    if !metadata.is_file()||metadata.len()>MAX_CACHE_BYTES{return Err("Audio analysis cache exceeds its local size limit. Rebuild the audio analysis.".into());}
    serde_json::from_reader(file.take(MAX_CACHE_BYTES+1)).map_err(|_|"Audio analysis cache is damaged. Rebuild the audio analysis.".into())
}

pub fn write(path:&Path,value:&Value)->Result<(),String>{
    let bytes=serde_json::to_vec(value).map_err(|_|"Audio analysis could not be encoded.")?;
    if bytes.len()as u64>MAX_CACHE_BYTES{return Err("Audio analysis exceeds its local cache size limit.".into());}
    let temporary=path.with_extension(format!("{}.part",super::identifier()?));
    let result=(||{
        let mut file=OpenOptions::new().create_new(true).write(true).open(&temporary).map_err(|_|"Audio analysis cache could not be created.")?;
        file.write_all(&bytes).and_then(|_|file.sync_all()).map_err(|_|"Audio analysis cache could not be written. Check free storage.")?;
        drop(file);
        std::fs::rename(&temporary,path).map_err(|_|"Audio analysis cache could not be committed.")
    })();
    if result.is_err()&&temporary.exists(){std::fs::remove_file(&temporary).map_err(|_|"Audio analysis failed and its working file could not be removed. Check free storage and rebuild the analysis.")?;}
    result.map_err(str::to_owned)
}

#[cfg(test)]
mod tests{
    use super::*;
    struct Directory(std::path::PathBuf);
    impl Directory{fn new()->Self{let path=std::env::temp_dir().join(format!("speech-analysis-cache-{}",crate::speech::identifier().unwrap()));std::fs::create_dir_all(&path).unwrap();Self(path)}}
    impl Drop for Directory{fn drop(&mut self){std::fs::remove_dir_all(&self.0).unwrap();}}
    #[test]
    fn cache_rebuild_replaces_atomically_and_rejects_corrupt_or_oversized_files(){
        let directory=Directory::new();let path=directory.0.join("cache.json");
        write(&path,&serde_json::json!({"frames":1})).unwrap();write(&path,&serde_json::json!({"frames":2})).unwrap();assert_eq!(read(&path).unwrap()["frames"],2);
        std::fs::write(&path,b"corrupt").unwrap();assert!(read(&path).unwrap_err().contains("Rebuild"));
        File::create(&path).unwrap().set_len(MAX_CACHE_BYTES+1).unwrap();assert!(read(&path).unwrap_err().contains("size limit"));
        assert_eq!(directory.0.read_dir().unwrap().count(),1);
    }
    #[test]
    fn failed_cache_commit_removes_the_working_file(){
        let directory=Directory::new();let path=directory.0.join("directory.json");std::fs::create_dir(&path).unwrap();
        assert!(write(&path,&serde_json::json!({"frames":1})).is_err());assert!(path.is_dir());assert_eq!(directory.0.read_dir().unwrap().count(),1);
    }
}
