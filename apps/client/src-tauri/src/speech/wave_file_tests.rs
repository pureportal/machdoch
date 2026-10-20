use super::*;
use std::cell::Cell;
use std::io::{Cursor,Error,ErrorKind};
use std::rc::Rc;

fn chunk(file:&mut Vec<u8>,tag:&[u8;4],body:&[u8]){file.extend_from_slice(tag);file.extend_from_slice(&(body.len() as u32).to_le_bytes());file.extend_from_slice(body);if body.len()%2!=0{file.push(0);}}

fn wav(data:&[u8],rf64:bool,channels:u16,bits:u16,float:bool,extensible:bool)->Vec<u8>{
    let mut file=Vec::from(if rf64{b"RF64\xff\xff\xff\xffWAVE"}else{b"RIFF\0\0\0\0WAVE"});
    if rf64{chunk(&mut file,b"ds64",&[0;28]);}
    chunk(&mut file,b"JUNK",&[7]);
    let mut format=vec![0;if extensible{40}else{16}];let encoding:u16=if extensible{0xfffe}else if float{3}else{1};
    format[..2].copy_from_slice(&encoding.to_le_bytes());format[2..4].copy_from_slice(&channels.to_le_bytes());format[4..8].copy_from_slice(&24000u32.to_le_bytes());format[8..12].copy_from_slice(&(24000*u32::from(channels)*u32::from(bits/8)).to_le_bytes());format[12..14].copy_from_slice(&(channels*(bits/8)).to_le_bytes());format[14..16].copy_from_slice(&bits.to_le_bytes());
    if extensible{format[16..18].copy_from_slice(&22u16.to_le_bytes());format[18..20].copy_from_slice(&bits.to_le_bytes());format[24..40].copy_from_slice(&[if float{3}else{1},0,0,0,0,0,16,0,128,0,0,170,0,56,155,113]);}
    chunk(&mut file,b"fmt ",&format);let data_chunk=file.len();chunk(&mut file,b"data",data);
    let length=file.len() as u64-8;
    if rf64{file[20..28].copy_from_slice(&length.to_le_bytes());file[28..36].copy_from_slice(&(data.len() as u64).to_le_bytes());file[36..44].copy_from_slice(&(data.len() as u64/(u64::from(channels)*u64::from(bits/8))).to_le_bytes());file[data_chunk+4..data_chunk+8].copy_from_slice(&u32::MAX.to_le_bytes());}else{file[4..8].copy_from_slice(&(length as u32).to_le_bytes());}
    file
}

#[test]
fn riff_and_rf64_decode_the_same_pcm_float_and_extensible_frames_with_odd_metadata_padding(){
    let cases=[
        (8,false,false,vec![0,128,255],vec![WaveSample::Integer(-128),WaveSample::Integer(0),WaveSample::Integer(127)]),
        (16,false,false,vec![0,128,255,127],vec![WaveSample::Integer(-32768),WaveSample::Integer(32767)]),
        (24,false,true,vec![0,0,128,255,255,127],vec![WaveSample::Integer(-8388608),WaveSample::Integer(8388607)]),
        (32,false,true,[i32::MIN.to_le_bytes(),i32::MAX.to_le_bytes()].concat(),vec![WaveSample::Integer(i32::MIN),WaveSample::Integer(i32::MAX)]),
        (32,true,false,[(-0.5f32).to_le_bytes(),0.25f32.to_le_bytes()].concat(),vec![WaveSample::Float(-0.5),WaveSample::Float(0.25)]),
        (32,true,true,[0.0f32.to_le_bytes(),1.0f32.to_le_bytes()].concat(),vec![WaveSample::Float(0.0),WaveSample::Float(1.0)]),
    ];
    for (bits,float,extensible,data,expected) in cases{for rf64 in [false,true]{let reader=WaveReader::new(Cursor::new(wav(&data,rf64,1,bits,float,extensible))).unwrap();assert_eq!(reader.frames(),expected.len() as u64);assert_eq!(reader.collect::<Result<Vec<_>,_>>().unwrap(),expected);}}
}

#[test]
fn stereo_seeks_address_complete_frames_and_allow_the_exact_end(){
    let data=[1i16,2,3,4,5,6].into_iter().flat_map(i16::to_le_bytes).collect::<Vec<_>>();
    for rf64 in [false,true]{let mut reader=WaveReader::new(Cursor::new(wav(&data,rf64,2,16,false,false))).unwrap();assert_eq!(reader.frames(),3);assert_eq!(reader.sample_count(),6);reader.seek_frame(2).unwrap();assert_eq!(reader.next().unwrap().unwrap(),WaveSample::Integer(5));assert_eq!(reader.next().unwrap().unwrap(),WaveSample::Integer(6));assert!(reader.next().is_none());reader.seek_frame(0).unwrap();assert_eq!(reader.next().unwrap().unwrap(),WaveSample::Integer(1));reader.seek_frame(3).unwrap();assert!(reader.next().is_none());assert!(reader.seek_frame(4).is_err());}
}

