use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

const DEFAULT_LEASE_MS: u64 = 60_000;
const MAX_LEASE_MS: u64 = 12 * 60 * 60 * 1_000;
const MAX_COMPLETED_OPERATION_IDS: usize = 4_096;

struct OperationLease {
    token: String,
    expires_at: Instant,
}

#[derive(Default)]
struct CrossWindowOperationRegistry {
    next_token: u64,
    leases: HashMap<String, OperationLease>,
    completed: HashSet<String>,
    completed_order: VecDeque<String>,
}

#[derive(Default)]
pub struct CrossWindowOperationState(Mutex<CrossWindowOperationRegistry>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginCrossWindowOperationRequest {
    operation_id: String,
    lease_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginCrossWindowOperationResponse {
    acquired: bool,
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettleCrossWindowOperationRequest {
    operation_id: String,
    token: String,
}

fn normalize_operation_id(operation_id: &str) -> Result<&str, String> {
    let operation_id = operation_id.trim();

    if operation_id.is_empty() {
        return Err("Expected a non-empty cross-window operation id.".to_string());
    }

    if operation_id.len() > 512 {
        return Err("Cross-window operation ids cannot exceed 512 characters.".to_string());
    }

    Ok(operation_id)
}

fn begin_operation(
    registry: &mut CrossWindowOperationRegistry,
    operation_id: String,
    lease_ms: Option<u64>,
    now: Instant,
) -> BeginCrossWindowOperationResponse {
    registry.leases.retain(|_, lease| lease.expires_at > now);

    if registry.completed.contains(&operation_id) {
        return BeginCrossWindowOperationResponse {
            acquired: false,
            token: None,
        };
    }

    if registry
        .leases
        .get(&operation_id)
        .is_some_and(|lease| lease.expires_at > now)
    {
        return BeginCrossWindowOperationResponse {
            acquired: false,
            token: None,
        };
    }

    registry.next_token = registry.next_token.saturating_add(1);
    let token = format!("{}:{}", std::process::id(), registry.next_token);
    let lease_ms = lease_ms.unwrap_or(DEFAULT_LEASE_MS).clamp(1, MAX_LEASE_MS);

    registry.leases.insert(
        operation_id,
        OperationLease {
            token: token.clone(),
            expires_at: now + Duration::from_millis(lease_ms),
        },
    );

    BeginCrossWindowOperationResponse {
        acquired: true,
        token: Some(token),
    }
}

fn settle_operation(
    registry: &mut CrossWindowOperationRegistry,
    operation_id: &str,
    token: &str,
    completed: bool,
) -> bool {
    let owns_lease = registry
        .leases
        .get(operation_id)
        .is_some_and(|lease| lease.token == token);

    if !owns_lease {
        return false;
    }

    registry.leases.remove(operation_id);

    if completed && registry.completed.insert(operation_id.to_string()) {
        registry.completed_order.push_back(operation_id.to_string());
    }

    while registry.completed_order.len() > MAX_COMPLETED_OPERATION_IDS {
        if let Some(stale_operation_id) = registry.completed_order.pop_front() {
            registry.completed.remove(&stale_operation_id);
        }
    }

    true
}

#[tauri::command]
pub fn begin_cross_window_operation(
    state: tauri::State<'_, CrossWindowOperationState>,
    request: BeginCrossWindowOperationRequest,
) -> Result<BeginCrossWindowOperationResponse, String> {
    let operation_id = normalize_operation_id(&request.operation_id)?.to_string();
    let mut registry = state
        .0
        .lock()
        .map_err(|_| "The cross-window operation registry is unavailable.".to_string())?;

    let now = Instant::now();

    Ok(begin_operation(
        &mut registry,
        operation_id,
        request.lease_ms,
        now,
    ))
}

#[tauri::command]
pub fn complete_cross_window_operation(
    state: tauri::State<'_, CrossWindowOperationState>,
    request: SettleCrossWindowOperationRequest,
) -> Result<bool, String> {
    let operation_id = normalize_operation_id(&request.operation_id)?.to_string();
    let mut registry = state
        .0
        .lock()
        .map_err(|_| "The cross-window operation registry is unavailable.".to_string())?;
    Ok(settle_operation(
        &mut registry,
        &operation_id,
        &request.token,
        true,
    ))
}

#[tauri::command]
pub fn release_cross_window_operation(
    state: tauri::State<'_, CrossWindowOperationState>,
    request: SettleCrossWindowOperationRequest,
) -> Result<bool, String> {
    let operation_id = normalize_operation_id(&request.operation_id)?.to_string();
    let mut registry = state
        .0
        .lock()
        .map_err(|_| "The cross-window operation registry is unavailable.".to_string())?;
    Ok(settle_operation(
        &mut registry,
        &operation_id,
        &request.token,
        false,
    ))
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{begin_operation, settle_operation, CrossWindowOperationRegistry};

    #[test]
    fn leases_are_exclusive_releasable_and_completable() {
        let mut registry = CrossWindowOperationRegistry::default();
        let now = Instant::now();
        let first = begin_operation(&mut registry, "queue:1".to_string(), Some(100), now);
        let token = first.token.expect("the first claim should return a token");

        assert!(first.acquired);
        assert!(!begin_operation(&mut registry, "queue:1".to_string(), Some(100), now).acquired);
        assert!(settle_operation(&mut registry, "queue:1", &token, false));

        let retried = begin_operation(
            &mut registry,
            "queue:1".to_string(),
            Some(100),
            now + Duration::from_millis(1),
        );
        let retried_token = retried.token.expect("a released claim can be retried");

        assert!(settle_operation(
            &mut registry,
            "queue:1",
            &retried_token,
            true,
        ));
        assert!(
            !begin_operation(
                &mut registry,
                "queue:1".to_string(),
                Some(100),
                now + Duration::from_secs(1),
            )
            .acquired
        );
    }

    #[test]
    fn expired_leases_are_pruned_when_an_operation_begins() {
        let mut registry = CrossWindowOperationRegistry::default();
        let now = Instant::now();

        for index in 0..100 {
            assert!(
                begin_operation(&mut registry, format!("expired:{index}"), Some(1), now,).acquired
            );
        }

        assert_eq!(registry.leases.len(), 100);
        assert!(
            begin_operation(
                &mut registry,
                "current".to_string(),
                Some(100),
                now + Duration::from_millis(2),
            )
            .acquired
        );
        assert_eq!(registry.leases.len(), 1);
    }
}
