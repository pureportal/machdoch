use super::{FleetControlCommandEvent, FleetShellSnapshot};
use std::collections::HashSet;

pub(super) fn validate_session_ids(
    session_ids: Vec<String>,
    shell: &FleetShellSnapshot,
) -> Result<HashSet<String>, String> {
    if session_ids.iter().any(|id| {
        id.is_empty()
            || id.trim() != id
            || id.encode_utf16().count() > super::MAX_FLEET_SHORT_TEXT_CHARS
    }) {
        return Err("The session list is invalid. Refresh the device.".to_string());
    }
    let count = session_ids.len();
    let session_ids: HashSet<String> = session_ids.into_iter().collect();
    if count != session_ids.len()
        || shell
            .sessions
            .iter()
            .any(|session| !session_ids.contains(&session.id))
    {
        return Err("The session list is invalid. Refresh the device.".to_string());
    }
    Ok(session_ids)
}

pub(super) fn validate_command_target(
    command: &FleetControlCommandEvent,
    shell: Option<&FleetShellSnapshot>,
    session_ids: &HashSet<String>,
) -> Result<(), String> {
    if let Some(session_id) = command.session_id.as_deref() {
        if !session_ids.contains(session_id) {
            return Err(
                "The selected session is no longer available. Refresh the device.".to_string(),
            );
        }
    }
    match command.kind.as_str() {
        "set-auto-speak" => {
            if !shell
                .and_then(|snapshot| snapshot.voice.as_ref())
                .is_some_and(|voice| voice.supported)
            {
                return Err("Speech playback is unavailable on this device.".to_string());
            }
        }
        "set-speech-input-recording" => {
            let snapshot = shell.ok_or("The device is still loading. Try again.")?;
            if command.session_id != snapshot.active_session_id {
                return Err(
                    "Select this session on the device before using its microphone.".to_string(),
                );
            }
            let voice = snapshot
                .voice
                .as_ref()
                .ok_or("Speech input is unavailable on this device.")?;
            if voice.speech_input_busy {
                return Err("Speech input is busy. Wait for it to finish.".to_string());
            }
            if command.enabled == Some(true)
                && (!voice.speech_input_supported || !voice.speech_input_enabled)
            {
                return Err("Configure speech input on this device first.".to_string());
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn shell() -> FleetShellSnapshot {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../packages/fleet-protocol/fixtures/desktop-snapshot.json"
        ))
        .unwrap();
        let mut value = fixture["response"]["snapshot"]["shell"].clone();
        value["voice"] = json!({ "supported": true, "autoSpeakResponses": false, "speechInputSupported": true, "speechInputEnabled": true, "speechInputRecording": false, "speechInputBusy": false, "speechInputStatus": null });
        let mut snapshot: FleetShellSnapshot = serde_json::from_value(value).unwrap();
        snapshot.active_session_id = Some("session-1".to_string());
        snapshot
            .sessions
            .push(super::super::shell::FleetShellSession {
                id: "session-1".to_string(),
                ..Default::default()
            });
        snapshot
    }

    fn microphone(session: &str, enabled: bool) -> FleetControlCommandEvent {
        serde_json::from_value(json!({ "commandId": "verification-command", "kind": "set-speech-input-recording", "sessionId": session, "enabled": enabled, "createdAt": 1 })).unwrap()
    }

    fn session_ids(snapshot: &FleetShellSnapshot) -> HashSet<String> {
        snapshot
            .sessions
            .iter()
            .map(|session| session.id.clone())
            .collect()
    }

    #[test]
    fn microphone_requires_the_existing_active_session() {
        let mut snapshot = shell();
        let active = snapshot.active_session_id.clone().unwrap();
        assert!(validate_command_target(
            &microphone(&active, true),
            Some(&snapshot),
            &session_ids(&snapshot)
        )
        .is_ok());
        assert!(validate_command_target(
            &microphone("missing", false),
            Some(&snapshot),
            &session_ids(&snapshot)
        )
        .is_err());
        let mut inactive = snapshot.sessions[0].clone();
        inactive.id = "inactive".to_string();
        snapshot.sessions.push(inactive);
        assert!(validate_command_target(
            &microphone("inactive", true),
            Some(&snapshot),
            &session_ids(&snapshot)
        )
        .is_err());
    }

    #[test]
    fn microphone_start_requires_configuration_and_idle_input_but_stop_can_recover() {
        let mut snapshot = shell();
        let active = snapshot.active_session_id.clone().unwrap();
        snapshot.voice.as_mut().unwrap().speech_input_enabled = false;
        assert!(validate_command_target(
            &microphone(&active, true),
            Some(&snapshot),
            &session_ids(&snapshot)
        )
        .is_err());
        assert!(validate_command_target(
            &microphone(&active, false),
            Some(&snapshot),
            &session_ids(&snapshot)
        )
        .is_ok());
        snapshot.voice.as_mut().unwrap().speech_input_busy = true;
        assert!(validate_command_target(
            &microphone(&active, false),
            Some(&snapshot),
            &session_ids(&snapshot)
        )
        .is_err());
    }

    #[test]
    fn historical_sessions_can_be_targeted_outside_the_visible_window() {
        let snapshot = shell();
        let mut ids = session_ids(&snapshot);
        ids.insert("historical".to_owned());
        let mut command = microphone("historical", true);
        command.kind = "activate-session".to_owned();
        assert!(validate_command_target(&command, Some(&snapshot), &ids).is_ok());
        command.kind = "delete-session".to_owned();
        assert!(validate_command_target(&command, Some(&snapshot), &ids).is_ok());
        assert!(
            validate_command_target(&microphone("historical", true), Some(&snapshot), &ids)
                .unwrap_err()
                .contains("Select this session")
        );
        ids.remove("historical");
        assert!(validate_command_target(&command, Some(&snapshot), &ids).is_err());
        assert!(
            validate_command_target(&microphone("historical", true), Some(&snapshot), &ids)
                .is_err()
        );
    }

    #[test]
    fn stale_snapshots_cannot_restore_removed_session_targets() {
        let state = super::super::FleetControlState::default();
        state.shared.inner.lock().unwrap().state_loaded = true;
        let mut snapshot = shell();
        let ids: Vec<String> = session_ids(&snapshot).into_iter().collect();
        snapshot.captured_at = 20;
        state
            .update_shell_snapshot(snapshot.clone(), ids.clone())
            .unwrap();
        let mut older_ids = ids.clone();
        older_ids.push("removed".to_owned());
        snapshot.captured_at = 19;
        state
            .update_shell_snapshot(snapshot.clone(), older_ids)
            .unwrap();
        assert!(!state
            .shared
            .inner
            .lock()
            .unwrap()
            .known_session_ids
            .contains("removed"));
        snapshot.captured_at = 21;
        let mut new_ids = ids;
        new_ids.push("new-history".to_owned());
        state.update_shell_snapshot(snapshot, new_ids).unwrap();
        assert!(state
            .shared
            .inner
            .lock()
            .unwrap()
            .known_session_ids
            .contains("new-history"));
    }

    #[test]
    fn published_session_ids_are_unique_and_cover_the_visible_window() {
        let snapshot = shell();
        let ids: Vec<String> = session_ids(&snapshot).into_iter().collect();
        assert!(validate_session_ids(ids.clone(), &snapshot).is_ok());
        assert!(validate_session_ids(Vec::new(), &snapshot).is_err());
        let mut duplicate = ids.clone();
        duplicate.push(ids[0].clone());
        assert!(validate_session_ids(duplicate, &snapshot).is_err());
        for invalid in ["".to_owned(), " invalid ".to_owned(), "x".repeat(241)] {
            let mut malformed = ids.clone();
            malformed.push(invalid);
            assert!(validate_session_ids(malformed, &snapshot).is_err());
        }
    }
}
