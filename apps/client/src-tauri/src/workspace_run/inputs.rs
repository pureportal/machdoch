use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use super::model::{RunConfiguration, RunConfigurationDocument};

const MAX_INPUTS: usize = 64;
const MAX_INPUT_ID_CHARS: usize = 64;
const MAX_INPUT_OPTIONS: usize = 64;
const MAX_INPUT_LABEL_CHARS: usize = 120;
const MAX_INPUT_DESCRIPTION_CHARS: usize = 500;
const MAX_INPUT_VALUE_CHARS: usize = 1_024;
const INPUT_REFERENCE_PREFIX: &str = "${input:";

pub type RunInputValues = BTreeMap<String, RunInputValue>;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RunInput {
    Select {
        id: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        options: Vec<RunInputOption>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default: Option<String>,
    },
    Text {
        id: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default)]
        default: String,
        #[serde(default)]
        required: bool,
    },
    Boolean {
        id: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default)]
        default: bool,
        #[serde(default = "default_true_value")]
        true_value: String,
        #[serde(default = "default_false_value")]
        false_value: String,
    },
}

fn default_true_value() -> String {
    "true".to_string()
}

fn default_false_value() -> String {
    "false".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunInputOption {
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum RunInputValue {
    Boolean(bool),
    Text(String),
}

impl RunInput {
    pub fn id(&self) -> &str {
        match self {
            Self::Select { id, .. } | Self::Text { id, .. } | Self::Boolean { id, .. } => id,
        }
    }

    fn label(&self) -> &str {
        match self {
            Self::Select { label, .. } | Self::Text { label, .. } | Self::Boolean { label, .. } => {
                label
            }
        }
    }

    fn description(&self) -> Option<&str> {
        match self {
            Self::Select { description, .. }
            | Self::Text { description, .. }
            | Self::Boolean { description, .. } => description.as_deref(),
        }
    }

    fn default_value(&self) -> RunInputValue {
        match self {
            Self::Select {
                options, default, ..
            } => RunInputValue::Text(
                default
                    .clone()
                    .or_else(|| options.first().map(|option| option.value.clone()))
                    .unwrap_or_default(),
            ),
            Self::Text { default, .. } => RunInputValue::Text(default.clone()),
            Self::Boolean { default, .. } => RunInputValue::Boolean(*default),
        }
    }

    fn argument(&self, value: &RunInputValue) -> String {
        match (self, value) {
            (
                Self::Boolean {
                    true_value,
                    false_value,
                    ..
                },
                RunInputValue::Boolean(enabled),
            ) => {
                if *enabled {
                    true_value.clone()
                } else {
                    false_value.clone()
                }
            }
            (_, RunInputValue::Text(text)) => text.clone(),
            (_, RunInputValue::Boolean(enabled)) => enabled.to_string(),
        }
    }

    fn validate_value(&self, value: &RunInputValue) -> Result<(), String> {
        let label = self.label();
        match (self, value) {
            (Self::Select { options, .. }, RunInputValue::Text(text)) => {
                if options.iter().any(|option| &option.value == text) {
                    Ok(())
                } else {
                    Err(format!("Choose one of the options for `{label}`."))
                }
            }
            (Self::Text { required, .. }, RunInputValue::Text(text)) => {
                if !is_single_line_value(text) {
                    return Err(format!(
                        "`{label}` must be a single line of at most {MAX_INPUT_VALUE_CHARS} characters."
                    ));
                }
                if *required && text.trim().is_empty() {
                    return Err(format!("`{label}` is required."));
                }
                Ok(())
            }
            (Self::Boolean { .. }, RunInputValue::Boolean(_)) => Ok(()),
            (Self::Boolean { .. }, RunInputValue::Text(_)) => {
                Err(format!("`{label}` must be true or false."))
            }
            (_, RunInputValue::Boolean(_)) => Err(format!("`{label}` must be text.")),
        }
    }
}

fn is_single_line_value(value: &str) -> bool {
    value.chars().count() <= MAX_INPUT_VALUE_CHARS && !value.chars().any(char::is_control)
}

fn is_valid_input_id(value: &str) -> bool {
    let mut characters = value.chars();
    characters
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && value.len() <= MAX_INPUT_ID_CHARS
        && characters
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn validate_label(context: &str, label: &str) -> Result<(), String> {
    if label.trim().is_empty()
        || label.trim() != label
        || label.chars().count() > MAX_INPUT_LABEL_CHARS
        || label.chars().any(char::is_control)
    {
        return Err(format!(
            "{context} needs a label of 1 to {MAX_INPUT_LABEL_CHARS} characters."
        ));
    }
    Ok(())
}

pub fn input_references(text: &str) -> Result<Vec<&str>, String> {
    let mut references = Vec::new();
    let mut remaining = text;
    while let Some(start) = remaining.find(INPUT_REFERENCE_PREFIX) {
        let reference = &remaining[start + INPUT_REFERENCE_PREFIX.len()..];
        let end = reference
            .find('}')
            .ok_or_else(|| "A run input reference is missing its closing `}`.".to_string())?;
        let id = &reference[..end];
        if !is_valid_input_id(id) {
            return Err(format!("Run input reference `${{input:{id}}}` is invalid."));
        }
        references.push(id);
        remaining = &reference[end + 1..];
    }
    Ok(references)
}

fn substitute_inputs(text: &str, arguments: &BTreeMap<&str, String>) -> String {
    let mut resolved = String::with_capacity(text.len());
    let mut remaining = text;
    while let Some(start) = remaining.find(INPUT_REFERENCE_PREFIX) {
        let reference = &remaining[start + INPUT_REFERENCE_PREFIX.len()..];
        let Some(end) = reference.find('}') else {
            break;
        };
        resolved.push_str(&remaining[..start]);
        match arguments.get(&reference[..end]) {
            Some(argument) => resolved.push_str(argument),
            None => {
                resolved.push_str(&remaining[start..start + INPUT_REFERENCE_PREFIX.len() + end + 1])
            }
        }
        remaining = &reference[end + 1..];
    }
    resolved.push_str(remaining);
    resolved
}

pub fn task_input_ids(configuration: &RunConfiguration) -> Result<Vec<String>, String> {
    let RunConfiguration::Task {
        command,
        environment,
        ..
    } = configuration
    else {
        return Ok(Vec::new());
    };
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for text in std::iter::once(command).chain(environment.values()) {
        for id in input_references(text)? {
            if seen.insert(id) {
                ids.push(id.to_string());
            }
        }
    }
    Ok(ids)
}

pub(super) fn validate_inputs(inputs: &[RunInput]) -> Result<(), String> {
    if inputs.len() > MAX_INPUTS {
        return Err(format!(
            "A workspace can define at most {MAX_INPUTS} run inputs."
        ));
    }
    let mut ids = HashSet::new();
    for input in inputs {
        let id = input.id();
        if !is_valid_input_id(id) {
            return Err(format!("Run input id `{id}` is invalid."));
        }
        if !ids.insert(id) {
            return Err(format!("Run input id `{id}` is duplicated."));
        }
        validate_label(&format!("Run input `{id}`"), input.label())?;
        if input.description().is_some_and(|description| {
            description.chars().count() > MAX_INPUT_DESCRIPTION_CHARS
                || description.chars().any(char::is_control)
        }) {
            return Err(format!(
                "Run input `{id}` has a description longer than {MAX_INPUT_DESCRIPTION_CHARS} characters."
            ));
        }
        match input {
            RunInput::Select {
                options, default, ..
            } => {
                if options.is_empty() || options.len() > MAX_INPUT_OPTIONS {
                    return Err(format!(
                        "Run input `{id}` needs between 1 and {MAX_INPUT_OPTIONS} options."
                    ));
                }
                let mut values = HashSet::new();
                for option in options {
                    if !is_single_line_value(&option.value) {
                        return Err(format!("Run input `{id}` has an invalid option value."));
                    }
                    if !values.insert(option.value.as_str()) {
                        return Err(format!(
                            "Run input `{id}` repeats the option `{}`.",
                            option.value
                        ));
                    }
                    if let Some(label) = &option.label {
                        validate_label(&format!("An option of run input `{id}`"), label)?;
                    }
                }
                if default
                    .as_ref()
                    .is_some_and(|default| !values.contains(default.as_str()))
                {
                    return Err(format!(
                        "The default of run input `{id}` must be one of its options."
                    ));
                }
            }
            RunInput::Text { default, .. } => {
                if !is_single_line_value(default) {
                    return Err(format!("Run input `{id}` has an invalid default."));
                }
            }
            RunInput::Boolean {
                true_value,
                false_value,
                ..
            } => {
                if !is_single_line_value(true_value) || !is_single_line_value(false_value) {
                    return Err(format!(
                        "Run input `{id}` has an invalid trueValue or falseValue."
                    ));
                }
            }
        }
    }
    Ok(())
}

pub(super) fn validate_input_references(document: &RunConfigurationDocument) -> Result<(), String> {
    let ids = document
        .inputs
        .iter()
        .map(RunInput::id)
        .collect::<HashSet<_>>();
    for configuration in &document.configurations {
        for id in task_input_ids(configuration)
            .map_err(|error| format!("Run configuration `{}`: {error}", configuration.id()))?
        {
            if !ids.contains(id.as_str()) {
                return Err(format!(
                    "Run configuration `{}` references the undefined input `{id}`.",
                    configuration.id()
                ));
            }
        }
    }
    Ok(())
}

pub(super) fn resolve_input_values(
    inputs: &[RunInput],
    input_ids: &[String],
    provided: &RunInputValues,
) -> Result<RunInputValues, String> {
    if let Some(unknown) = provided
        .keys()
        .find(|key| !inputs.iter().any(|input| input.id() == key.as_str()))
    {
        return Err(format!("Run input `{unknown}` does not exist."));
    }
    input_ids
        .iter()
        .map(|id| {
            let input = inputs
                .iter()
                .find(|input| input.id() == id)
                .ok_or_else(|| format!("Run input `{id}` does not exist."))?;
            let value = provided
                .get(id)
                .cloned()
                .unwrap_or_else(|| input.default_value());
            input.validate_value(&value)?;
            Ok((id.clone(), value))
        })
        .collect()
}

pub(super) fn resolve_task_configuration(
    configuration: &RunConfiguration,
    inputs: &[RunInput],
    values: &RunInputValues,
) -> Result<RunConfiguration, String> {
    let arguments = inputs
        .iter()
        .filter_map(|input| {
            values
                .get(input.id())
                .map(|value| (input.id(), input.argument(value)))
        })
        .collect::<BTreeMap<_, _>>();
    let mut resolved = configuration.clone();
    if let RunConfiguration::Task {
        id,
        command,
        environment,
        ..
    } = &mut resolved
    {
        *command = substitute_inputs(command, &arguments);
        if command.trim().is_empty() {
            return Err(format!(
                "Run configuration `{id}` resolves to an empty command."
            ));
        }
        for value in environment.values_mut() {
            *value = substitute_inputs(value, &arguments);
        }
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_run::model::{RunRestartPolicy, RunType, RUN_SCHEMA_VERSION};

    fn task(command: &str, environment: &[(&str, &str)]) -> RunConfiguration {
        RunConfiguration::Task {
            id: "write-env".to_string(),
            name: "Write env".to_string(),
            primary: true,
            run_type: RunType::Job,
            group: None,
            command: command.to_string(),
            working_directory: ".".to_string(),
            environment: environment
                .iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
            hot_reload: false,
            ports: Vec::new(),
            urls: Vec::new(),
            health_check: None,
            restart_policy: RunRestartPolicy::default(),
        }
    }

    fn inputs() -> Vec<RunInput> {
        vec![
            RunInput::Select {
                id: "env".to_string(),
                label: "Environment".to_string(),
                description: None,
                options: vec![
                    RunInputOption {
                        value: "dev".to_string(),
                        label: Some("Development".to_string()),
                    },
                    RunInputOption {
                        value: "prod".to_string(),
                        label: None,
                    },
                ],
                default: None,
            },
            RunInput::Boolean {
                id: "dryRun".to_string(),
                label: "Dry run".to_string(),
                description: None,
                default: true,
                true_value: "--dry-run".to_string(),
                false_value: String::new(),
            },
            RunInput::Text {
                id: "repos".to_string(),
                label: "Repositories".to_string(),
                description: None,
                default: String::new(),
                required: false,
            },
        ]
    }

    fn values(entries: &[(&str, RunInputValue)]) -> RunInputValues {
        entries
            .iter()
            .map(|(key, value)| (key.to_string(), value.clone()))
            .collect()
    }

    #[test]
    fn extracts_ordered_unique_references_from_commands_and_environment() {
        let configuration = task(
            "sync --env ${input:env} ${input:dryRun} --env-again ${input:env}",
            &[("REPOS", "${input:repos}")],
        );

        assert_eq!(
            task_input_ids(&configuration).unwrap(),
            vec!["env", "dryRun", "repos"]
        );
        assert!(input_references("run ${input:env").is_err());
        assert!(input_references("run ${input:bad id}").is_err());
    }

    #[test]
    fn resolves_defaults_and_substitutes_arguments() {
        let configuration = task(
            "sync --env ${input:env} ${input:dryRun} --repos=${input:repos}",
            &[("TARGET", "${input:env}")],
        );
        let ids = task_input_ids(&configuration).unwrap();

        let defaults = resolve_input_values(&inputs(), &ids, &RunInputValues::new()).unwrap();
        assert_eq!(
            defaults,
            values(&[
                ("env", RunInputValue::Text("dev".to_string())),
                ("dryRun", RunInputValue::Boolean(true)),
                ("repos", RunInputValue::Text(String::new())),
            ])
        );

        let chosen = resolve_input_values(
            &inputs(),
            &ids,
            &values(&[
                ("env", RunInputValue::Text("prod".to_string())),
                ("dryRun", RunInputValue::Boolean(false)),
                ("repos", RunInputValue::Text("api,app".to_string())),
            ]),
        )
        .unwrap();
        let RunConfiguration::Task {
            command,
            environment,
            ..
        } = resolve_task_configuration(&configuration, &inputs(), &chosen).unwrap()
        else {
            panic!("task should stay a task");
        };
        assert_eq!(command, "sync --env prod  --repos=api,app");
        assert_eq!(environment.get("TARGET").map(String::as_str), Some("prod"));
    }

    #[test]
    fn rejects_invalid_values() {
        let ids = vec!["env".to_string(), "dryRun".to_string(), "repos".to_string()];
        for provided in [
            values(&[("env", RunInputValue::Text("staging".to_string()))]),
            values(&[("dryRun", RunInputValue::Text("yes".to_string()))]),
            values(&[("repos", RunInputValue::Text("a\nb".to_string()))]),
            values(&[("unknown", RunInputValue::Boolean(true))]),
        ] {
            assert!(resolve_input_values(&inputs(), &ids, &provided).is_err());
        }

        let required = vec![RunInput::Text {
            id: "name".to_string(),
            label: "Migration name".to_string(),
            description: None,
            default: String::new(),
            required: true,
        }];
        assert_eq!(
            resolve_input_values(&required, &["name".to_string()], &RunInputValues::new()),
            Err("`Migration name` is required.".to_string())
        );
    }

    #[test]
    fn validates_input_definitions_and_references() {
        let mut document = RunConfigurationDocument {
            schema_version: RUN_SCHEMA_VERSION,
            inputs: inputs(),
            configurations: vec![task("sync ${input:env}", &[])],
        };
        validate_inputs(&document.inputs).unwrap();
        validate_input_references(&document).unwrap();

        document.configurations = vec![task("sync ${input:missing}", &[])];
        assert!(validate_input_references(&document).is_err());

        let invalid_default = vec![RunInput::Select {
            id: "env".to_string(),
            label: "Environment".to_string(),
            description: None,
            options: vec![RunInputOption {
                value: "dev".to_string(),
                label: None,
            }],
            default: Some("prod".to_string()),
        }];
        assert!(validate_inputs(&invalid_default).is_err());

        let mut duplicated = inputs();
        duplicated.push(inputs().remove(0));
        assert!(validate_inputs(&duplicated).is_err());
    }

    #[test]
    fn serializes_inputs_with_camel_case_type_tags() {
        let serialized = serde_json::to_value(inputs()).unwrap();
        assert_eq!(serialized[0]["type"], "select");
        assert_eq!(serialized[1]["trueValue"], "--dry-run");
        assert!(serialized[0].get("description").is_none());

        let parsed = serde_json::from_value::<Vec<RunInput>>(serde_json::json!([
            { "type": "boolean", "id": "verbose", "label": "Verbose" }
        ]))
        .unwrap();
        assert_eq!(
            parsed[0],
            RunInput::Boolean {
                id: "verbose".to_string(),
                label: "Verbose".to_string(),
                description: None,
                default: false,
                true_value: "true".to_string(),
                false_value: "false".to_string(),
            }
        );
    }
}
