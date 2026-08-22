use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

static USER_CONFIG_ENV_LOCK: Mutex<()> = Mutex::new(());

pub(super) struct UserConfigEnvGuard {
    previous: Option<OsString>,
    _lock: MutexGuard<'static, ()>,
}

impl Drop for UserConfigEnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var("MACHDOCH_USER_CONFIG_DIR", previous);
        } else {
            std::env::remove_var("MACHDOCH_USER_CONFIG_DIR");
        }
    }
}

pub(super) fn use_user_config_dir(path: &Path) -> UserConfigEnvGuard {
    let lock = USER_CONFIG_ENV_LOCK.lock().expect("user config env lock");
    let previous = std::env::var_os("MACHDOCH_USER_CONFIG_DIR");
    std::env::set_var("MACHDOCH_USER_CONFIG_DIR", path);

    UserConfigEnvGuard {
        previous,
        _lock: lock,
    }
}

pub(super) fn temp_test_directory(name: &str) -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time should be after the Unix epoch")
        .as_nanos();

    std::env::temp_dir().join(format!("machdoch-remote-control-{name}-{unique}"))
}
