use super::*;
use std::path::PathBuf;

struct Recording(PathBuf);

impl Recording{
    fn new(bits:u16,channels:u16,samples:&[i32])->Self{
        let root=std::env::temp_dir().join(format!("speech-reference-wave-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));std::fs::create_dir(&root).unwrap();
        let mut writer=hound::WavWriter::create(root.join("original.wav"),hound::WavSpec{channels,sample_rate:8000,bits_per_sample:bits,sample_format:hound::SampleFormat::Int}).unwrap();for sample in samples{writer.write_sample(*sample).unwrap();}writer.finalize().unwrap();Self(root)
    }
}

impl Drop for Recording{
    fn drop(&mut self){let root=self.0.canonicalize().unwrap();assert!(root.starts_with(std::env::temp_dir().canonicalize().unwrap()));std::fs::remove_dir_all(root).unwrap();}
}

#[test]
fn odd_sized_reference_trims_finalize_riff_padding_and_preserve_original_samples(){
    for bits in [8,24]{
        let minimum=-(1i32<<(bits-1));let maximum=(1i32<<(bits-1))-1;let samples=[minimum,0,maximum,0];let fixture=Recording::new(bits,1,&samples);let original=fixture.0.join("original.wav");let output=fixture.0.join("trimmed.wav");let before=std::fs::read(&original).unwrap();
        trim(&original,&output,0.0,3.0/8000.0).unwrap();let actual=std::fs::read(&output).unwrap();assert_eq!(actual.len()%2,0);let (duration,rate,channels)=inspect_wav(&output).unwrap();assert_eq!((rate,channels),(8000,1));assert!((duration-3.0/8000.0).abs()<1e-12);
        let decoded=WaveReader::open(&output).unwrap().collect::<Result<Vec<_>,_>>().unwrap();assert_eq!(decoded,samples[..3].iter().map(|sample|WaveSample::Integer(*sample)).collect::<Vec<_>>());assert_eq!(std::fs::read(&original).unwrap(),before);
    }
}

#[test]
fn reference_trim_seeks_by_stereo_frames_without_decoding_the_prefix(){
    let fixture=Recording::new(16,2,&[0,1,2,3,4,5,6,7]);let output=fixture.0.join("trimmed.wav");trim(&fixture.0.join("original.wav"),&output,1.0/8000.0,3.0/8000.0).unwrap();
    assert_eq!(WaveReader::open(&output).unwrap().collect::<Result<Vec<_>,_>>().unwrap(),vec![WaveSample::Integer(2),WaveSample::Integer(3),WaveSample::Integer(4),WaveSample::Integer(5)]);
}
