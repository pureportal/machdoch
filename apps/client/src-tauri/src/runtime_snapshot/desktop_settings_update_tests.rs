use std::cell::RefCell;

use super::{save_desktop_settings_with_shortcut, UserDesktopSettings};
use crate::desktop_shell::sync_shortcut_registration;

fn settings(shortcut: &str) -> UserDesktopSettings {
    UserDesktopSettings {
        autostart_enabled: false,
        autostart_minimized: false,
        autostart_to_tray: false,
        always_run_as_administrator: false,
        assistant_bubble_enabled: true,
        assistant_bubble_hide_when_fullscreen: false,
        assistant_bubble_temporarily_hide_seconds: 60,
        ai_context_max_messages: 20,
        chat_idle_timeout_minutes: 10,
        inactive_session_archive_days: 7,
        archived_session_retention_days: 30,
        quick_voice_enabled: true,
        quick_voice_shortcut: shortcut.to_string(),
        quick_voice_silence_seconds: 2.0,
        quick_voice_max_messages: 10,
    }
}

#[derive(Default)]
struct Failures {
    initial_save: bool,
    unregister: bool,
    replacement: bool,
    restore_settings: bool,
    restore_after_write: bool,
    restore_shortcut: bool,
}

struct Harness {
    persisted: RefCell<UserDesktopSettings>,
    remembered: RefCell<Option<String>>,
    actual: RefCell<Option<String>>,
    operations: RefCell<Vec<String>>,
    failures: Failures,
}

impl Harness {
    fn new(failures: Failures) -> Self {
        Self {
            persisted: RefCell::new(settings("old")),
            remembered: RefCell::new(Some("old".to_string())),
            actual: RefCell::new(Some("old".to_string())),
            operations: RefCell::new(Vec::new()),
            failures,
        }
    }

    fn update(&self, requested: &UserDesktopSettings) -> Result<(), String> {
        save_desktop_settings_with_shortcut(
            requested,
            || Ok(self.persisted.borrow().clone()),
            |value| {
                let shortcut = value.quick_voice_shortcut.as_str();
                self.operations
                    .borrow_mut()
                    .push(format!("save:{shortcut}"));
                if self.failures.initial_save && shortcut == "new" {
                    return Err("initial save failed".to_string());
                }
                if self.failures.restore_settings && shortcut == "old" {
                    if self.failures.restore_after_write {
                        *self.persisted.borrow_mut() = value.clone();
                    }
                    return Err("settings recovery failed".to_string());
                }
                *self.persisted.borrow_mut() = value.clone();
                Ok(())
            },
            |value| {
                let shortcut = value.quick_voice_shortcut.as_str();
                self.operations
                    .borrow_mut()
                    .push(format!("sync:{shortcut}"));
                sync_shortcut_registration(
                    &mut self.remembered.borrow_mut(),
                    value.quick_voice_enabled.then(|| shortcut.to_string()),
                    |shortcut| {
                        self.operations
                            .borrow_mut()
                            .push(format!("unregister:{shortcut}"));
                        if self.failures.unregister {
                            return Err("unregister failed".to_string());
                        }
                        assert_eq!(self.actual.borrow().as_deref(), Some(shortcut));
                        *self.actual.borrow_mut() = None;
                        Ok(())
                    },
                    |shortcut| {
                        self.operations
                            .borrow_mut()
                            .push(format!("register:{shortcut}"));
                        if self.failures.replacement && shortcut == "new" {
                            return Err("replacement failed".to_string());
                        }
                        if self.failures.restore_shortcut && shortcut == "old" {
                            return Err("shortcut recovery failed".to_string());
                        }
                        if self.actual.borrow().is_some() {
                            return Err("already registered".to_string());
                        }
                        *self.actual.borrow_mut() = Some(shortcut.to_string());
                        Ok(())
                    },
                )
            },
        )
    }
}

