use std::{
    fs::File,
    io::{BufReader, Read, Seek, SeekFrom},
    path::Path,
};

use super::MediaResult;

struct HeaderReader {
    stream: BufReader<File>,
}

pub(super) struct GgufWeights {
    pub tensor_count: u32,
    pub architecture: String,
}

impl HeaderReader {
    fn bytes<const N: usize>(&mut self) -> MediaResult<[u8; N]> {
        if self
            .stream
            .stream_position()
            .map_err(|error| error.to_string())?
            > 32 * 1024 * 1024
        {
            return Err("The GGUF header exceeds its size limit.".to_string());
        }
        let mut value = [0; N];
        self.stream
            .read_exact(&mut value)
            .map_err(|error| format!("Invalid GGUF header: {error}"))?;
        Ok(value)
    }

    fn u32(&mut self) -> MediaResult<u32> {
        Ok(u32::from_le_bytes(self.bytes()?))
    }

    fn u64(&mut self) -> MediaResult<u64> {
        Ok(u64::from_le_bytes(self.bytes()?))
    }

    fn string(&mut self) -> MediaResult<String> {
        let length = self.u64()?;
        if length > 1024 * 1024 {
            return Err("The GGUF string exceeds its size limit.".to_string());
        }
        let mut value = vec![0; length as usize];
        self.stream
            .read_exact(&mut value)
            .map_err(|error| error.to_string())?;
        String::from_utf8(value).map_err(|error| format!("Invalid GGUF text: {error}"))
    }

