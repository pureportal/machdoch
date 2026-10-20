use hound::{SampleFormat,WavSpec};
use std::collections::{BTreeMap,VecDeque};
use std::fs::File;
use std::io::{BufReader,Read,Seek,SeekFrom};
use std::path::Path;

const MAX_CHUNKS:usize=10_000;

#[derive(Debug,PartialEq)]
pub enum WaveSample{Integer(i32),Float(f32)}

pub struct WaveReader<R>{input:R,spec:WavSpec,data_offset:u64,frames:u64,remaining:u64}

fn exact<const N:usize>(input:&mut impl Read)->Result<[u8;N],String>{
    let mut bytes=[0;N];input.read_exact(&mut bytes).map_err(|_|"The WAV is truncated or unreadable.")?;Ok(bytes)
}

fn word(bytes:&[u8],offset:usize)->u16{u16::from_le_bytes([bytes[offset],bytes[offset+1]])}
fn dword(bytes:&[u8],offset:usize)->u32{u32::from_le_bytes([bytes[offset],bytes[offset+1],bytes[offset+2],bytes[offset+3]])}
fn qword(bytes:&[u8],offset:usize)->u64{u64::from_le_bytes([bytes[offset],bytes[offset+1],bytes[offset+2],bytes[offset+3],bytes[offset+4],bytes[offset+5],bytes[offset+6],bytes[offset+7]])}

fn format(input:&mut impl Read,length:u64)->Result<WavSpec,String>{
    if length<16{return Err("The WAV format chunk is truncated.".into());}
    let mut bytes=[0;40];input.read_exact(&mut bytes[..length.min(40) as usize]).map_err(|_|"The WAV format is truncated.")?;
    let channels=word(&bytes,2);let sample_rate=dword(&bytes,4);let bits=word(&bytes,14);
    let encoding=if word(&bytes,0)==0xfffe{
        if length<40||word(&bytes,16)<22||u64::from(word(&bytes,16))+18>length||word(&bytes,18)!=bits{return Err("Use a WAV with supported complete PCM or float sample containers.".into());}
        let pcm=[1,0,0,0,0,0,16,0,128,0,0,170,0,56,155,113];
        let float=[3,0,0,0,0,0,16,0,128,0,0,170,0,56,155,113];
        if bytes[24..40]==pcm{1}else if bytes[24..40]==float{3}else{return Err("This WAV uses an unsupported sample encoding.".into());}
    }else{word(&bytes,0)};
    let sample_format=match (encoding,bits){(1,8|16|24|32)=>SampleFormat::Int,(3,32)=>SampleFormat::Float,_=>return Err("Use 8, 16, 24 or 32-bit PCM WAV, or 32-bit float WAV.".into())};
    if !(1..=8).contains(&channels)||!(8000..=192000).contains(&sample_rate){return Err("Use a supported WAV sample rate and one to eight channels.".into());}
    let alignment=channels.checked_mul(bits/8).ok_or("The WAV frame size overflowed.")?;
    if word(&bytes,12)!=alignment||dword(&bytes,8)!=sample_rate.checked_mul(u32::from(alignment)).ok_or("The WAV byte rate overflowed.")?{return Err("The WAV frame alignment or byte rate is inconsistent.".into());}
    Ok(WavSpec{channels,sample_rate,bits_per_sample:bits,sample_format})
}

impl WaveReader<BufReader<File>>{
    pub fn open(path:&Path)->Result<Self,String>{Self::new(BufReader::with_capacity(65_536,File::open(path).map_err(|_|"The WAV could not be opened.")?))}
}

