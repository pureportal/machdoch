use std::time::{Duration, Instant};

pub struct Watchdog {
    anchor: Option<(String, Instant)>,
    lease: Option<Instant>,
    absolute: Option<Instant>,
}
impl Watchdog {
    pub fn new() -> Self {
        Self {
            anchor: None,
            lease: None,
            absolute: None,
        }
    }
    pub fn anchor(&mut self, id: String) -> Result<(), String> {
        if id.is_empty() || id.len() > 100 {
            return Err("Invalid lease anchor".to_string());
        }
        self.anchor = Some((id, Instant::now()));
        Ok(())
    }
    pub fn renew(&mut self, id: &str, allowance: u64) -> Result<(), String> {
        if !(1..=60_000).contains(&allowance) {
            return Err("Invalid lease allowance".to_string());
        }
        let (expected, start) = self.anchor.take().ok_or("Lease anchor is missing")?;
        if id != expected {
            return Err("Lease anchor changed".to_string());
        }
        let deadline = start + Duration::from_millis(allowance);
        if deadline <= Instant::now() {
            return Err("Lease has already expired".to_string());
        }
        self.lease = Some(deadline);
        Ok(())
    }
    pub fn start(&mut self, duration: u64) {
        self.absolute = Some(Instant::now() + Duration::from_millis(duration));
    }
    pub fn expired(&self) -> bool {
        let now = Instant::now();
        self.lease.is_some_and(|time| time <= now) || self.absolute.is_some_and(|time| time <= now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lease_extension_uses_request_anchor_and_cannot_reuse_it() {
        let mut watchdog = Watchdog::new();
        watchdog.anchor = Some((
            "request".to_string(),
            Instant::now() - Duration::from_secs(2),
        ));
        assert!(watchdog.renew("request", 1000).is_err());
        assert!(watchdog.renew("request", 60000).is_err());
        watchdog.anchor("next".to_string()).unwrap();
        watchdog.renew("next", 1000).unwrap();
        assert!(!watchdog.expired());
    }
    #[test]
    fn stale_and_oversized_renewals_are_rejected() {
        let mut watchdog = Watchdog::new();
        watchdog.anchor("latest".to_string()).unwrap();
        assert!(watchdog.renew("older", 60000).is_err());
        watchdog.anchor("latest".to_string()).unwrap();
        assert!(watchdog.renew("latest", 60001).is_err());
    }
}
