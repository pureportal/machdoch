use std::{thread, time::Duration};

use super::{
    commands::FleetControlCommandEvent, state::RecordCommandError, CompletedFleetCommandReceipt,
    FleetControlState,
};

fn pending_state(command_id: &str) -> FleetControlState {
    let state = FleetControlState::default();
    let mut inner = state.shared.inner.lock().unwrap();
    inner.state_loaded = true;
    inner.pending_commands.push_back(FleetControlCommandEvent {
        command_id: command_id.to_string(),
        ..serde_json::from_value(serde_json::json!({
            "commandId": command_id,
            "kind": "set-auto-speak",
            "enabled": false,
            "createdAt": 1
        }))
        .unwrap()
    });
    drop(inner);
    state
}

fn complete(state: &FleetControlState, command_id: &str, error: Option<String>) {
    let mut inner = state.shared.inner.lock().unwrap();
    inner
        .pending_commands
        .retain(|entry| entry.command_id != command_id);
    inner
        .completed_commands
        .push_back(CompletedFleetCommandReceipt {
            command_id: command_id.to_string(),
            payload_hash: "payload".to_string(),
            completed_at: 1,
            error,
        });
    state.shared.command_completed.notify_all();
}

#[test]
fn pending_command_waits_for_device_completion() {
    let state = pending_state("command-1");
    let waiting = state.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    let worker = thread::spawn(move || {
        sender
            .send(waiting.wait_for_command_completion("command-1", Duration::from_secs(2)))
            .unwrap();
    });
    assert_eq!(
        receiver.recv_timeout(Duration::from_millis(20)),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout)
    );
    complete(&state, "command-1", None);
    assert_eq!(
        receiver.recv_timeout(Duration::from_secs(2)).unwrap(),
        Ok(())
    );
    worker.join().unwrap();
    assert_eq!(
        state.wait_for_command_completion("command-1", Duration::ZERO),
        Ok(())
    );
}

#[test]
fn failed_device_completion_is_preserved_on_replay() {
    let state = pending_state("command-1");
    complete(
        &state,
        "command-1",
        Some("Context pack was removed.".to_string()),
    );
    for _ in 0..2 {
        assert_eq!(
            state.wait_for_command_completion("command-1", Duration::ZERO),
            Err(RecordCommandError::Unavailable(
                "Context pack was removed.".to_string()
            ))
        );
    }
}

#[test]
fn unconfirmed_command_remains_pending_after_timeout() {
    let state = pending_state("command-1");
    let error = state
        .wait_for_command_completion("command-1", Duration::from_millis(5))
        .unwrap_err();
    assert!(
        matches!(error, RecordCommandError::Unavailable(message) if message.contains("not confirmed"))
    );
    assert_eq!(state.pending_commands().unwrap().len(), 1);
    let error = state
        .wait_for_command_completion("unknown", Duration::from_secs(2))
        .unwrap_err();
    assert!(
        matches!(error, RecordCommandError::Unavailable(message) if message.contains("no longer recorded"))
    );
}
