use super::*;
use serde::Serialize;
use std::io::{self, Write};

const MAX_BYTES: usize = 64 * 1024 * 1024;
const LIMIT_ERROR: &str = "Project metadata exceeds the local 64 MiB or item archive guard. Export a smaller project.";

#[derive(Default)]
pub struct ArchiveBudget {
    bytes: usize,
    items: usize,
}

struct CountingWriter {
    bytes: usize,
    limit: usize,
}

impl Write for CountingWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.bytes = self.bytes.checked_add(bytes.len()).filter(|size| *size <= self.limit)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, LIMIT_ERROR))?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl ArchiveBudget {
    pub fn reserve(&mut self, bytes: usize, items: usize) -> Result<(), String> {
        let bytes = self.bytes.checked_add(bytes).filter(|size| *size <= MAX_BYTES).ok_or(LIMIT_ERROR)?;
        let items = self.items.checked_add(items).filter(|count| *count <= MAX_ITEMS).ok_or(LIMIT_ERROR)?;
        self.bytes = bytes;
        self.items = items;
        Ok(())
    }

    pub fn reserve_sql(&mut self, bytes: i64, items: usize) -> Result<usize, String> {
        let bytes = usize::try_from(bytes).map_err(|_| LIMIT_ERROR)?;
        self.reserve(bytes, items)?;
        Ok(bytes)
    }

    pub fn value<T: Serialize + ?Sized>(&mut self, value: &T, items: usize) -> Result<(), String> {
        self.reserve(0, items)?;
        self.growth(value, 0)
    }

    pub fn growth<T: Serialize + ?Sized>(&mut self, value: &T, prepaid: usize) -> Result<(), String> {
        let limit = MAX_BYTES.checked_sub(self.bytes).and_then(|remaining| remaining.checked_add(prepaid))
            .filter(|limit| *limit <= MAX_BYTES).ok_or(LIMIT_ERROR)?;
        let mut writer = CountingWriter { bytes: 0, limit };
        serde_json::to_writer(&mut writer, value).map_err(|_| LIMIT_ERROR.to_owned())?;
        self.reserve(writer.bytes.saturating_sub(prepaid), 0)
    }

    pub fn json_row(&mut self, row: &rusqlite::Row<'_>) -> Result<Value, String> {
        let prepaid = self.reserve_sql(row.get(0).map_err(error)?, 1)?;
        let value = parse_json(row.get::<_, String>(1).map_err(error)?)?;
        self.growth(&value, prepaid)?;
        Ok(value)
    }
}

pub fn records(
    connection: &Connection,
    sql: &str,
    parameters: impl rusqlite::Params,
    budget: &mut ArchiveBudget,
) -> Result<Vec<Value>, String> {
    let mut statement = connection.prepare(sql).map_err(error)?;
    let mut rows = statement.query(parameters).map_err(error)?;
    let mut values = Vec::new();
    while let Some(row) = rows.next().map_err(error)? {
        values.push(budget.json_row(row)?);
    }
    Ok(values)
}

pub fn insert_dependency(ids: &mut HashSet<String>, id: &str) -> Result<bool, String> {
    if ids.contains(id) {
        return Ok(false);
    }
    if ids.len() >= MAX_ITEMS {
        return Err(LIMIT_ERROR.into());
    }
    ids.insert(id.to_owned());
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_admission_counts_utf8_bytes_before_decoding() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE records(data TEXT NOT NULL)").unwrap();
        connection.execute("INSERT INTO records VALUES(?1)", [r#"{"text":"é😀"}"#]).unwrap();
        let lengths: (i64, i64) = connection.query_row(
            "SELECT length(data),length(CAST(data AS BLOB)) FROM records",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert!(lengths.1 > lengths.0);
        let mut budget = ArchiveBudget::default();
        budget.reserve(MAX_BYTES - lengths.1 as usize, 0).unwrap();
        let values = records(&connection, "SELECT length(CAST(data AS BLOB)),data FROM records", [], &mut budget).unwrap();
        assert_eq!(values[0]["text"], "é😀");
        assert_eq!(budget.bytes, MAX_BYTES);
        let mut denied = ArchiveBudget::default();
        denied.reserve(MAX_BYTES - lengths.1 as usize + 1, 0).unwrap();
        assert!(records(&connection, "SELECT length(CAST(data AS BLOB)),CAST(x'ff' AS TEXT) FROM records", [], &mut denied)
            .unwrap_err().contains("archive guard"));
    }

    #[test]
    fn admission_rejects_overflow_without_changing_usage() {
        let mut budget = ArchiveBudget::default();
        budget.reserve(1, 1).unwrap();
        assert!(budget.reserve(usize::MAX, 0).is_err());
        assert!(budget.reserve(0, usize::MAX).is_err());
        assert!(budget.reserve_sql(-1, 1).is_err());
        assert_eq!((budget.bytes, budget.items), (1, 1));
        let mut writer = CountingWriter { bytes: usize::MAX, limit: usize::MAX };
        assert!(writer.write(b"x").is_err());
        let mut full = ArchiveBudget::default();
        full.reserve(0, MAX_ITEMS).unwrap();
        assert!(full.reserve(0, 1).is_err());
    }

    #[test]
    fn dependencies_are_admitted_once_before_fetching() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE takes(id TEXT PRIMARY KEY,data TEXT NOT NULL);
            INSERT INTO takes VALUES('parent','{\"id\":\"parent\"}')").unwrap();
        let root = json!({"id":"root","parentTakeId":"parent","reusedFromTakeId":"parent"});
        let mut ids = HashSet::from(["root".to_owned()]);
        let mut budget = ArchiveBudget::default();
        let mut pending = VecDeque::new();
        for field in ["parentTakeId", "reusedFromTakeId"] {
            let id = root[field].as_str().unwrap();
            if insert_dependency(&mut ids, id).unwrap() {
                pending.extend(records(&connection,
                    "SELECT length(CAST(data AS BLOB)),data FROM takes WHERE id=?1",
                    [id], &mut budget).unwrap());
            }
        }
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0]["id"], "parent");
        assert_eq!(budget.items, 1);
        assert_eq!(ids.len(), 2);
        let mut full: HashSet<_> = (0..MAX_ITEMS).map(|id| id.to_string()).collect();
        assert!(!insert_dependency(&mut full, "0").unwrap());
        assert!(insert_dependency(&mut full, "new").is_err());
    }

    #[test]
    fn permission_digest_preserves_the_existing_projection() {
        let id = "a".repeat(64);
        let manifest = json!({
            "project":{"id":"project-1","revisionId":"revision-1"},
            "assets":{id.clone():{"bytes":4}},
            "references":{id:{"transcript":"é😀\n","rightsEvidence":"Signed\npermission"}},
            "originals":[]
        });
        let inventory = super::super::super::archive_permissions::inventory(&manifest).unwrap();
        let projection = json!({"projectId":"project-1","references":inventory["references"]});
        let expected = digest(encode(&projection).unwrap().as_bytes());
        assert_eq!(inventory["inventorySha256"], expected);
    }

    #[test]
    fn repeated_occurrences_share_the_streaming_budget() {
        let value = json!({"rightsEvidence":"é\n😀"});
        let mut budget = ArchiveBudget::default();
        budget.value(&value, 1).unwrap();
        let first = budget.bytes;
        budget.value(&value, 1).unwrap();
        assert_eq!(budget.bytes, first * 2);
        assert_eq!(budget.items, 2);
        budget.reserve(MAX_BYTES - budget.bytes, 0).unwrap();
        assert!(budget.value(&value, 1).is_err());
    }
}
