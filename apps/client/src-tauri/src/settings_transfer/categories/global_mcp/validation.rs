use std::collections::HashSet;

use serde_json::Value;

use super::super::{
    require_exact_keys, require_only_keys, required_trimmed_string, MAX_TOTAL_ITEMS,
};
use super::normalize_marketplace;

fn validate_mcp_string_array(value: &Value) -> bool {
    value.as_array().is_some_and(|values| {
        values.len() <= MAX_TOTAL_ITEMS
            && values.iter().all(|value| {
                value.as_str().is_some_and(|value| {
                    !value.trim().is_empty()
                        && value.len() <= 4_096
                        && !value.chars().any(char::is_control)
                })
            })
    })
}

fn validate_mcp_string_map(value: &Value) -> bool {
    value.as_object().is_some_and(|values| {
        values.len() <= MAX_TOTAL_ITEMS
            && values.iter().all(|(key, value)| {
                !key.trim().is_empty()
                    && key.len() <= 512
                    && !key.chars().any(char::is_control)
                    && value.is_string()
            })
    })
}

fn valid_mcp_positive_integer(value: Option<&Value>) -> bool {
    value.and_then(Value::as_u64).is_some_and(|value| value > 0)
}

fn valid_optional_mcp_enum(value: Option<&Value>, allowed: &[&str]) -> bool {
    value.is_none_or(|value| value.as_str().is_some_and(|value| allowed.contains(&value)))
}

fn validate_mcp_cache(value: &Value) -> Result<(), String> {
    let cache = value
        .as_object()
        .ok_or_else(|| "An MCP cache policy is invalid.".to_string())?;
    require_only_keys(cache, &["enabled", "ttlMs", "ttlSeconds", "forceRefresh"])?;
    if cache
        .get("enabled")
        .is_some_and(|value| !value.is_boolean())
        || cache
            .get("forceRefresh")
            .is_some_and(|value| !value.is_boolean())
        || cache
            .get("ttlMs")
            .is_some_and(|value| value.as_u64().is_none())
        || cache
            .get("ttlSeconds")
            .is_some_and(|value| value.as_u64().is_none())
    {
        return Err("An MCP cache policy is invalid.".to_string());
    }
    Ok(())
}

fn validate_mcp_roots(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|value| ["disabled", "workspace"].contains(&value))
        || validate_mcp_string_array(value)
}

fn validate_mcp_defaults(value: &Value) -> Result<(), String> {
    let defaults = value
        .as_object()
        .ok_or_else(|| "The global MCP defaults are invalid.".to_string())?;
    require_only_keys(
        defaults,
        &[
            "enabled",
            "securityProfile",
            "exposure",
            "directTools",
            "timeoutMs",
            "maxTotalTimeoutMs",
            "idleShutdownMs",
            "maxResponseChars",
            "cache",
            "roots",
            "sampling",
            "tasks",
            "elicitation",
        ],
    )?;
    if defaults
        .get("enabled")
        .is_some_and(|value| !value.is_boolean())
        || defaults
            .get("directTools")
            .is_some_and(|value| !value.is_boolean())
        || !valid_optional_mcp_enum(
            defaults.get("securityProfile"),
            &["weak", "balanced", "strict"],
        )
        || !valid_optional_mcp_enum(
            defaults.get("exposure"),
            &["meta-tools", "direct-tools", "hybrid"],
        )
        || ["timeoutMs", "maxTotalTimeoutMs", "maxResponseChars"]
            .into_iter()
            .any(|key| {
                defaults
                    .get(key)
                    .is_some_and(|_| !valid_mcp_positive_integer(defaults.get(key)))
            })
        || defaults
            .get("idleShutdownMs")
            .is_some_and(|value| value.as_u64().is_none())
        || defaults
            .get("roots")
            .is_some_and(|value| !validate_mcp_roots(value))
        || !valid_optional_mcp_enum(defaults.get("sampling"), &["disabled", "ask-agent"])
        || !valid_optional_mcp_enum(defaults.get("tasks"), &["disabled", "optional"])
        || !valid_optional_mcp_enum(defaults.get("elicitation"), &["disabled"])
    {
        return Err("The global MCP defaults are invalid.".to_string());
    }
    if let Some(cache) = defaults.get("cache") {
        validate_mcp_cache(cache)?;
    }
    Ok(())
}