fn check_recovery(restore_settings: bool, restore_after_write: bool, restore_shortcut: bool) {
    let mut harness = Harness::new(Failures {
        replacement: true,
        restore_settings,
        restore_after_write,
        restore_shortcut,
        ..Failures::default()
    });
    let error = harness.update(&settings("new")).unwrap_err();
    let persisted = harness.persisted.borrow().clone();
    let remembered = harness.remembered.borrow().clone();
    let actual = harness.actual.borrow().clone();
    let operations = harness.operations.take();

    harness.failures = Failures::default();
    harness.update(&settings("new")).unwrap();
    assert_eq!(harness.remembered.borrow().as_deref(), Some("new"));
    assert_eq!(harness.actual.borrow().as_deref(), Some("new"));
    assert_eq!(
        serde_json::to_value(&*harness.persisted.borrow()).unwrap(),
        serde_json::to_value(settings("new")).unwrap()
    );

    let expected_persisted = if restore_settings && !restore_after_write {
        "new"
    } else {
        "old"
    };
    assert_eq!(
        serde_json::to_value(persisted).unwrap(),
        serde_json::to_value(settings(expected_persisted)).unwrap()
    );
    let expected_shortcut = if restore_shortcut { None } else { Some("old") };
    assert_eq!(remembered.as_deref(), expected_shortcut);
    assert_eq!(actual.as_deref(), expected_shortcut);
    assert_eq!(
        operations,
        [
            "save:new",
            "sync:new",
            "unregister:old",
            "register:new",
            "save:old",
            "sync:old",
            "register:old"
        ]
    );
    let expected_retry = if restore_shortcut {
        vec!["save:new", "sync:new", "register:new"]
    } else {
        vec!["save:new", "sync:new", "unregister:old", "register:new"]
    };
    assert_eq!(*harness.operations.borrow(), expected_retry);
    let settings_outcome = if restore_settings {
        "Desktop settings recovery failed: settings recovery failed."
    } else {
        "Desktop settings were restored."
    };
    let shortcut_outcome = if restore_shortcut {
        "Quick Voice shortcut recovery failed: Failed to register the Quick Voice shortcut `old`: shortcut recovery failed."
    } else {
        "The previous Quick Voice shortcut was restored."
    };
    let retry = if restore_settings || restore_shortcut {
        " Retry saving the desktop settings."
    } else {
        ""
    };
    assert_eq!(error, format!("The Quick Voice shortcut could not be updated: Failed to register the Quick Voice shortcut `new`: replacement failed. {settings_outcome} {shortcut_outcome}{retry}"));
}

#[test]
fn shortcut_replacement_failure_restores_settings_and_registration() {
    check_recovery(false, false, false);
}

#[test]
fn shortcut_settings_recovery_failure_still_restores_previous_registration() {
    check_recovery(true, false, false);
}

#[test]
fn shortcut_settings_recovery_failure_after_write_is_reported() {
    check_recovery(true, true, false);
}

#[test]
fn shortcut_registration_recovery_failure_is_reported() {
    check_recovery(false, false, true);
}

#[test]
fn shortcut_simultaneous_recovery_failures_are_both_reported() {
    check_recovery(true, false, true);
}

#[test]
fn shortcut_unregister_failure_preserves_registration_through_recovery_and_retry() {
    let mut harness = Harness::new(Failures {
        unregister: true,
        ..Failures::default()
    });
    let error = harness.update(&settings("new")).unwrap_err();
    let remembered = harness.remembered.borrow().clone();
    let operations = harness.operations.take();
    harness.failures = Failures::default();
    let retry = harness.update(&settings("new"));
    assert_eq!(remembered.as_deref(), Some("old"));
    assert_eq!(
        operations,
        [
            "save:new",
            "sync:new",
            "unregister:old",
            "save:old",
            "sync:old"
        ]
    );
    assert_eq!(error, "The Quick Voice shortcut could not be updated: Failed to unregister the previous Quick Voice shortcut `old`: unregister failed. Desktop settings were restored. The previous Quick Voice shortcut was restored.");
    retry.unwrap();
    assert_eq!(
        *harness.operations.borrow(),
        ["save:new", "sync:new", "unregister:old", "register:new"]
    );
    assert_eq!(harness.actual.borrow().as_deref(), Some("new"));
    assert_eq!(harness.remembered.borrow().as_deref(), Some("new"));
}

#[test]
fn shortcut_initial_persistence_failure_does_not_touch_registration() {
    let harness = Harness::new(Failures {
        initial_save: true,
        ..Failures::default()
    });
    assert_eq!(
        harness.update(&settings("new")).unwrap_err(),
        "initial save failed"
    );
    assert_eq!(*harness.operations.borrow(), ["save:new"]);
    assert_eq!(harness.persisted.borrow().quick_voice_shortcut, "old");
    assert_eq!(harness.actual.borrow().as_deref(), Some("old"));
    assert_eq!(harness.remembered.borrow().as_deref(), Some("old"));
}

#[test]
fn shortcut_update_and_disable_succeed() {
    let harness = Harness::new(Failures::default());
    harness.update(&settings("new")).unwrap();
    assert_eq!(harness.remembered.borrow().as_deref(), Some("new"));
    let mut disabled = settings("new");
    disabled.quick_voice_enabled = false;
    harness.update(&disabled).unwrap();
    assert_eq!(*harness.remembered.borrow(), None);
    assert_eq!(*harness.actual.borrow(), None);
    assert!(!harness.persisted.borrow().quick_voice_enabled);
    assert_eq!(
        *harness.operations.borrow(),
        [
            "save:new",
            "sync:new",
            "unregister:old",
            "register:new",
            "save:new",
            "sync:new",
            "unregister:new"
        ]
    );
}