#[test]
fn rf64_uses_non_sentinel_32_bit_fields_without_claiming_ignored_size_table_values(){
    let mut file=wav(&[1,0,2,0],true,1,16,false,false);let data=file.windows(4).position(|bytes|bytes==b"data").unwrap();
    let mut fact=Vec::new();chunk(&mut fact,b"fact",&2u32.to_le_bytes());file.splice(data..data,fact);let length=file.len() as u32-8;file[4..8].copy_from_slice(&length.to_le_bytes());file[data+16..data+20].copy_from_slice(&4u32.to_le_bytes());file[20..44].fill(255);
    assert_eq!(WaveReader::new(Cursor::new(file)).unwrap().collect::<Result<Vec<_>,_>>().unwrap(),vec![WaveSample::Integer(1),WaveSample::Integer(2)]);
}

#[test]
fn malformed_rf64_tables_lengths_formats_and_partial_frames_are_rejected(){
    let base=wav(&[0;8],true,2,16,false,false);let mut invalid=Vec::new();
    let mut bytes=base.clone();bytes[12..16].copy_from_slice(b"JUNK");invalid.push(bytes);
    let mut bytes=base.clone();bytes[16..20].copy_from_slice(&27u32.to_le_bytes());invalid.push(bytes);
    let mut bytes=base.clone();bytes[44..48].copy_from_slice(&10001u32.to_le_bytes());invalid.push(bytes);
    let mut bytes=base.clone();bytes[20..28].copy_from_slice(&u64::MAX.to_le_bytes());invalid.push(bytes);
    let mut bytes=base.clone();bytes[28..36].copy_from_slice(&u64::MAX.to_le_bytes());invalid.push(bytes);
    let mut bytes=base.clone();bytes[36..44].copy_from_slice(&3u64.to_le_bytes());invalid.push(bytes);
    let mut bytes=base.clone();bytes.pop();invalid.push(bytes);
    let mut bytes=wav(&[128],false,1,8,false,false);bytes.pop();let size=bytes.len() as u32-8;bytes[4..8].copy_from_slice(&size.to_le_bytes());invalid.push(bytes);
    invalid.push(wav(&[0;3],true,2,16,false,false));
    let mut bytes=base;let format=bytes.windows(4).position(|bytes|bytes==b"fmt ").unwrap();bytes[format+20..format+22].copy_from_slice(&3u16.to_le_bytes());invalid.push(bytes);
    for bytes in invalid{assert!(WaveReader::new(Cursor::new(bytes)).is_err());}
    for sample in [f32::NAN,f32::INFINITY]{let mut reader=WaveReader::new(Cursor::new(wav(&sample.to_le_bytes(),true,1,32,true,true))).unwrap();assert!(reader.next().unwrap().unwrap_err().contains("invalid floating"));assert!(reader.next().is_none());}
}

struct VirtualWave{header:Vec<u8>,length:u64,position:u64,read:Rc<Cell<u64>>,maximum:Rc<Cell<usize>>}

impl Read for VirtualWave{
    fn read(&mut self,output:&mut[u8])->std::io::Result<usize>{
        let length=(self.length-self.position).min(output.len() as u64) as usize;output[..length].fill(0);
        if self.position<(self.header.len() as u64){let available=length.min(self.header.len()-self.position as usize);output[..available].copy_from_slice(&self.header[self.position as usize..self.position as usize+available]);}
        self.position+=length as u64;self.read.set(self.read.get()+length as u64);self.maximum.set(self.maximum.get().max(length));Ok(length)
    }
}

impl Seek for VirtualWave{
    fn seek(&mut self,position:SeekFrom)->std::io::Result<u64>{let position=match position{SeekFrom::Start(value)=>i128::from(value),SeekFrom::Current(value)=>i128::from(self.position)+i128::from(value),SeekFrom::End(value)=>i128::from(self.length)+i128::from(value)};if position<0||position>i128::from(self.length){return Err(Error::new(ErrorKind::InvalidInput,"Invalid virtual seek"));}self.position=position as u64;Ok(self.position)}
}

#[test]
fn rf64_preserves_counts_and_frame_seeks_beyond_four_gibibytes_with_bounded_reads(){
    let mut header=wav(&[0;4],true,2,16,false,false);let offset=header.windows(4).position(|bytes|bytes==b"data").unwrap()+8;header.truncate(offset);
    let frames=u64::from(u32::MAX)+1;let data=frames*4;let length=offset as u64+data;header[20..28].copy_from_slice(&(length-8).to_le_bytes());header[28..36].copy_from_slice(&data.to_le_bytes());header[36..44].copy_from_slice(&frames.to_le_bytes());
    let read=Rc::new(Cell::new(0));let maximum=Rc::new(Cell::new(0));let mut reader=WaveReader::new(VirtualWave{header,length,position:0,read:read.clone(),maximum:maximum.clone()}).unwrap();assert_eq!(reader.frames(),frames);assert_eq!(reader.sample_count(),frames*2);reader.seek_frame(frames-1).unwrap();assert!(reader.input.position>u64::from(u32::MAX));assert_eq!(reader.collect::<Result<Vec<_>,_>>().unwrap(),vec![WaveSample::Integer(0),WaveSample::Integer(0)]);assert!(read.get()<256);assert!(maximum.get()<=40);
}
