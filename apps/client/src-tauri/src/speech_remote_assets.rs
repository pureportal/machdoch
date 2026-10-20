use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::fs::File;
use std::io::{Read,Seek,SeekFrom};

const BLOCK:usize=65_536;

pub struct VerifiedAsset { pub metadata:Value, hashes:Vec<[u8;32]> }

impl VerifiedAsset {
    pub fn open(metadata:Value)->Result<Self,String>{
        let size=metadata["bytes"].as_u64().filter(|size|*size>0&&*size<=8*1024*1024*1024).ok_or("The remote speech asset size is invalid.")?;
        let expected=metadata["sha256"].as_str().filter(|digest|digest.len()==64&&digest.bytes().all(|byte|byte.is_ascii_hexdigit())).ok_or("The remote speech asset digest is invalid.")?;
        let mut file=File::open(metadata["path"].as_str().ok_or("The remote speech asset path is missing.")?).map_err(|_|"The remote speech asset is unavailable.")?;
        if !file.metadata().map_err(|_|"The remote speech asset metadata is unavailable.")?.is_file(){return Err("The remote speech asset is not a regular file.".into());}
        let mut digest=Sha256::new();
        let mut hashes=Vec::new();
        let mut total=0u64;
        let mut buffer=[0u8;BLOCK];
        while total<size {
            let count=BLOCK.min((size-total) as usize);
            file.read_exact(&mut buffer[..count]).map_err(|_|"The remote speech asset is truncated.")?;
            digest.update(&buffer[..count]);
            hashes.push(Sha256::digest(&buffer[..count]).into());
            total+=count as u64;
        }
        if file.read(&mut buffer[..1]).map_err(|_|"The remote speech asset could not be verified.")?!=0||format!("{:x}",digest.finalize())!=expected{return Err("The remote speech asset failed its SHA-256 check. Regenerate or export it again.".into());}
        Ok(Self{metadata,hashes})
    }

    pub fn fingerprint_bytes(&self)->usize{self.hashes.len()*32}

    pub fn read(&self,offset:u64,maximum:usize)->Result<Value,String>{
        use base64::{engine::general_purpose::STANDARD,Engine};
        let size=self.metadata["bytes"].as_u64().ok_or("The remote speech asset size is missing.")?;
        if offset>size||!(1..=BLOCK).contains(&maximum){return Err("Use a valid remote speech offset and a read of at most 65,536 bytes.".into());}
        let mut file=File::open(self.metadata["path"].as_str().ok_or("The remote speech asset path is missing.")?).map_err(|_|"The remote speech asset is unavailable.")?;
        if file.metadata().map_err(|_|"The remote speech metadata is unavailable.")?.len()!=size{return Err("The remote speech asset changed after verification.".into());}
        let end=size.min(offset+maximum as u64);
        let mut output=Vec::with_capacity((end-offset) as usize);
        let mut block=offset/BLOCK as u64;
        while block* (BLOCK as u64)<end {
            let start=block*BLOCK as u64;
            let count=BLOCK.min((size-start) as usize);
            let mut buffer=vec![0;count];
            file.seek(SeekFrom::Start(start)).and_then(|_|file.read_exact(&mut buffer)).map_err(|_|"The remote speech asset is truncated.")?;
            let actual:[u8;32]=Sha256::digest(&buffer).into();
            if self.hashes.get(block as usize)!=Some(&actual){return Err("The remote speech asset changed after verification. Reopen the take or export before retrying.".into());}
            let from=offset.saturating_sub(start) as usize;
            let to=((end-start) as usize).min(count);
            output.extend_from_slice(&buffer[from..to]);
            block+=1;
        }
        Ok(json!({"audioBase64":STANDARD.encode(output),"nextOffset":end,"complete":end==size,"mimeType":self.metadata["mimeType"],"totalBytes":size}))
    }
}

#[cfg(test)]
mod tests{
    use super::*;

    #[test]
    fn bounded_asset_reads_detect_same_length_changes_and_verify_unaligned_cross_block_reads(){
        let path=std::env::temp_dir().join(format!("speech-remote-integrity-{}.pcm",std::process::id()));
        let mut bytes=vec![4u8;BLOCK*2+17];
        std::fs::write(&path,&bytes).unwrap();
        let asset=VerifiedAsset::open(json!({"path":path,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes)),"mimeType":"audio/wav"})).unwrap();
        assert_eq!(asset.fingerprint_bytes(),96);
        let result=asset.read((BLOCK-2)as u64,9).unwrap();
        assert_eq!(result["nextOffset"],BLOCK+7);
        assert!(!result["complete"].as_bool().unwrap());
        assert_eq!(asset.read(bytes.len()as u64,10).unwrap()["audioBase64"],"");
        bytes[BLOCK]=8;
        std::fs::write(&path,&bytes).unwrap();
        assert!(asset.read((BLOCK-2)as u64,9).unwrap_err().contains("changed after verification"));
        assert!(VerifiedAsset::open(asset.metadata.clone()).is_err());
        std::fs::remove_file(path).unwrap();
    }
}
