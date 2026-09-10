use std::time::{SystemTime, UNIX_EPOCH};

use super::*;

const MANAGER_ID: &str = "manager_MDEyMzQ1Njc4OTAxMjM0NTY3";

#[cfg(unix)]
#[test]
#[cfg_attr(
    target_os = "macos",
    ignore = "Requires case-sensitive temporary storage"
)]
fn removes_obsolete_differently_cased_hard_link() {
    let root = temporary_directory("hard-link");
    fs::create_dir(&root).unwrap();
    synchronize_at(&root, MANAGER_ID, &[prompt("One.prompt.md", "original")]).unwrap();
    let managed = root.join(".fleet-managed").join(MANAGER_ID);
    let original = managed.join("One.prompt.md");
    let destination = managed.join("one.prompt.md");
    assert!(
        !destination.exists(),
        "fixture requires case-sensitive storage"
    );
    fs::hard_link(&original, &destination).unwrap();
    assert_eq!(collect_files(&managed).unwrap().len(), 2);
    let modified = fs::metadata(&destination).unwrap().modified().unwrap();
    for _ in 0..2 {
        synchronize_at(&root, MANAGER_ID, &[prompt("one.prompt.md", "original")]).unwrap();
        assert_eq!(
            collect_files(&managed).unwrap(),
            vec![PathBuf::from("one.prompt.md")]
        );
        assert!(!original.exists());
        assert_eq!(fs::read_to_string(&destination).unwrap(), "original");
        assert_eq!(
            fs::metadata(&destination).unwrap().modified().unwrap(),
            modified
        );
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn case_only_renames_preserve_unchanged_content() {
    assert_case_only_renames("original", false);
}

#[test]
fn case_only_renames_preserve_changed_content() {
    assert_case_only_renames("updated", false);
}

#[cfg(windows)]
#[test]
#[ignore = "Requires fsutil permission to enable case-sensitive disposable directories"]
fn case_sensitive_case_only_renames_preserve_unchanged_content() {
    assert_case_only_renames("original", true);
}

#[cfg(windows)]
#[test]
#[ignore = "Requires fsutil permission to enable case-sensitive disposable directories"]
fn case_sensitive_case_only_renames_preserve_changed_content() {
    assert_case_only_renames("updated", true);
}

fn assert_case_only_renames(content: &str, require_case_sensitive: bool) {
    for (old_name, desired_name) in [
        ("One.prompt.md", "one.prompt.md"),
        ("Reviews/one.prompt.md", "reviews/one.prompt.md"),
        ("Reviews/One.prompt.md", "reviews/one.prompt.md"),
    ] {
        let root = temporary_directory("case-rename");
        fs::create_dir(&root).expect("test root should be created");
        synchronize_at(&root, MANAGER_ID, &[]).expect("manager root should be created");
        let managed = root.join(".fleet-managed").join(MANAGER_ID);
        #[cfg(windows)]
        if require_case_sensitive {
            use std::os::windows::process::CommandExt;

            let output = std::process::Command::new("fsutil.exe")
                .args(["file", "setCaseSensitiveInfo"])
                .arg(&managed)
                .arg("enable")
                .creation_flags(0x08000000)
                .output()
                .expect("fsutil should run");
            assert!(output.status.success(), "case-sensitive setup: {output:?}");
        }
        synchronize_at(&root, MANAGER_ID, &[prompt(old_name, "original")])
            .expect("initial synchronization should succeed");
        let destination = managed.join(desired_name);
        let case_sensitive = !destination.exists();
        if require_case_sensitive {
            assert!(case_sensitive, "fixture must distinguish filename case");
        }
        eprintln!(
            "case_sensitive={case_sensitive}, {old_name} -> {desired_name}, content={content}"
        );
        fs::write(managed.join("obsolete.prompt.md"), "obsolete")
            .expect("obsolete fixture should be written");
        let marker = UNIX_EPOCH + std::time::Duration::from_secs(1_234_567);
        fs::File::options()
            .write(true)
            .open(managed.join(old_name))
            .expect("initial prompt should exist")
            .set_modified(marker)
            .expect("initial modification time should be set");
        let initial_modified = fs::metadata(managed.join(old_name))
            .unwrap()
            .modified()
            .unwrap();
        let desired = [prompt(desired_name, content)];
        synchronize_at(&root, MANAGER_ID, &desired).expect("case-only rename should succeed");
        assert_eq!(
            fs::read_to_string(&destination).expect("desired prompt should remain readable"),
            content
        );
        let listing = collect_files(&managed).expect("listing should be readable");
        assert_eq!(listing.len(), 1, "only the desired prompt should remain");
        if case_sensitive {
            assert_eq!(listing, vec![PathBuf::from(desired_name)]);
            assert!(!managed.join(old_name).exists());
            if old_name.starts_with("Reviews/") {
                assert!(!managed.join("Reviews").exists());
            }
        } else if content == "original" {
            assert_eq!(
                fs::metadata(&destination).unwrap().modified().unwrap(),
                initial_modified
            );
        }
        fs::File::options()
            .write(true)
            .open(&destination)
            .unwrap()
            .set_modified(marker)
            .unwrap();
        let modified = fs::metadata(&destination).unwrap().modified().unwrap();
        synchronize_at(&root, MANAGER_ID, &desired).expect("repeat should succeed");
        assert_eq!(collect_files(&managed).unwrap(), listing);
        assert_eq!(fs::read_to_string(&destination).unwrap(), content);
        assert_eq!(
            fs::metadata(&destination).unwrap().modified().unwrap(),
            modified
        );
        fs::remove_dir_all(root).expect("test directory should be removed");
    }
}

#[test]
fn replaces_content_at_the_same_path() {
    let root = temporary_directory("replacement");
    fs::create_dir(&root).unwrap();
    synchronize_at(&root, MANAGER_ID, &[prompt("one.prompt.md", "original")]).unwrap();
    synchronize_at(&root, MANAGER_ID, &[prompt("one.prompt.md", "updated")]).unwrap();
    assert_eq!(
        fs::read_to_string(
            root.join(".fleet-managed")
                .join(MANAGER_ID)
                .join("one.prompt.md")
        )
        .unwrap(),
        "updated"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn rejects_duplicate_paths_with_distinct_prompt_ids() {
    for duplicate in ["Reviews/One.prompt.md", "reviews/one.prompt.md"] {
        let first = prompt("Reviews/One.prompt.md", "original");
        let mut second = prompt(duplicate, "duplicate");
        second.id = "123e4567-e89b-12d3-a456-426614174001".to_string();
        assert_eq!(
            validate_prompts(&[first, second]).unwrap_err(),
            "Managed prompt paths must be unique."
        );
    }
}

#[test]
fn synchronizes_exact_owned_set_without_changing_local_prompts() {
    let root = temporary_directory("exact");
    fs::create_dir_all(&root).expect("root should be created");
    fs::write(root.join("local.prompt.md"), "local").expect("local prompt should be written");
    synchronize_at(&root, MANAGER_ID, &[prompt("reviews/one.prompt.md", "one")])
        .expect("first synchronization should succeed");
    synchronize_at(&root, MANAGER_ID, &[prompt("two.prompt.md", "two")])
        .expect("second synchronization should succeed");

    assert_eq!(
        fs::read_to_string(root.join("local.prompt.md")).expect("local prompt should remain"),
        "local"
    );
    let managed = root.join(".fleet-managed").join(MANAGER_ID);
    assert!(!managed.join("reviews/one.prompt.md").exists());
    assert_eq!(
        fs::read_to_string(managed.join("two.prompt.md")).expect("managed prompt should exist"),
        "two"
    );
    fs::remove_dir_all(root).expect("test directory should be removed");
}

#[test]
fn rejects_paths_outside_the_managed_root() {
    let root = temporary_directory("traversal");
    fs::create_dir_all(&root).expect("root should be created");
    let result = synchronize_at(&root, MANAGER_ID, &[prompt("../outside.prompt.md", "bad")]);

    assert!(result.is_err());
    assert!(!root
        .parent()
        .expect("root should have a parent")
        .join("outside.prompt.md")
        .exists());
    fs::remove_dir_all(root).expect("test directory should be removed");
}

fn prompt(relative_path: &str, content: &str) -> FleetManagedPrompt {
    FleetManagedPrompt {
        id: "123e4567-e89b-12d3-a456-426614174000".to_string(),
        relative_path: relative_path.to_string(),
        content: content.to_string(),
    }
}

fn temporary_directory(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be valid")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "machdoch-managed-prompts-{label}-{}-{nonce}",
        std::process::id()
    ))
}
