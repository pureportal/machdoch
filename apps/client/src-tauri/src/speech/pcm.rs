pub(super) const SAMPLE_RATE:u32=24_000;
pub(super) const CHANNELS:u16=1;

pub(super) fn wav_header(bytes:u64)->Result<[u8;44],String>{
    wav_header_for(bytes,SAMPLE_RATE,CHANNELS)
}

pub(super) fn wav_header_for(bytes:u64,rate:u32,channels:u16)->Result<[u8;44],String>{
    if !(8000..=192000).contains(&rate)||!(1..=2).contains(&channels){return Err("The PCM sample format is unsupported.".into());}
    let alignment=channels*2;
    if bytes==0||bytes%u64::from(alignment)!=0||bytes>u64::from(u32::MAX-36){return Err("Speech returned empty, incomplete or oversized PCM audio.".into());}
    let size=bytes as u32;let mut header=[0;44];
    header[0..4].copy_from_slice(b"RIFF");header[4..8].copy_from_slice(&(size+36).to_le_bytes());header[8..16].copy_from_slice(b"WAVEfmt ");
    header[16..20].copy_from_slice(&16u32.to_le_bytes());header[20..22].copy_from_slice(&1u16.to_le_bytes());header[22..24].copy_from_slice(&channels.to_le_bytes());
    header[24..28].copy_from_slice(&rate.to_le_bytes());header[28..32].copy_from_slice(&(rate*u32::from(alignment)).to_le_bytes());header[32..34].copy_from_slice(&alignment.to_le_bytes());
    header[34..36].copy_from_slice(&16u16.to_le_bytes());header[36..40].copy_from_slice(b"data");header[40..44].copy_from_slice(&size.to_le_bytes());Ok(header)
}