fn validate_mcp_transport(value: &Value) -> Result<(), String> {
    let transport = value
        .as_object()
        .ok_or_else(|| "An MCP transport is invalid.".to_string())?;
    match transport.get("type").and_then(Value::as_str) {
        Some("stdio") => {
            require_only_keys(
                transport,
                &[
                    "type",
                    "command",
                    "args",
                    "cwd",
                    "env",
                    "inheritEnvironment",
                    "stderr",
                ],
            )?;
            let _ = required_trimmed_string(
                transport.get("command"),
                "An MCP stdio transport is missing its command.",
            )?;
            if transport
                .get("args")
                .is_some_and(|value| !validate_mcp_string_array(value))
                || transport.get("cwd").is_some_and(|value| !value.is_string())
                || transport
                    .get("env")
                    .is_some_and(|value| !validate_mcp_string_map(value))
                || transport
                    .get("inheritEnvironment")
                    .is_some_and(|value| !value.is_boolean())
                || !valid_optional_mcp_enum(transport.get("stderr"), &["pipe", "ignore", "inherit"])
            {
                return Err("An MCP stdio transport is invalid.".to_string());
            }
        }
        Some("streamable-http" | "sse") => {
            let is_streamable =
                transport.get("type").and_then(Value::as_str) == Some("streamable-http");
            let allowed = if is_streamable {
                &["type", "url", "headers", "sessionId", "legacySseFallback"][..]
            } else {
                &["type", "url", "headers"][..]
            };
            require_only_keys(transport, allowed)?;
            let url = required_trimmed_string(
                transport.get("url"),
                "An MCP network transport is missing its URL.",
            )?;
            let parsed = reqwest::Url::parse(&url)
                .map_err(|_| "An MCP transport URL is invalid.".to_string())?;
            if !matches!(parsed.scheme(), "http" | "https")
                || parsed.host_str().is_none()
                || transport
                    .get("headers")
                    .is_some_and(|value| !validate_mcp_string_map(value))
                || transport
                    .get("sessionId")
                    .is_some_and(|value| !value.is_string())
                || transport
                    .get("legacySseFallback")
                    .is_some_and(|value| !value.is_boolean())
            {
                return Err("An MCP network transport is invalid.".to_string());
            }
        }
        _ => return Err("An MCP server uses an unsupported transport.".to_string()),
    }
    Ok(())
}

fn validate_mcp_auth(value: &Value) -> Result<(), String> {
    let auth = value
        .as_object()
        .ok_or_else(|| "An MCP authentication configuration is invalid.".to_string())?;
    let auth_type = auth.get("type").and_then(Value::as_str);
    let allowed = match auth_type {
        Some("none") => &["type"][..],
        Some("bearer") => &["type", "token", "tokenEnv", "headerName"][..],
        Some("headers") => &["type", "headers", "envHeaders"][..],
        Some("oauth") => &[
            "type",
            "clientId",
            "clientSecret",
            "clientSecretEnv",
            "redirectUrl",
            "clientMetadataUrl",
            "scopes",
            "accessToken",
            "accessTokenEnv",
            "refreshToken",
            "refreshTokenEnv",
            "tokenType",
            "tokenScope",
            "expiresIn",
            "idToken",
            "authorizationUrl",
            "authorizationState",
            "codeVerifier",
            "clientInformation",
            "discoveryState",
        ][..],
        _ => return Err("An MCP authentication type is unsupported.".to_string()),
    };
    require_only_keys(auth, allowed)?;
    if auth_type == Some("headers")
        && ["headers", "envHeaders"].into_iter().any(|key| {
            auth.get(key)
                .is_some_and(|value| !validate_mcp_string_map(value))
        })
    {
        return Err("MCP authentication headers are invalid.".to_string());
    }
    if auth_type == Some("oauth")
        && (auth
            .get("scopes")
            .is_some_and(|value| !validate_mcp_string_array(value))
            || auth
                .get("expiresIn")
                .is_some_and(|value| value.as_u64().is_none())
            || ["clientInformation", "discoveryState"]
                .into_iter()
                .any(|key| auth.get(key).is_some_and(|value| !value.is_object())))
    {
        return Err("An MCP OAuth configuration is invalid.".to_string());
    }
    if auth.iter().any(|(key, value)| {
        key != "type"
            && !matches!(
                key.as_str(),
                "headers"
                    | "envHeaders"
                    | "scopes"
                    | "expiresIn"
                    | "clientInformation"
                    | "discoveryState"
            )
            && !value.is_string()
    }) {
        return Err("An MCP authentication value is invalid.".to_string());
    }
    Ok(())
}