    fn skip_value(&mut self, kind: u32, depth: u32) -> MediaResult<()> {
        let size = match kind {
            0 | 1 | 7 => 1,
            2 | 3 => 2,
            4..=6 => 4,
            10..=12 => 8,
            8 => {
                self.string()?;
                return Ok(());
            }
            9 if depth < 3 => {
                let element = self.u32()?;
                let count = self.u64()?;
                if count > 100_000 {
                    return Err("The GGUF metadata array exceeds its size limit.".to_string());
                }
                for _ in 0..count {
                    self.skip_value(element, depth + 1)?;
                }
                return Ok(());
            }
            _ => return Err("The GGUF metadata has an unsupported value type.".to_string()),
        };
        self.stream
            .seek(SeekFrom::Current(size))
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

pub(super) fn validate(path: &Path) -> MediaResult<GgufWeights> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let file_size = file.metadata().map_err(|error| error.to_string())?.len();
    let mut header = HeaderReader {
        stream: BufReader::new(file),
    };
    if header.bytes::<4>()? != *b"GGUF" || header.u32()? != 3 {
        return Err("Choose a GGUF version 3 transformer.".to_string());
    }
    let tensor_count = header.u64()?;
    let metadata_count = header.u64()?;
    if tensor_count == 0 || tensor_count > 50_000 || metadata_count > 4_096 {
        return Err("The GGUF header has invalid entry counts.".to_string());
    }
    let mut alignment = 32_u64;
    let mut architecture = None;
    for _ in 0..metadata_count {
        let key = header.string()?;
        let kind = header.u32()?;
        if key == "general.alignment" {
            if kind != 4 {
                return Err("The GGUF alignment must be an unsigned integer.".to_string());
            }
            alignment = u64::from(header.u32()?);
            if alignment == 0 || alignment > 4_096 || !alignment.is_power_of_two() {
                return Err("The GGUF tensor alignment is invalid.".to_string());
            }
        } else if key == "general.architecture" {
            if kind != 8 || architecture.is_some() {
                return Err("The GGUF architecture metadata is invalid.".to_string());
            }
            architecture = Some(header.string()?);
        } else {
            header.skip_value(kind, 0)?;
        }
    }
    let mut names = std::collections::HashSet::new();
    let mut ranges = Vec::with_capacity(tensor_count as usize);
    for _ in 0..tensor_count {
        let name = header.string()?;
        if name.is_empty() || !names.insert(name) {
            return Err("The GGUF tensor names must be nonempty and unique.".to_string());
        }
        let dimensions = header.u32()?;
        if !(1..=4).contains(&dimensions) {
            return Err("The GGUF tensor dimensions are invalid.".to_string());
        }
        let mut elements = 1_u64;
        let mut row = 0;
        for dimension in 0..dimensions {
            let size = header.u64()?;
            if size == 0 {
                return Err("The GGUF tensor dimensions must be positive.".to_string());
            }
            if dimension == 0 {
                row = size;
            }
            elements = elements
                .checked_mul(size)
                .ok_or("The GGUF tensor is too large")?;
        }
        let (block, bytes) = match header.u32()? {
            0 => (1, 4),
            1 | 30 => (1, 2),
            2 => (32, 18),
            3 => (32, 20),
            6 => (32, 22),
            7 => (32, 24),
            8 => (32, 34),
            10 => (256, 84),
            11 => (256, 110),
            12 => (256, 144),
            13 => (256, 176),
            14 => (256, 210),
            _ => {
                return Err(
                    "The GGUF transformer uses an unsupported quantization type.".to_string(),
                )
            }
        };
        if row % block != 0 {
            return Err("The GGUF tensor row has an incomplete quantization block.".to_string());
        }
        let length = (elements / block)
            .checked_mul(bytes)
            .ok_or("The GGUF tensor is too large")?;
        let start = header.u64()?;
        if start % alignment != 0 {
            return Err("The GGUF tensor offset is not aligned.".to_string());
        }
        let end = start
            .checked_add(length)
            .ok_or("The GGUF tensor offset is too large")?;
        ranges.push((start, end));
    }
    let position = header
        .stream
        .stream_position()
        .map_err(|error| error.to_string())?;
    let data_start = position.div_ceil(alignment) * alignment;
    let data_size = file_size
        .checked_sub(data_start)
        .ok_or("The GGUF tensor data is missing")?;
    ranges.sort_unstable();
    let mut previous_end = 0;
    for (start, end) in ranges {
        if start < previous_end || end > data_size {
            return Err("The GGUF tensor data is truncated or overlapping.".to_string());
        }
        previous_end = end;
    }
    Ok(GgufWeights {
        tensor_count: tensor_count as u32,
        architecture: architecture.ok_or("The GGUF architecture metadata is missing")?,
    })
}

#[cfg(test)]
pub(super) fn fixture(architecture: &str, quantization: u32, row: u64, payload: usize) -> Vec<u8> {
    let mut bytes = b"GGUF".to_vec();
    bytes.extend(3_u32.to_le_bytes());
    bytes.extend(1_u64.to_le_bytes());
    bytes.extend(1_u64.to_le_bytes());
    bytes.extend((b"general.architecture".len() as u64).to_le_bytes());
    bytes.extend(b"general.architecture");
    bytes.extend(8_u32.to_le_bytes());
    bytes.extend((architecture.len() as u64).to_le_bytes());
    bytes.extend(architecture.as_bytes());
    bytes.extend(6_u64.to_le_bytes());
    bytes.extend(b"weight");
    bytes.extend(2_u32.to_le_bytes());
    bytes.extend(row.to_le_bytes());
    bytes.extend(1_u64.to_le_bytes());
    bytes.extend(quantization.to_le_bytes());
    bytes.extend(0_u64.to_le_bytes());
    bytes.resize(bytes.len().div_ceil(32) * 32 + payload, 0);
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestWeights(std::path::PathBuf);

    impl TestWeights {
        fn new(bytes: &[u8]) -> Self {
            let path = std::env::temp_dir().join(format!(
                "machdoch-gguf-test-{}.gguf",
                crate::media::model_import::new_import_id().unwrap()
            ));
            std::fs::write(&path, bytes).unwrap();
            Self(path)
        }
    }

    impl Drop for TestWeights {
        fn drop(&mut self) {
            std::fs::remove_file(&self.0).unwrap();
        }
    }

    #[test]
    fn supported_gguf_quantizations_validate_their_real_block_sizes() {
        for (kind, row, size) in [
            (0, 4, 16),
            (30, 4, 8),
            (2, 32, 18),
            (12, 256, 144),
            (14, 256, 210),
        ] {
            let weights = TestWeights::new(&fixture("qwen_image21", kind, row, size));
            assert_eq!(validate(&weights.0).unwrap().tensor_count, 1);
        }
    }

    #[test]
    fn corrupt_gguf_data_is_rejected_before_import() {
        for bytes in [
            fixture("qwen_image21", 12, 256, 143),
            fixture("qwen_image21", 12, 255, 144),
            fixture("qwen_image21", 9, 32, 40),
            fixture("qwen_image21", 99, 256, 144),
            b"invalid GGUF".to_vec(),
        ] {
            let weights = TestWeights::new(&bytes);
            assert!(validate(&weights.0).is_err());
        }
        let mut bytes = fixture("qwen_image21", 0, 4, 16);
        bytes[4..8].copy_from_slice(&2_u32.to_le_bytes());
        let weights = TestWeights::new(&bytes);
        assert!(validate(&weights.0).err().unwrap().contains("version 3"));
    }
}
