use std::{fs, io::ErrorKind};

use serde::{Deserialize, Serialize};

use super::resolve_workspace_root_path;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningBankLesson {
    id: String,
    title: String,
    description: String,
    content: String,
    trigger_terms: Vec<String>,
    outcome: String,
    confidence: f64,
    evidence_count: u64,
    helpful_count: u64,
    harmful_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    retrieval_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_retrieved_at: Option<f64>,
    created_at: f64,
    updated_at: f64,
}

#[derive(Deserialize)]
struct ReasoningBankDocument {
    version: u8,
    lessons: Vec<ReasoningBankLesson>,
}

pub(super) fn load_reasoning_bank_lessons(
    workspace_root: &str,
) -> Result<Vec<ReasoningBankLesson>, String> {
    let path = resolve_workspace_root_path(workspace_root)?
        .join(".machdoch")
        .join("reasoning-bank.json");
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Failed to read {}: {error}", path.display())),
    };
    let document = serde_json::from_str::<ReasoningBankDocument>(&raw)
        .map_err(|error| format!("Failed to parse {}: {error}", path.display()))?;
    if document.version != 1 {
        return Err(format!(
            "Unsupported ReasoningBank version in {}.",
            path.display()
        ));
    }
    Ok(document.lessons)
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn loads_all_lessons_and_existing_usage_fields() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should be available")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "machdoch-reasoning-bank-{}-{unique}",
            std::process::id()
        ));
        let directory = root.join(".machdoch");
        fs::create_dir_all(&directory).expect("directory should be created");
        let document = serde_json::json!({
            "version": 1,
            "lessons": [
                {
                    "id": "first", "title": "First", "description": "A description",
                    "content": "First lesson", "triggerTerms": ["first"],
                    "outcome": "success", "confidence": 0.8,
                    "evidenceCount": 2, "helpfulCount": 1, "harmfulCount": 0,
                    "retrievalCount": 3, "lastRetrievedAt": 1000,
                    "createdAt": 10, "updatedAt": 20
                },
                {
                    "id": "second", "title": "Second", "description": "Another description",
                    "content": "Second lesson", "triggerTerms": [],
                    "outcome": "failure", "confidence": 0.6,
                    "evidenceCount": 1, "helpfulCount": 0, "harmfulCount": 1,
                    "createdAt": 11, "updatedAt": 21
                }
            ]
        });
        fs::write(directory.join("reasoning-bank.json"), document.to_string())
            .expect("bank should be written");

        let lessons =
            load_reasoning_bank_lessons(root.to_str().unwrap()).expect("lessons should load");
        assert_eq!(lessons.len(), 2);
        assert_eq!(lessons[0].retrieval_count, Some(3));
        assert_eq!(lessons[0].last_retrieved_at, Some(1000.0));
        assert_eq!(lessons[1].retrieval_count, None);
        assert_eq!(lessons[1].last_retrieved_at, None);
        let older_lesson = serde_json::to_value(&lessons[1]).expect("lesson should serialize");
        assert!(older_lesson.get("lastRetrievedAt").is_none());

        fs::remove_dir_all(&root).expect("workspace should be removed");
    }
}