fn validate_mcp_exposure(value: &Value) -> Result<(), String> {
    let exposure = value
        .as_object()
        .ok_or_else(|| "An MCP exposure configuration is invalid.".to_string())?;
    require_only_keys(exposure, &["mode", "directTools"])?;
    if !valid_optional_mcp_enum(
        exposure.get("mode"),
        &["meta-tools", "direct-tools", "hybrid"],
    ) {
        return Err("An MCP exposure mode is invalid.".to_string());
    }
    if let Some(direct) = exposure.get("directTools") {
        if direct.is_boolean() {
            return Ok(());
        }
        let direct = direct
            .as_object()
            .ok_or_else(|| "An MCP direct-tool exposure rule is invalid.".to_string())?;
        require_only_keys(
            direct,
            &["enabled", "include", "exclude", "namespacePrefix"],
        )?;
        if direct
            .get("enabled")
            .is_some_and(|value| !value.is_boolean())
            || ["include", "exclude"].into_iter().any(|key| {
                direct
                    .get(key)
                    .is_some_and(|value| !validate_mcp_string_array(value))
            })
            || direct
                .get("namespacePrefix")
                .is_some_and(|value| !value.is_string())
        {
            return Err("An MCP direct-tool exposure rule is invalid.".to_string());
        }
    }
    Ok(())
}

fn validate_mcp_tool_overrides(value: &Value) -> Result<(), String> {
    let overrides = value
        .as_object()
        .ok_or_else(|| "MCP tool overrides are invalid.".to_string())?;
    if overrides.len() > MAX_TOTAL_ITEMS {
        return Err("MCP tool overrides contain too many entries.".to_string());
    }
    for (name, value) in overrides {
        if name.trim().is_empty() || name.len() > 512 {
            return Err("An MCP tool override name is invalid.".to_string());
        }
        let value = value
            .as_object()
            .ok_or_else(|| "An MCP tool override is invalid.".to_string())?;
        require_only_keys(
            value,
            &[
                "enabled",
                "title",
                "description",
                "riskLevel",
                "effect",
                "readOnlyInAskMode",
            ],
        )?;
        if ["enabled", "readOnlyInAskMode"]
            .into_iter()
            .any(|key| value.get(key).is_some_and(|value| !value.is_boolean()))
            || ["title", "description"]
                .into_iter()
                .any(|key| value.get(key).is_some_and(|value| !value.is_string()))
            || !valid_optional_mcp_enum(value.get("riskLevel"), &["low", "medium", "high"])
            || !valid_optional_mcp_enum(
                value.get("effect"),
                &["read", "write", "external-read", "external-side-effect"],
            )
        {
            return Err("An MCP tool override is invalid.".to_string());
        }
    }
    Ok(())
}

