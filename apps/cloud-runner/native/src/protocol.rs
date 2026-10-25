use serde::Deserialize;
use std::{collections::BTreeMap, io::BufRead, path::Path};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Control {
    Prepare {
        receipt_path: String,
        environment_id: String,
        cgroup_root: Option<String>,
    },
    Anchor {
        id: String,
    },
    Start {
        anchor_id: String,
        allowance_ms: u64,
        max_duration_ms: u64,
        memory_limit_bytes: usize,
        program: String,
        args: Vec<String>,
        directory: String,
        environment: BTreeMap<String, String>,
    },
    Renew {
        anchor_id: String,
        allowance_ms: u64,
    },
    Input {
        id: String,
        data: Option<String>,
    },
    Stop,
}

pub fn read_control(reader: &mut impl BufRead) -> Result<Option<Control>, String> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf().map_err(|error| error.to_string())?;
        if available.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err("Incomplete control message".to_string())
            };
        }
        let end = available.iter().position(|byte| *byte == b'\n');
        let count = end.map_or(available.len(), |index| index + 1);
        if bytes.len() + count > 1024 * 1024 {
            return Err("Control message exceeds limit".to_string());
        }
        bytes.extend_from_slice(&available[..count]);
        reader.consume(count);
        if end.is_some() {
            return serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|_| "Invalid control message".to_string());
        }
    }
}

pub fn validate_start(
    program: &str,
    args: &[String],
    directory: &str,
    environment: &BTreeMap<String, String>,
    duration: u64,
) -> Result<(), String> {
    if !Path::new(program).is_absolute()
        || !Path::new(directory).is_absolute()
        || args.len() > 100
        || args
            .iter()
            .any(|arg| arg.len() > 8192 || arg.contains('\0'))
        || environment.len() > 64
        || environment.iter().any(|(key, value)| {
            key.is_empty()
                || key.contains(['=', '\0'])
                || key.len() > 256
                || value.len() > 8192
                || value.contains('\0')
        })
        || !(1..=86_400_000).contains(&duration)
    {
        return Err("Invalid process configuration".to_string());
    }
    Ok(())
}
