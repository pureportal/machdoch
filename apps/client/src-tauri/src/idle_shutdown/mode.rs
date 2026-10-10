use serde::Serialize;

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShutdownMode {
    pub(crate) enabled: bool,
    pub(crate) generation: u64,
}

impl ShutdownMode {
    pub(super) fn set_enabled_if_current(
        &mut self,
        enabled: bool,
        expected_generation: u64,
    ) -> Result<bool, String> {
        if self.generation != expected_generation {
            return Ok(false);
        }
        self.set_enabled(enabled)?;
        Ok(true)
    }

    pub(super) fn set_enabled(&mut self, enabled: bool) -> Result<(), String> {
        if self.enabled != enabled {
            self.generation = self
                .generation
                .checked_add(1)
                .ok_or("Shutdown state could not be changed.")?;
            self.enabled = enabled;
        }
        Ok(())
    }

    pub(super) fn matches(&self, generation: u64) -> bool {
        self.enabled && self.generation == generation
    }
}

#[cfg(test)]
mod tests {
    use super::ShutdownMode;

    #[test]
    fn cancelling_and_rearming_rejects_requests_from_the_previous_arm() {
        let mut mode = ShutdownMode::default();
        assert!(!mode.matches(0));
        mode.set_enabled(true).unwrap();
        let first = mode.generation;
        assert!(mode.matches(first));
        mode.set_enabled(false).unwrap();
        assert!(!mode.matches(first));
        mode.set_enabled(true).unwrap();
        assert!(!mode.matches(first));
        assert!(mode.matches(mode.generation));
    }

    #[test]
    fn repeated_updates_preserve_the_current_arm() {
        let mut mode = ShutdownMode::default();
        mode.set_enabled(false).unwrap();
        assert_eq!(mode.generation, 0);
        mode.set_enabled(true).unwrap();
        mode.set_enabled(true).unwrap();
        assert_eq!(mode.generation, 1);
    }

    #[test]
    fn generation_exhaustion_does_not_change_the_setting() {
        let mut mode = ShutdownMode {
            enabled: false,
            generation: u64::MAX,
        };
        assert!(mode.set_enabled(true).is_err());
        assert!(!mode.enabled);
    }

    #[test]
    fn delayed_toggle_requests_cannot_override_a_newer_setting() {
        let mut mode = ShutdownMode::default();
        mode.set_enabled(true).unwrap();
        mode.set_enabled(false).unwrap();
        assert!(!mode.set_enabled_if_current(true, 0).unwrap());
        assert!(!mode.enabled);
        mode.set_enabled(true).unwrap();
        assert!(!mode.set_enabled_if_current(false, 1).unwrap());
        assert!(mode.enabled);
        assert!(mode.set_enabled_if_current(false, 3).unwrap());
        assert!(!mode.enabled);
    }
}