fn validate_mcp_server(server: &Value, ids: &mut HashSet<String>) -> Result<(), String> {
    let server = server
        .as_object()
        .ok_or_else(|| "An MCP server entry is invalid.".to_string())?;
    require_only_keys(
        server,
        &[
            "id",
            "title",
            "description",
            "enabled",
            "preset",
            "transport",
            "auth",
            "exposure",
            "securityProfile",
            "timeoutMs",
            "maxTotalTimeoutMs",
            "idleShutdownMs",
            "maxResponseChars",
            "cache",
            "toolOverrides",
            "roots",
            "sampling",
            "tasks",
            "notes",
        ],
    )?;
    let id = required_trimmed_string(server.get("id"), "An MCP server is missing its id.")?;
    if id.len() > 80
        || !id.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '-' | '_')
        })
        || !ids.insert(id)
    {
        return Err("MCP server ids must be canonical and unique.".to_string());
    }
    if ["title", "description", "preset", "notes"]
        .into_iter()
        .any(|key| server.get(key).is_some_and(|value| !value.is_string()))
        || server
            .get("enabled")
            .is_some_and(|value| !value.is_boolean())
        || !valid_optional_mcp_enum(
            server.get("securityProfile"),
            &["weak", "balanced", "strict"],
        )
        || ["timeoutMs", "maxTotalTimeoutMs", "maxResponseChars"]
            .into_iter()
            .any(|key| {
                server
                    .get(key)
                    .is_some_and(|_| !valid_mcp_positive_integer(server.get(key)))
            })
        || server
            .get("idleShutdownMs")
            .is_some_and(|value| value.as_u64().is_none())
        || server
            .get("roots")
            .is_some_and(|value| !validate_mcp_roots(value))
        || !valid_optional_mcp_enum(server.get("sampling"), &["disabled", "ask-agent"])
        || !valid_optional_mcp_enum(server.get("tasks"), &["disabled", "optional"])
    {
        return Err("An MCP server entry contains invalid settings.".to_string());
    }
    if let Some(value) = server.get("transport") {
        validate_mcp_transport(value)?;
    }
    if let Some(value) = server.get("auth") {
        validate_mcp_auth(value)?;
    }
    if let Some(value) = server.get("exposure") {
        validate_mcp_exposure(value)?;
    }
    if let Some(value) = server.get("cache") {
        validate_mcp_cache(value)?;
    }
    if let Some(value) = server.get("toolOverrides") {
        validate_mcp_tool_overrides(value)?;
    }
    Ok(())
}

pub(super) fn validate_config(value: &Value) -> Result<(), String> {
    let root = value
        .as_object()
        .ok_or_else(|| "The global MCP configuration must be an object.".to_string())?;
    require_only_keys(root, &["schemaVersion", "defaults", "servers"])?;
    if root
        .get("schemaVersion")
        .is_some_and(|version| version.as_u64() != Some(1))
    {
        return Err("The global MCP configuration uses an unsupported schema.".to_string());
    }
    if let Some(defaults) = root.get("defaults") {
        validate_mcp_defaults(defaults)?;
    }
    let servers = match root.get("servers") {
        None => return Ok(()),
        Some(Value::Array(servers)) => servers,
        _ => return Err("The global MCP server list is invalid.".to_string()),
    };
    if servers.len() > MAX_TOTAL_ITEMS {
        return Err("The global MCP configuration contains too many servers.".to_string());
    }
    let mut ids = HashSet::new();
    for server in servers {
        validate_mcp_server(server, &mut ids)?;
    }
    Ok(())
}

pub(super) fn validate(value: &Value) -> Result<(), String> {
    let root = value
        .as_object()
        .ok_or_else(|| "The MCP category is invalid.".to_string())?;
    require_exact_keys(root, &["exists", "config", "marketplace"])?;
    if !root.get("exists").is_some_and(Value::is_boolean) {
        return Err("The MCP file-presence marker is invalid.".to_string());
    }
    validate_config(
        root.get("config")
            .ok_or_else(|| "The MCP configuration is missing.".to_string())?,
    )?;
    let normalized = normalize_marketplace(root.get("marketplace").cloned())?;
    if normalized != root["marketplace"] {
        return Err("MCP marketplace registries are not normalized.".to_string());
    }
    Ok(())
}
