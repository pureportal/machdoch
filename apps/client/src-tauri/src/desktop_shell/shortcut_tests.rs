use std::cell::RefCell;

use super::sync_shortcut_registration;

#[test]
fn unregister_failure_preserves_shortcut_and_retry_unregisters_first() {
    let mut remembered = Some("old".to_string());
    let operations = RefCell::new(Vec::new());
    let result = sync_shortcut_registration(
        &mut remembered,
        Some("new".to_string()),
        |shortcut| {
            operations
                .borrow_mut()
                .push(format!("unregister:{shortcut}"));
            Err("busy".to_string())
        },
        |_| panic!("replacement must not be registered"),
    );
    assert_eq!(
        result.unwrap_err(),
        "Failed to unregister the previous Quick Voice shortcut `old`: busy"
    );
    let after_failure = remembered.clone();
    sync_shortcut_registration(
        &mut remembered,
        Some("new".to_string()),
        |shortcut| {
            operations
                .borrow_mut()
                .push(format!("unregister:{shortcut}"));
            Ok(())
        },
        |shortcut| {
            operations.borrow_mut().push(format!("register:{shortcut}"));
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(after_failure.as_deref(), Some("old"));
    assert_eq!(remembered.as_deref(), Some("new"));
    assert_eq!(
        *operations.borrow(),
        ["unregister:old", "unregister:old", "register:new"]
    );
}

#[test]
fn failed_replacement_leaves_no_remembered_shortcut_and_can_retry() {
    let mut remembered = Some("old".to_string());
    let operations = RefCell::new(Vec::new());
    let error = sync_shortcut_registration(
        &mut remembered,
        Some("new".to_string()),
        |shortcut| {
            operations
                .borrow_mut()
                .push(format!("unregister:{shortcut}"));
            Ok(())
        },
        |shortcut| {
            operations.borrow_mut().push(format!("register:{shortcut}"));
            Err("taken".to_string())
        },
    )
    .unwrap_err();
    assert_eq!(
        error,
        "Failed to register the Quick Voice shortcut `new`: taken"
    );
    assert_eq!(remembered, None);
    sync_shortcut_registration(
        &mut remembered,
        Some("new".to_string()),
        |_| panic!("nothing remains to unregister"),
        |shortcut| {
            operations.borrow_mut().push(format!("register:{shortcut}"));
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(remembered.as_deref(), Some("new"));
    assert_eq!(
        *operations.borrow(),
        ["unregister:old", "register:new", "register:new"]
    );
}

#[test]
fn shortcut_success_disable_and_unchanged_track_confirmed_operations() {
    let mut remembered = None;
    let operations = RefCell::new(Vec::new());
    for desired in [Some("old"), Some("new"), Some("new"), None, None] {
        sync_shortcut_registration(
            &mut remembered,
            desired.map(str::to_string),
            |shortcut| {
                operations
                    .borrow_mut()
                    .push(format!("unregister:{shortcut}"));
                Ok(())
            },
            |shortcut| {
                operations.borrow_mut().push(format!("register:{shortcut}"));
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(remembered.as_deref(), desired);
    }
    assert_eq!(
        *operations.borrow(),
        [
            "register:old",
            "unregister:old",
            "register:new",
            "unregister:new"
        ]
    );
}