impl<R:Read+Seek> WaveReader<R>{
    pub fn new(mut input:R)->Result<Self,String>{
        let physical=input.seek(SeekFrom::End(0)).map_err(|_|"The WAV size could not be measured.")?;
        input.seek(SeekFrom::Start(0)).map_err(|_|"The WAV could not be read.")?;
        let header=exact::<12>(&mut input)?;let rf64=&header[..4]==b"RF64";
        if (!rf64&&&header[..4]!=b"RIFF")||&header[8..]!=b"WAVE"{return Err("Choose a finalized RIFF/WAVE or RF64 audio file.".into());}
        let riff_size=dword(&header,4);let mut end=if rf64&&riff_size==u32::MAX{physical}else{u64::from(riff_size)+8};
        if end!=physical||end<12{return Err("The WAV container size differs from the complete file.".into());}
        let mut cursor=12u64;let mut spec=None;let mut audio=None;let mut extended:Option<(u64,u64,u64)>=None;let mut fact=None;
        let mut sizes:BTreeMap<[u8;4],VecDeque<u64>>=BTreeMap::new();
        let mut chunks=0;
        while cursor<end{
            chunks+=1;if chunks>MAX_CHUNKS{return Err("The WAV contains too many metadata chunks.".into());}
            if end-cursor<8{return Err("The WAV has a truncated chunk header.".into());}
            input.seek(SeekFrom::Start(cursor)).map_err(|_|"The WAV chunk could not be read.")?;
            let chunk=exact::<8>(&mut input)?;let tag=[chunk[0],chunk[1],chunk[2],chunk[3]];let declared=dword(&chunk,4);let offset=cursor+8;
            if rf64&&cursor==12&&tag!=*b"ds64"{return Err("RF64 requires its size table before other chunks.".into());}
            let length=if declared==u32::MAX&&rf64{
                if tag==*b"data"{extended.map(|(_,bytes,_)|bytes).ok_or("The RF64 data size is missing.")?}
                else{sizes.get_mut(&tag).and_then(VecDeque::pop_front).ok_or("An RF64 chunk has no declared 64-bit size.")?}
            }else{u64::from(declared)};
            let next=offset.checked_add(length).and_then(|value|value.checked_add(length%2)).filter(|value|*value<=end).ok_or("The WAV chunk size overflows or exceeds the file.")?;
            match &tag{
                b"ds64"=>{
                    if !rf64||cursor!=12||extended.is_some()||length<28{return Err("The RF64 size table is missing, duplicated or malformed.".into());}
                    let table=exact::<28>(&mut input)?;let riff=qword(&table,0);let data=qword(&table,8);let frames=qword(&table,16);let entries=dword(&table,24) as usize;
                    if entries>MAX_CHUNKS||28+entries as u64*12>length{return Err("The RF64 chunk-size table is truncated or too large.".into());}
                    if riff_size==u32::MAX{end=riff.checked_add(8).ok_or("The RF64 container size overflowed.")?;}
                    if end!=physical||next>end{return Err("The RF64 size differs from the complete file.".into());}
                    for _ in 0..entries{let entry=exact::<12>(&mut input)?;sizes.entry([entry[0],entry[1],entry[2],entry[3]]).or_default().push_back(qword(&entry,4));}
                    extended=Some((riff,data,frames));
                },
                b"fmt "=>{if spec.is_some(){return Err("The WAV has duplicate format chunks.".into());}spec=Some(format(&mut input,length)?);},
                b"data"=>{
                    if spec.is_none()||audio.is_some(){return Err("Use one WAV data chunk after its sample format.".into());}
                    audio=Some((offset,length,rf64&&declared==u32::MAX));
                },
                b"fact"=>{if fact.is_some()||length<4{return Err("The WAV sample-count metadata is invalid.".into());}fact=Some(u32::from_le_bytes(exact::<4>(&mut input)?));},
                _=>{},
            }
            cursor=next;
        }
        if rf64&&extended.is_none(){return Err("The RF64 size table is missing.".into());}
        if sizes.values().any(|sizes|!sizes.is_empty()){return Err("The RF64 size table contains unmatched chunks.".into());}
        let spec=spec.ok_or("The WAV sample format is missing.")?;let (data_offset,bytes,extended_data)=audio.ok_or("The WAV audio data is missing.")?;
        let alignment=u64::from(spec.channels)*u64::from(spec.bits_per_sample/8);
        if bytes==0||bytes%alignment!=0{return Err("The WAV has no complete nonempty audio frames.".into());}
        let frames=bytes/alignment;
        if extended_data&&extended.is_some_and(|(_,data,_)|data!=bytes){return Err("The RF64 data length is inconsistent.".into());}
        let declared_frames=match fact{Some(value)if value!=u32::MAX=>Some(u64::from(value)),Some(_)=>Some(extended.ok_or("The WAV sample-count sentinel requires RF64 metadata.")?.2),None=>extended.map(|(_,_,frames)|frames).filter(|frames|*frames!=0)};
        if declared_frames.is_some_and(|declared|declared!=frames){return Err("The WAV frame count differs from its sample-count metadata.".into());}
        let remaining=frames.checked_mul(u64::from(spec.channels)).ok_or("The WAV sample count overflowed.")?;
        input.seek(SeekFrom::Start(data_offset)).map_err(|_|"The WAV samples could not be opened.")?;
        Ok(Self{input,spec,data_offset,frames,remaining})
    }

    pub fn spec(&self)->WavSpec{self.spec}
    pub fn frames(&self)->u64{self.frames}
    pub fn data_offset(&self)->u64{self.data_offset}
    pub fn sample_count(&self)->u64{self.frames*u64::from(self.spec.channels)}
    pub fn seek_frame(&mut self,frame:u64)->Result<(),String>{
        if frame>self.frames{return Err("Seek within the complete WAV frames.".into());}
        let offset=frame.checked_mul(u64::from(self.spec.channels)*u64::from(self.spec.bits_per_sample/8)).and_then(|offset|self.data_offset.checked_add(offset)).ok_or("The WAV seek offset overflowed.")?;
        self.input.seek(SeekFrom::Start(offset)).map_err(|_|"The WAV frame could not be read.")?;
        self.remaining=(self.frames-frame)*u64::from(self.spec.channels);Ok(())
    }
}

impl<R:Read+Seek> Iterator for WaveReader<R>{
    type Item=Result<WaveSample,String>;
    fn next(&mut self)->Option<Self::Item>{
        if self.remaining==0{return None;}self.remaining-=1;
        let mut bytes=[0;4];let size=usize::from(self.spec.bits_per_sample/8);
        if self.input.read_exact(&mut bytes[..size]).is_err(){self.remaining=0;return Some(Err("The WAV ends before its declared sample frames.".into()));}
        let sample=match (self.spec.sample_format,self.spec.bits_per_sample){
            (SampleFormat::Int,8)=>WaveSample::Integer(i32::from(bytes[0])-128),
            (SampleFormat::Int,16)=>WaveSample::Integer(i32::from(i16::from_le_bytes([bytes[0],bytes[1]]))),
            (SampleFormat::Int,24)=>WaveSample::Integer(i32::from_le_bytes([bytes[0],bytes[1],bytes[2],if bytes[2]&128!=0{255}else{0}])),
            (SampleFormat::Int,32)=>WaveSample::Integer(i32::from_le_bytes(bytes)),
            (SampleFormat::Float,32)=>{let value=f32::from_le_bytes(bytes);if !value.is_finite(){self.remaining=0;return Some(Err("The WAV contains invalid floating-point samples.".into()));}WaveSample::Float(value)},
            _=>{self.remaining=0;return Some(Err("The WAV sample encoding is unsupported.".into()));},
        };
        Some(Ok(sample))
    }
}

#[cfg(test)]
#[path="wave_file_tests.rs"]
mod tests;
