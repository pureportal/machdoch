const TASK_ID_COMMANDS: &[&str] = &["cancel", "retry", "continue"];

const SESSION_ID_COMMANDS: &[&str] = &[
    "activate-session",
    "archive-session",
    "pin-session",
    "duplicate-session",
    "branch-session",
    "delete-session",
    "rename-session",
    "tag-session",
    "clear-session-history",
    "update-draft",
    "set-session-model",
    "set-session-mode",
    "set-session-reasoning",
    "set-session-memory",
    "set-global-memory",
    "set-ui-control",
    "remove-attachment",
    "clear-attachments",
    "apply-context-pack",
    "save-message-context-pack",
    "speak-message",
];

const SESSION_MUTATION_COMMANDS: &[&str] = &[
    "follow-up",
    "create-session",
    "stop-speaking",
    "delete-context-pack",
];

const ENABLED_COMMANDS: &[&str] = &["set-session-memory", "set-global-memory", "set-ui-control"];

const CONTEXT_PACK_ID_COMMANDS: &[&str] = &["apply-context-pack", "delete-context-pack"];
const MESSAGE_ID_COMMANDS: &[&str] = &["save-message-context-pack", "speak-message"];

const JOB_ID_COMMANDS: &[&str] = &[
    "scheduler-trigger",
    "scheduler-pause",
    "scheduler-resume",
    "scheduler-delete",
];

const RUN_ID_COMMANDS: &[&str] = &["scheduler-retry-run", "scheduler-cancel-run"];

const SUPPORTED_REASONING_MODES: &[&str] = &[
    "default", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
];

const SUPPORTED_COMMAND_GROUPS: &[&[&str]] = &[
    TASK_ID_COMMANDS,
    SESSION_ID_COMMANDS,
    SESSION_MUTATION_COMMANDS,
    JOB_ID_COMMANDS,
    RUN_ID_COMMANDS,
];

#[derive(Debug, PartialEq, Eq)]
pub(super) struct CommandRequirements {
    pub(super) task_id: bool,
    pub(super) session_id: bool,
    pub(super) enabled: bool,
    pub(super) context_pack_id: bool,
    pub(super) message_id: bool,
    pub(super) job_id: bool,
    pub(super) run_id: bool,
}

pub(super) fn is_supported_command(kind: &str) -> bool {
    SUPPORTED_COMMAND_GROUPS
        .iter()
        .any(|commands| includes_command(commands, kind))
}

pub(super) fn command_requirements(kind: &str) -> CommandRequirements {
    CommandRequirements {
        task_id: requires_task_id(kind),
        session_id: requires_session_id(kind),
        enabled: requires_enabled(kind),
        context_pack_id: requires_context_pack_id(kind),
        message_id: requires_message_id(kind),
        job_id: requires_job_id(kind),
        run_id: requires_run_id(kind),
    }
}

pub(super) fn is_supported_reasoning(value: Option<&str>) -> bool {
    matches!(value, Some(value) if SUPPORTED_REASONING_MODES.contains(&value))
}

pub(super) fn supported_reasoning_modes_label() -> String {
    SUPPORTED_REASONING_MODES.join(", ")
}

fn requires_task_id(kind: &str) -> bool {
    includes_command(TASK_ID_COMMANDS, kind)
}

fn requires_session_id(kind: &str) -> bool {
    includes_command(SESSION_ID_COMMANDS, kind)
}

fn requires_enabled(kind: &str) -> bool {
    includes_command(ENABLED_COMMANDS, kind)
}

fn requires_context_pack_id(kind: &str) -> bool {
    includes_command(CONTEXT_PACK_ID_COMMANDS, kind)
}

fn requires_message_id(kind: &str) -> bool {
    includes_command(MESSAGE_ID_COMMANDS, kind)
}

fn requires_job_id(kind: &str) -> bool {
    includes_command(JOB_ID_COMMANDS, kind)
}

fn requires_run_id(kind: &str) -> bool {
    includes_command(RUN_ID_COMMANDS, kind)
}

fn includes_command(commands: &[&str], kind: &str) -> bool {
    commands.contains(&kind)
}

#[cfg(test)]
mod tests {
    use super::{
        command_requirements, is_supported_command, is_supported_reasoning,
        requires_context_pack_id, requires_enabled, requires_job_id, requires_message_id,
        requires_run_id, requires_session_id, requires_task_id, supported_reasoning_modes_label,
        CommandRequirements, CONTEXT_PACK_ID_COMMANDS, JOB_ID_COMMANDS, MESSAGE_ID_COMMANDS,
        RUN_ID_COMMANDS,
    };

    #[test]
    fn supported_command_groups_cover_remote_command_targets() {
        assert!(is_supported_command("cancel"));
        assert!(is_supported_command("update-draft"));
        assert!(is_supported_command("set-session-reasoning"));
        assert!(is_supported_command("follow-up"));
        assert!(is_supported_command("scheduler-trigger"));
        assert!(is_supported_command("scheduler-cancel-run"));
        assert!(!is_supported_command("approval-decision"));
    }

    #[test]
    fn required_identifier_predicates_match_command_groups() {
        assert!(requires_task_id("cancel"));
        assert!(requires_session_id("rename-session"));
        assert!(requires_session_id("set-session-reasoning"));
        assert!(requires_context_pack_id("delete-context-pack"));
        assert!(requires_message_id("speak-message"));
        assert!(requires_job_id("scheduler-pause"));
        assert!(requires_run_id("scheduler-retry-run"));

        assert!(!requires_task_id("follow-up"));
        assert!(!requires_session_id("create-session"));
        assert!(!requires_job_id("scheduler-retry-run"));
    }

    #[test]
    fn command_requirements_aggregate_required_fields() {
        assert_eq!(
            command_requirements("speak-message"),
            CommandRequirements {
                task_id: false,
                session_id: true,
                enabled: false,
                context_pack_id: false,
                message_id: true,
                job_id: false,
                run_id: false,
            }
        );
    }

    #[test]
    fn commands_with_required_secondary_targets_are_supported() {
        for kind in CONTEXT_PACK_ID_COMMANDS
            .iter()
            .chain(MESSAGE_ID_COMMANDS)
            .chain(JOB_ID_COMMANDS)
            .chain(RUN_ID_COMMANDS)
        {
            assert!(is_supported_command(kind), "{kind} should be supported");
        }
    }

    #[test]
    fn enabled_value_is_required_only_for_toggle_commands() {
        assert!(requires_enabled("set-session-memory"));
        assert!(requires_enabled("set-global-memory"));
        assert!(requires_enabled("set-ui-control"));
        assert!(!requires_enabled("set-session-mode"));
        assert!(!requires_enabled("set-session-reasoning"));
    }

    #[test]
    fn supported_reasoning_modes_match_remote_command_validation() {
        assert!(is_supported_reasoning(Some("default")));
        assert!(is_supported_reasoning(Some("xhigh")));
        assert!(is_supported_reasoning(Some("ultra")));
        assert!(!is_supported_reasoning(None));
        assert!(!is_supported_reasoning(Some("maximum")));
        assert_eq!(
            supported_reasoning_modes_label(),
            "default, none, minimal, low, medium, high, xhigh, max, ultra"
        );
    }
}
