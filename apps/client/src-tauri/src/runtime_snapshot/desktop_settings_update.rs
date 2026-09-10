use super::UserDesktopSettings;

pub(super) fn save_desktop_settings_with_shortcut(
    settings: &UserDesktopSettings,
    mut load: impl FnMut() -> Result<UserDesktopSettings, String>,
    mut save: impl FnMut(&UserDesktopSettings) -> Result<(), String>,
    mut sync: impl FnMut(&UserDesktopSettings) -> Result<(), String>,
) -> Result<(), String> {
    let previous_settings = load()?;
    save(settings)?;

    if let Err(error) = load().and_then(|settings| sync(&settings)) {
        let settings_recovery = save(&previous_settings);
        let shortcut_recovery = sync(&previous_settings);
        let incomplete = settings_recovery.is_err() || shortcut_recovery.is_err();
        let settings_outcome = match settings_recovery {
            Ok(()) => "Desktop settings were restored.".to_string(),
            Err(error) => format!("Desktop settings recovery failed: {error}."),
        };
        let shortcut_outcome = match shortcut_recovery {
            Ok(()) => "The previous Quick Voice shortcut was restored.".to_string(),
            Err(error) => format!("Quick Voice shortcut recovery failed: {error}."),
        };
        let retry = if incomplete {
            " Retry saving the desktop settings."
        } else {
            ""
        };
        return Err(format!(
            "The Quick Voice shortcut could not be updated: {error}. {settings_outcome} {shortcut_outcome}{retry}"
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "desktop_settings_update_tests.rs"]
mod tests;
