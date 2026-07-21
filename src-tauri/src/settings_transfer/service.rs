use std::collections::{BTreeMap, BTreeSet};

use tauri::{AppHandle, Emitter as _, Runtime};

use super::{
    categories::{
        create_category_statuses, snapshot_selected, validate_envelope_categories,
        zeroize_envelope, zeroize_snapshots,
    },
    contract::{
        CategorySnapshot, CategoryStatus, SettingsCategoryId, SnapshotAvailability,
        TransferEnvelope, PROTOCOL_MAJOR,
    },
    transaction::{prepare_transaction, PreparedTransaction},
};

/// The one canonical, lock-consistent snapshot collection used by every
/// settings transport. Its drop path scrubs all collected category values.
pub(crate) struct TransferSnapshotSet(
    pub(crate) BTreeMap<SettingsCategoryId, SnapshotAvailability>,
);

impl TransferSnapshotSet {
    pub(crate) fn collect<R: Runtime>(
        app: &AppHandle<R>,
        selected: &BTreeSet<SettingsCategoryId>,
    ) -> Result<Self, String> {
        snapshot_selected(app, selected).map(Self)
    }

    pub(crate) fn statuses(&self, selected: &BTreeSet<SettingsCategoryId>) -> Vec<CategoryStatus> {
        create_category_statuses(selected, &self.0)
    }

    pub(crate) fn item_counts(&self) -> BTreeMap<SettingsCategoryId, u32> {
        self.0
            .iter()
            .map(|(id, snapshot)| {
                (
                    *id,
                    match snapshot {
                        SnapshotAvailability::Available(snapshot) => snapshot.item_count,
                        SnapshotAvailability::Unavailable(_) => 0,
                    },
                )
            })
            .collect()
    }

    /// Removes the selected snapshots that can actually be offered by a
    /// transport. Categories that became unavailable are omitted exactly as
    /// they are from the direct-transfer effective set; an unavailable
    /// category must not abort unrelated complete snapshots.
    pub(crate) fn take_offered(
        &mut self,
        selected: &BTreeSet<SettingsCategoryId>,
    ) -> Result<Vec<CategorySnapshot>, String> {
        let mut categories = Vec::with_capacity(selected.len());
        for id in selected {
            match self.0.remove(id) {
                Some(SnapshotAvailability::Available(snapshot)) => categories.push(snapshot),
                Some(SnapshotAvailability::Unavailable(_)) => {}
                None => {
                    for category in &mut categories {
                        super::categories::zeroize_snapshot(category);
                    }
                    categories.clear();
                    return Err("A selected transfer category was not inspected.".to_string());
                }
            }
        }
        categories.sort_by_key(|category| category.id);
        if let Err(error) = validate_envelope_categories(&categories) {
            for category in &mut categories {
                super::categories::zeroize_snapshot(category);
            }
            categories.clear();
            return Err(error);
        }
        Ok(categories)
    }
}

impl Drop for TransferSnapshotSet {
    fn drop(&mut self) {
        zeroize_snapshots(&mut self.0);
    }
}

/// Owns a plaintext transfer envelope and scrubs it on every exit path.
pub(crate) struct SensitiveTransferEnvelope(pub(crate) TransferEnvelope);

impl SensitiveTransferEnvelope {
    pub(crate) fn into_inner(mut self) -> TransferEnvelope {
        std::mem::replace(
            &mut self.0,
            TransferEnvelope {
                protocol_version: 0,
                transfer_id: String::new(),
                created_at: 0,
                expires_at: 0,
                categories: Vec::new(),
            },
        )
    }
}

impl Drop for SensitiveTransferEnvelope {
    fn drop(&mut self) {
        zeroize_envelope(&mut self.0);
    }
}

pub(crate) fn validate_transfer_envelope(envelope: &TransferEnvelope) -> Result<(), String> {
    if envelope.protocol_version != PROTOCOL_MAJOR
        || envelope.created_at == 0
        || envelope.expires_at <= envelope.created_at
        || envelope.categories.is_empty()
    {
        return Err("The settings payload has invalid transfer metadata.".to_string());
    }
    validate_envelope_categories(&envelope.categories)
}

pub(crate) fn prepare_validated_transaction<R: Runtime>(
    app: AppHandle<R>,
    envelope: TransferEnvelope,
    preview_fingerprint: &str,
) -> Result<PreparedTransaction<R>, String> {
    let envelope = SensitiveTransferEnvelope(envelope);
    validate_transfer_envelope(&envelope.0)?;
    prepare_transaction(app, envelope.into_inner(), preview_fingerprint)
}

pub(crate) fn emit_import_reload_events<R: Runtime>(
    app: &AppHandle<R>,
    categories: &BTreeSet<SettingsCategoryId>,
) {
    const USER_SETTINGS_CHANGED_EVENT: &str = "machdoch://user-settings-changed";
    const DESKTOP_SETTINGS_CHANGED_EVENT: &str = "machdoch://desktop-settings-changed";
    const APPEARANCE_SETTINGS_CHANGED_EVENT: &str = "machdoch://appearance-settings-changed";
    let now_millis = || chrono::Utc::now().timestamp_millis();
    let mut kinds = BTreeSet::new();
    if categories.contains(&SettingsCategoryId::ApiKeys) {
        kinds.insert("provider-keys");
        kinds.insert("web-search");
    }
    if categories.contains(&SettingsCategoryId::AgentProviderPreferences) {
        kinds.extend([
            "web-search",
            "voice",
            "speech-to-text",
            "agent-limits",
            "review-model",
            "provider-enrollment",
        ]);
    }
    if categories.contains(&SettingsCategoryId::GlobalMemory) {
        kinds.insert("memory");
    }
    if categories.contains(&SettingsCategoryId::GlobalMcp) {
        kinds.insert("mcp");
    }
    for kind in kinds {
        let _ = app.emit(
            USER_SETTINGS_CHANGED_EVENT,
            serde_json::json!({ "kind": kind, "updatedAt": now_millis() }),
        );
    }
    if categories.contains(&SettingsCategoryId::DesktopAppearance) {
        if let Ok(settings) = crate::runtime_snapshot::load_user_desktop_settings(app) {
            let _ = app.emit(DESKTOP_SETTINGS_CHANGED_EVENT, settings);
        }
        let _ = app.emit(
            APPEARANCE_SETTINGS_CHANGED_EVENT,
            serde_json::json!({ "originWindowLabel": null, "updatedAt": now_millis() }),
        );
        let _ = crate::desktop_shell::sync_assistant_bubble_window(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_transport_uses_the_complete_canonical_category_catalog() {
        let selected = SettingsCategoryId::ALL.into_iter().collect::<BTreeSet<_>>();
        let statuses = create_category_statuses(&selected, &BTreeMap::new());

        assert_eq!(statuses.len(), SettingsCategoryId::ALL.len());
        assert_eq!(
            statuses
                .iter()
                .map(|status| status.id)
                .collect::<BTreeSet<_>>(),
            selected
        );
        assert!(statuses.iter().all(|status| status.selected));
    }
}
