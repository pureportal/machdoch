use std::io::{self, Cursor, Read};

use super::{tests::temporary_workspace, *};

const LIMIT: usize = 1024 * 1024;

fn boundary_document(size: usize, multibyte: bool) -> (RunConfigurationDocument, Vec<u8>) {
    let mut document = RunConfigurationDocument {
        schema_version: RUN_SCHEMA_VERSION,
        configurations: (0..8)
            .map(|index| RunConfiguration::Task {
                id: format!("task-{index}"),
                name: format!("Task {index}"),
                primary: index == 0,
                command: "echo ready".to_string(),
                working_directory: ".".to_string(),
                environment: (0..24)
                    .map(|entry| (format!("VALUE_{entry:02}"), String::new()))
                    .collect(),
                hot_reload: false,
                ports: Vec::new(),
                urls: Vec::new(),
                health_check: None,
                restart_policy: RunRestartPolicy::default(),
            })
            .collect(),
    };
    let mut remaining = size - serde_json::to_vec_pretty(&document).unwrap().len() - 1;
    for configuration in &mut document.configurations {
        let RunConfiguration::Task { environment, .. } = configuration else {
            unreachable!();
        };
        for value in environment.values_mut() {
            let bytes = remaining.min(8192);
            *value = if multibyte {
                "é".repeat(bytes / 2) + &"x".repeat(bytes % 2)
            } else {
                "x".repeat(bytes)
            };
            remaining -= bytes;
        }
    }
    assert_eq!(remaining, 0);
    validate_document(&document).unwrap();
    let mut persisted = serde_json::to_vec_pretty(&document).unwrap();
    persisted.push(b'\n');
    assert_eq!(persisted.len(), size);
    if multibyte {
        assert!(
            String::from_utf8(persisted.clone())
                .unwrap()
                .chars()
                .count()
                < size
        );
    }
    (document, persisted)
}

fn check_save(size: usize, multibyte: bool) {
    let workspace = temporary_workspace("save-boundary");
    let path = configuration_path(&workspace);
    save_document(&workspace, &RunConfigurationDocument::default()).unwrap();
    let previous = fs::read(&path).unwrap();
    let (document, expected) = boundary_document(size, multibyte);
    let result = save_document(&workspace, &document);
    let actual = fs::read(&path).unwrap();
    let reloaded = load_document(&workspace);
    fs::remove_dir_all(&workspace).unwrap();
    if size > LIMIT {
        assert!(
            actual == previous,
            "rejected save must preserve previous bytes"
        );
        assert_eq!(
            result.unwrap_err(),
            "Run configuration exceeds the 1 MB limit."
        );
        assert_eq!(reloaded.unwrap(), RunConfigurationDocument::default());
    } else {
        result.unwrap();
        assert!(
            actual == expected,
            "saved bytes must match complete representation"
        );
        assert_eq!(actual.last(), Some(&b'\n'));
        assert_eq!(reloaded.unwrap(), document);
    }
}

fn check_load(size: usize, multibyte: bool) {
    let workspace = temporary_workspace("load-boundary");
    let path = configuration_path(&workspace);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let (document, persisted) = boundary_document(size, multibyte);
    fs::write(&path, persisted).unwrap();
    let result = load_document(&workspace);
    fs::remove_dir_all(&workspace).unwrap();
    if size > LIMIT {
        assert!(result.unwrap_err().contains("exceeds the 1 MB limit"));
    } else {
        assert_eq!(result.unwrap(), document);
    }
}

macro_rules! boundary_case {
    ($name:ident, $check:ident, $size:expr, $multibyte:expr) => {
        #[test]
        fn $name() {
            $check($size, $multibyte);
        }
    };
}

boundary_case!(save_ascii_below_limit, check_save, LIMIT - 1, false);
boundary_case!(save_ascii_at_limit, check_save, LIMIT, false);
boundary_case!(save_ascii_above_limit, check_save, LIMIT + 1, false);
boundary_case!(save_utf8_below_limit, check_save, LIMIT - 1, true);
boundary_case!(save_utf8_at_limit, check_save, LIMIT, true);
boundary_case!(save_utf8_above_limit, check_save, LIMIT + 1, true);
boundary_case!(load_ascii_below_limit, check_load, LIMIT - 1, false);
boundary_case!(load_ascii_at_limit, check_load, LIMIT, false);
boundary_case!(load_ascii_above_limit, check_load, LIMIT + 1, false);
boundary_case!(load_utf8_below_limit, check_load, LIMIT - 1, true);
boundary_case!(load_utf8_at_limit, check_load, LIMIT, true);
boundary_case!(load_utf8_above_limit, check_load, LIMIT + 1, true);

struct CountingReader {
    input: Cursor<Vec<u8>>,
    consumed: usize,
}

impl Read for CountingReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let length = buffer.len().min(4093);
        let count = self.input.read(&mut buffer[..length])?;
        self.consumed += count;
        Ok(count)
    }
}

fn check_reader(size: usize, multibyte: bool) {
    let (document, persisted) = boundary_document(size, multibyte);
    let mut reader = CountingReader {
        input: Cursor::new(persisted),
        consumed: 0,
    };
    let result = read_document(&mut reader, Path::new("run.json"));
    assert_eq!(reader.consumed, size.min(LIMIT + 1));
    if size > LIMIT {
        assert!(result.unwrap_err().contains("exceeds the 1 MB limit"));
    } else {
        assert_eq!(result.unwrap(), document);
    }
}

boundary_case!(reader_below_limit, check_reader, LIMIT - 1, true);
boundary_case!(reader_at_limit, check_reader, LIMIT, true);
boundary_case!(reader_above_limit, check_reader, LIMIT + 1, true);
boundary_case!(
    reader_stops_at_detection_byte,
    check_reader,
    LIMIT + 8192,
    true
);

#[test]
fn reader_rejects_size_before_decoding_a_split_utf8_character() {
    let mut bytes = vec![b' '; LIMIT];
    bytes.extend_from_slice("é".as_bytes());
    let mut reader = CountingReader {
        input: Cursor::new(bytes),
        consumed: 0,
    };
    let result = read_document(&mut reader, Path::new("run.json"));
    assert_eq!(reader.consumed, LIMIT + 1);
    assert!(result.unwrap_err().contains("exceeds the 1 MB limit"));
}

#[test]
fn missing_ordinary_and_invalid_documents_keep_their_behavior() {
    let workspace = temporary_workspace("ordinary-errors");
    let document = RunConfigurationDocument::default();
    assert_eq!(load_document(&workspace).unwrap(), document);
    let path = save_document(&workspace, &document).unwrap();
    assert_eq!(load_document(&workspace).unwrap(), document);
    assert_eq!(fs::read(&path).unwrap().last(), Some(&b'\n'));
    fs::write(&path, b"{").unwrap();
    assert!(load_document(&workspace)
        .unwrap_err()
        .starts_with("Failed to parse "));
    fs::write(&path, [0xff]).unwrap();
    assert!(load_document(&workspace)
        .unwrap_err()
        .starts_with("Failed to read "));
    fs::remove_dir_all(&workspace).unwrap();
}

#[test]
fn reader_propagates_io_errors() {
    struct FailedReader;
    impl Read for FailedReader {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("controlled read failure"))
        }
    }
    let error = read_document(FailedReader, Path::new("run.json")).unwrap_err();
    assert!(error.starts_with("Failed to read "));
    assert!(error.contains("controlled read failure"));
}
