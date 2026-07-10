use super::{
    config::{
        load_remote_control_config_file, validate_remote_control_port,
        write_remote_control_config_file,
    },
    RemoteControlConfigFile, RemoteControlInner, RemoteControlState, REMOTE_CONTROL_CONFIG_VERSION,
};

impl RemoteControlState {
    pub(super) fn ensure_config_loaded(&self) -> Result<(), String> {
        if self.config_loaded()? {
            return Ok(());
        }

        self.store_loaded_config(load_remote_control_config_file()?)
    }

    pub(super) fn configured_port(&self) -> Result<u16, String> {
        let inner = self
            .shared
            .inner
            .lock()
            .map_err(|_| "Unable to inspect Mission Control settings.".to_string())?;

        validate_remote_control_port(inner.config.port)
    }

    fn config_loaded(&self) -> Result<bool, String> {
        Ok(self
            .shared
            .inner
            .lock()
            .map_err(|_| "Unable to inspect Mission Control settings.".to_string())?
            .config_loaded)
    }

    fn store_loaded_config(&self, config: RemoteControlConfigFile) -> Result<(), String> {
        let mut inner = self
            .shared
            .inner
            .lock()
            .map_err(|_| "Unable to load Mission Control settings.".to_string())?;

        apply_loaded_config(&mut inner, config);

        Ok(())
    }
}

fn apply_loaded_config(inner: &mut RemoteControlInner, config: RemoteControlConfigFile) {
    if inner.config_loaded {
        return;
    }

    inner.pending_commands = config.pending_commands.iter().cloned().collect();
    inner.completed_commands = config.completed_commands.iter().cloned().collect();
    inner.config = config;
    inner.config_loaded = true;
}

pub(super) fn persist_config_locked(inner: &mut RemoteControlInner) -> Result<(), String> {
    inner.config.version = REMOTE_CONTROL_CONFIG_VERSION;
    write_remote_control_config_file(&inner.config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_control::RemoteControlPairedDevice;

    #[test]
    fn apply_loaded_config_sets_config_once() {
        let mut inner = RemoteControlInner::default();
        let first_config = RemoteControlConfigFile {
            port: 43190,
            paired_devices: vec![RemoteControlPairedDevice {
                id: "device-1".to_string(),
                name: "First device".to_string(),
                token_hash: "token-hash".to_string(),
                created_at: 1,
                last_seen_at: 2,
                expires_at: 3,
                user_agent: None,
            }],
            ..RemoteControlConfigFile::default()
        };
        let second_config = RemoteControlConfigFile {
            port: 43191,
            paired_devices: Vec::new(),
            ..RemoteControlConfigFile::default()
        };

        apply_loaded_config(&mut inner, first_config);
        apply_loaded_config(&mut inner, second_config);

        assert!(inner.config_loaded);
        assert_eq!(inner.config.port, 43190);
        assert_eq!(inner.config.paired_devices.len(), 1);
        assert_eq!(inner.config.paired_devices[0].id, "device-1");
    }

    #[test]
    fn persist_config_locked_stamps_current_config_version() {
        let directory = crate::remote_control::test_support::temp_test_directory("persist-config");
        let _env = crate::remote_control::test_support::use_user_config_dir(&directory);
        let mut inner = RemoteControlInner {
            config: RemoteControlConfigFile {
                version: 0,
                ..RemoteControlConfigFile::default()
            },
            ..RemoteControlInner::default()
        };

        persist_config_locked(&mut inner).expect("config should persist");

        assert_eq!(inner.config.version, REMOTE_CONTROL_CONFIG_VERSION);

        let _ = std::fs::remove_dir_all(&directory);
    }
}
