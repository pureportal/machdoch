use super::MediaErrorCode;

pub(super) fn recovery(
    operation: &str,
    diagnostic: &str,
) -> Option<(MediaErrorCode, &'static str)> {
    if operation != "media_refmod_operation" {
        return None;
    }
    if diagnostic.starts_with("install a minimax h3 audio or video vae") {
        return Some((
            MediaErrorCode::ModelNotInstalled,
            "Install a MiniMax H3 audio or video VAE to create or preview references.",
        ));
    }
    if diagnostic.contains("h3 video") && diagnostic.contains("free gpu memory for weights") {
        return Some((
            MediaErrorCode::Oom,
            "The MiniMax H3 VAE needs more free GPU memory. Close GPU applications or use a GPU with more memory.",
        ));
    }
    let modality = if diagnostic.contains("h3 video vae") {
        "video"
    } else if diagnostic.contains("h3 audio vae") {
        "audio"
    } else if diagnostic.contains("safetensorerror:") {
        return Some((
            MediaErrorCode::InvalidRequest,
            "The RefMod file cannot be read. Choose another reference file.",
        ));
    } else {
        return None;
    };
    if diagnostic.contains(&format!("install the minimax h3 {modality} vae")) {
        return Some((
            MediaErrorCode::ModelNotInstalled,
            if modality == "video" {
                "Install the MiniMax H3 video VAE to create or preview visual references."
            } else {
                "Install the MiniMax H3 audio VAE to create or preview audio references."
            },
        ));
    }
    if !["incomplete", "damaged", "missing", "incompatible"]
        .iter()
        .any(|word| diagnostic.contains(word))
        && !(diagnostic.contains("complete") && diagnostic.contains("checkpoint"))
    {
        return None;
    }
    Some((
        MediaErrorCode::ModelNotInstalled,
        if modality == "video" {
            "MiniMax H3 video VAE is incomplete or damaged. Install a complete video checkpoint."
        } else {
            "MiniMax H3 audio VAE is incomplete or damaged. Install a complete audio checkpoint."
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::super::{MediaError, MediaErrorCode, MediaErrorRetryability};

    #[test]
    fn damaged_refmod_vaes_preserve_recovery_without_exposing_worker_paths() {
        for modality in ["video", "audio"] {
            let error = MediaError::from_internal(
                "media_refmod_operation",
                format!("Local Diffusers worker failed: ValueError: MiniMax H3 {modality} VAE is incomplete or damaged. Replace D:\\private\\checkpoint.safetensors with a complete checkpoint."),
            );
            assert_eq!(error.code, MediaErrorCode::ModelNotInstalled);
            assert_eq!(error.retryability, MediaErrorRetryability::AfterUserAction);
            assert!(error
                .message
                .contains(&format!("complete {modality} checkpoint")));
            assert!(!error.message.contains("private"));
            assert!(!error.message.contains("ValueError"));
            assert_eq!(error.suggested_actions[0].id, "open-models");
        }
    }

    #[test]
    fn missing_refmod_vaes_offer_installation_before_retry() {
        let error = MediaError::from_internal(
            "media_refmod_operation",
            "Install a MiniMax H3 audio or video VAE under D:\\private\\models\\minimax-h3-ref2va\\vae",
        );
        assert_eq!(error.code, MediaErrorCode::ModelNotInstalled);
        assert_eq!(error.retryability, MediaErrorRetryability::AfterUserAction);
        assert!(error.message.contains("create or preview references"));
        assert!(!error.message.contains("private"));
    }

    #[test]
    fn refmod_vae_memory_preflight_offers_capacity_recovery() {
        let error = MediaError::from_internal(
            "media_refmod_operation",
            "Local Diffusers worker failed: ValueError: H3 video decoder needs at least 9.0 GiB of free GPU memory for weights. Close GPU applications or use a GPU with more memory.",
        );
        assert_eq!(error.code, MediaErrorCode::Oom);
        assert_eq!(error.retryability, MediaErrorRetryability::AfterUserAction);
        assert!(error.message.contains("Close GPU applications"));
        assert!(!error.message.contains("checkpoint"));
    }

    #[test]
    fn missing_refmod_modality_does_not_report_an_internal_error() {
        for modality in ["video", "audio"] {
            let error = MediaError::from_internal(
                "media_refmod_operation",
                format!("Local Diffusers worker failed: ValueError: Install the MiniMax H3 {modality} VAE at D:\\private\\checkpoint.safetensors"),
            );
            assert_eq!(error.code, MediaErrorCode::ModelNotInstalled);
            assert_eq!(error.retryability, MediaErrorRetryability::AfterUserAction);
            assert!(error.message.contains(&format!("H3 {modality} VAE")));
            assert!(!error.message.contains("damaged"));
            assert!(!error.message.contains("private"));
        }
    }

    #[test]
    fn unreadable_refmod_files_require_another_input_without_exposing_diagnostics() {
        for failure in [
            "header too large",
            "invalid header length",
            "incomplete metadata",
        ] {
            let error = MediaError::from_internal(
                "media_refmod_operation",
                format!("Local Diffusers worker failed: SafetensorError: Error while deserializing header: {failure} D:\\private\\reference.safetensors"),
            );
            assert_eq!(error.code, MediaErrorCode::InvalidRequest);
            assert_eq!(error.retryability, MediaErrorRetryability::AfterUserAction);
            assert_eq!(
                error.message,
                "The RefMod file cannot be read. Choose another reference file."
            );
            assert!(!error.message.contains("private"));
            assert!(!error.message.contains("SafetensorError"));
            assert!(error.technical_diagnostic.contains(failure));
        }
    }

    #[test]
    fn refmod_file_errors_do_not_replace_model_recovery_or_other_operations() {
        let diagnostic =
            "MiniMax H3 video VAE is incomplete or damaged: SafetensorError: invalid header length";
        let error = MediaError::from_internal("media_refmod_operation", diagnostic);
        assert_eq!(error.code, MediaErrorCode::ModelNotInstalled);
        assert!(super::recovery(
            "media_generate_video",
            "safetensorerror: invalid header length"
        )
        .is_none());
    }

    #[test]
    fn refmod_recovery_keeps_cancellation_and_other_operations_distinct() {
        let canceled =
            MediaError::from_internal("media_refmod_operation", "RefMod operation was canceled");
        assert_eq!(canceled.code, MediaErrorCode::CancelledByUser);
        assert_eq!(canceled.retryability, MediaErrorRetryability::Never);
        assert!(super::recovery(
            "media_generate_image",
            "minimax h3 video vae is incomplete or damaged"
        )
        .is_none());
    }
}
