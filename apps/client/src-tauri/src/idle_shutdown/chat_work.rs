use serde_json::Value;

pub(super) fn has_pending_chat_work(
    state: &Value,
    automatic_retries: bool,
    retry_attempts: u32,
) -> Result<bool, String> {
    let queued = array_field(state, "queuedSessionMessages")?;
    if !queued.is_empty() {
        return Ok(true);
    }
    for session in array_field(state, "sessions")? {
        let messages = array_field(session, "messages")?;
        let mut latest_user = None;
        for message in messages {
            if !matches!(message["role"].as_str(), Some("user" | "agent")) {
                return Err("Chat message state is unavailable.".to_string());
            }
            if is_transient(message) {
                return Ok(true);
            }
            if message["role"] != "user" {
                continue;
            }
            let task_id = task_id(message)?;
            if task_outcome(messages, task_id)?.is_none() {
                return Ok(true);
            }
            latest_user = Some(message);
        }
        if !automatic_retries || retry_attempts == 0 {
            continue;
        }
        let Some(source) = latest_user else {
            continue;
        };
        let Some(attempt) = source.get("executionAttempt") else {
            continue;
        };
        let retry_number = attempt["retryNumber"]
            .as_u64()
            .ok_or("Chat retry state is unavailable.")?;
        if retry_number < u64::from(retry_attempts)
            && matches!(
                task_outcome(messages, task_id(source)?)?,
                Some("failed" | "crashed" | "timed-out")
            )
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn array_field<'a>(value: &'a Value, field: &str) -> Result<&'a Vec<Value>, String> {
    value[field]
        .as_array()
        .ok_or_else(|| format!("Chat work could not be checked: {field} is unavailable."))
}

fn task_id(message: &Value) -> Result<&str, String> {
    message
        .get("taskId")
        .filter(|value| !value.is_null())
        .unwrap_or(&message["id"])
        .as_str()
        .ok_or_else(|| "Chat task identity is unavailable.".to_string())
}

fn is_transient(message: &Value) -> bool {
    message["lifecycle"]["kind"] == "transient"
        && message["lifecycle"]["operationId"].is_string()
        && message["lifecycle"]["operationId"] == message["taskId"]
}

fn task_outcome<'a>(messages: &'a [Value], id: &str) -> Result<Option<&'a str>, String> {
    let mut thinking = None;
    for message in messages.iter().rev() {
        if message["role"] != "agent"
            || message["source"]["kind"] == "preview"
            || is_transient(message)
            || task_id(message)? != id
        {
            continue;
        }
        if message["source"]["kind"] == "thinking" {
            thinking.get_or_insert(message);
            continue;
        }
        return message_outcome(message);
    }
    thinking
        .map(message_outcome)
        .transpose()
        .map(Option::flatten)
}

fn message_outcome(message: &Value) -> Result<Option<&str>, String> {
    if let Some(outcome) = message.get("outcome") {
        return match outcome["status"].as_str() {
            Some(
                status @ ("succeeded" | "failed" | "crashed" | "timed-out" | "cancelled"
                | "blocked" | "unsupported"),
            ) => Ok(Some(status)),
            _ => Err("Chat task outcome is unavailable.".to_string()),
        };
    }
    let Some(source) = message.get("source").filter(|source| !source.is_null()) else {
        return Ok(Some("succeeded"));
    };
    match source["kind"].as_str() {
        Some("interrupted-task") => Ok(Some("crashed")),
        Some("execution") => match source["execution"]["status"].as_str() {
            Some("executed" | "planned") => Ok(Some("succeeded")),
            Some(status @ ("failed" | "cancelled" | "blocked" | "unsupported")) => Ok(Some(status)),
            _ => Err("Chat execution outcome is unavailable.".to_string()),
        },
        Some("thinking") if source["thinking"]["status"] == "complete" => Ok(Some("succeeded")),
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests;
