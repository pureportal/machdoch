#[cfg(test)]
mod model_catalog_parser_tests {
    use super::super::{
        codex_cli::parse_codex_cli_model_catalog,
        copilot_cli::parse_copilot_cli_model_catalog,
        provider_api::parse_langdock_model_catalog,
        provider_api_types::{
            create_anthropic_runtime_model, create_google_runtime_model,
            create_openai_runtime_model, parse_anthropic_model_catalog, parse_google_model_catalog,
            parse_openai_model_catalog, resolve_langdock_api_base_url, resolve_langdock_base_url,
            LangdockApiFamily,
        },
    };
    use std::collections::HashMap;

    #[test]
    fn codex_cli_model_catalog_parser_extracts_slugs_and_cross_provider_models() {
        let raw = r#"
        {
            "models": [
                { "slug": "gpt-5.5", "display_name": "GPT-5.5" },
                { "slug": "claude-opus-4-8", "display_name": "Claude Opus 4.8" },
                { "slug": "gemini-3.1-pro-preview", "display_name": "Gemini 3.1 Pro" },
                { "slug": "codex-auto-review", "display_name": "Codex Auto Review" },
                { "slug": "gemini-embedding-001", "display_name": "Gemini Embedding" }
            ]
        }
        "#;
        let model_ids = parse_codex_cli_model_catalog(raw)
            .expect("Codex CLI catalog should include supported model IDs")
            .into_iter()
            .map(|model| model.id)
            .collect::<Vec<_>>();

        assert_eq!(
            model_ids,
            vec!["claude-opus-4-8", "gemini-3.1-pro-preview", "gpt-5.5"]
        );
    }

    #[test]
    fn copilot_cli_help_parser_extracts_models_without_telemetry_keys() {
        let help_output = r#"
            --model=MODEL Set the AI model you want to use. Pass auto to let Copilot pick.
            Examples: copilot -p "Explain" -s --model claude-haiku-4.5
            copilot -p "Fix" --model gpt-5.3-codex --allow-tool write
            copilot -p "Check" --model gemini-3.1-pro-preview --allow-all
            COPILOT_MODEL can be set to gpt-5.2 or claude-sonnet-4.5.
            Telemetry fields include github.copilot.token_limit and github.copilot.aiu.
        "#;
        let model_ids = parse_copilot_cli_model_catalog(help_output)
            .expect("help output should include supported Copilot model IDs")
            .into_iter()
            .map(|model| model.id)
            .collect::<Vec<_>>();

        assert_eq!(
            model_ids,
            vec![
                "auto",
                "claude-haiku-4.5",
                "claude-sonnet-4.5",
                "gemini-3.1-pro-preview",
                "gpt-5.2",
                "gpt-5.3-codex"
            ]
        );
        assert!(!model_ids
            .iter()
            .any(|model_id| model_id.contains("github.copilot")));
    }

    #[test]
    fn langdock_model_catalog_parser_keeps_openai_compatible_chat_models() {
        let raw = r#"
        {
            "object": "list",
            "data": [
                {
                    "id": "gpt-5.5",
                    "object": "model",
                    "created": 0,
                    "region": "eu"
                },
                {
                    "id": "gpt-5.4-mini",
                    "object": "model",
                    "created": 0,
                    "region": "eu"
                },
                {
                    "id": "langdock-llama-3.3-70b-2",
                    "object": "model",
                    "created": 0,
                    "region": "eu"
                },
                {
                    "id": "text-embedding-3-large",
                    "object": "model",
                    "created": 0,
                    "region": "eu",
                    "supportsExtendedThinking": false
                }
            ]
        }
        "#;
        let models = parse_langdock_model_catalog(raw).expect("Langdock catalog should parse");
        let model_ids = models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            model_ids,
            vec!["gpt-5.4-mini", "gpt-5.5", "langdock-llama-3.3-70b-2"]
        );
        assert_eq!(models[1].release_date.as_deref(), Some("1970-01-01"));
        assert_eq!(models[1].capabilities.reasoning, Some(true));
        assert!(!model_ids.contains(&"text-embedding-3-large"));
    }

    #[test]
    fn langdock_model_catalog_parser_sorts_and_deduplicates_models() {
        let raw = r#"
        {
            "object": "list",
            "data": [
                {
                    "id": "gpt-5.5",
                    "object": "model",
                    "created": 0,
                    "region": "eu"
                },
                {
                    "id": "gpt-5.4-mini",
                    "object": "model",
                    "created": 0,
                    "region": "eu"
                },
                {
                    "id": "gpt-5.5",
                    "object": "model",
                    "created": 86400000,
                    "region": "us"
                }
            ]
        }
        "#;
        let models = parse_langdock_model_catalog(raw).expect("Langdock catalog should parse");

        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["gpt-5.4-mini", "gpt-5.5"]
        );
        assert_eq!(models[1].release_date.as_deref(), Some("1970-01-01"));
    }

    #[test]
    fn provider_api_type_helpers_normalize_openai_capabilities() {
        let model = create_openai_runtime_model("gpt-5.4-mini", Some("2026-01-02".to_string()));

        assert_eq!(model.id, "gpt-5.4-mini");
        assert_eq!(model.release_date.as_deref(), Some("2026-01-02"));
        assert!(model.recommended_for.contains(&"coding".to_string()));
        assert!(model.recommended_for.contains(&"fast".to_string()));
        assert_eq!(model.capabilities.image_input, Some(true));
        assert_eq!(model.capabilities.reasoning, Some(true));
        assert_eq!(model.capabilities.computer_use, Some(true));
        assert_eq!(model.source, "provider-api");
    }

    #[test]
    fn provider_api_payload_parsers_filter_and_sort_provider_models() {
        let openai_payload = serde_json::json!({
            "data": [
                { "id": "text-embedding-3-large", "created": 0 },
                { "id": "gpt-5.4-mini", "created": 1767312000 },
                { "id": "gpt-5.5", "created": 1767225600 }
            ]
        });
        let openai_ids = parse_openai_model_catalog(&openai_payload)
            .into_iter()
            .map(|model| (model.id, model.release_date))
            .collect::<Vec<_>>();

        assert_eq!(
            openai_ids,
            vec![
                ("gpt-5.4-mini".to_string(), Some("2026-01-02".to_string())),
                ("gpt-5.5".to_string(), Some("2026-01-01".to_string()))
            ]
        );

        let anthropic_payload = serde_json::json!({
            "data": [
                { "id": "claude-sonnet-4-5" },
                { "id": "embedding-model" },
                { "id": "claude-opus-4-8" }
            ]
        });
        assert_eq!(
            parse_anthropic_model_catalog(&anthropic_payload)
                .into_iter()
                .map(|model| model.id)
                .collect::<Vec<_>>(),
            vec!["claude-opus-4-8", "claude-sonnet-4-5"]
        );

        let google_payload = serde_json::json!({
            "models": [
                {
                    "name": "models/gemini-3.1-pro-preview",
                    "supportedGenerationMethods": ["generateContent"]
                },
                {
                    "name": "models/gemini-embedding-001",
                    "supportedGenerationMethods": ["embedContent"]
                },
                {
                    "name": "models/gemini-3.1-pro-preview",
                    "supportedGenerationMethods": ["generateContent"]
                }
            ]
        });
        assert_eq!(
            parse_google_model_catalog(&google_payload)
                .into_iter()
                .map(|model| model.id)
                .collect::<Vec<_>>(),
            vec!["gemini-3.1-pro-preview"]
        );
    }

    #[test]
    fn provider_api_type_helpers_preserve_anthropic_metadata() {
        let entry = serde_json::json!({
            "id": "claude-sonnet-4.5",
            "display_name": "Claude Sonnet 4.5",
            "created_at": "2026-03-04T00:00:00Z",
            "capabilities": {
                "vision": true,
                "tool_use": true,
                "extended_thinking": true
            },
            "max_input_tokens": 200000,
            "max_tokens": 8192
        });
        let model = create_anthropic_runtime_model(&entry).expect("model should parse");

        assert_eq!(model.id, "claude-sonnet-4.5");
        assert_eq!(model.label.as_deref(), Some("Claude Sonnet 4.5"));
        assert_eq!(model.release_date.as_deref(), Some("2026-03-04"));
        assert!(model.recommended_for.contains(&"coding".to_string()));
        assert_eq!(model.capabilities.reasoning, Some(true));
        assert_eq!(model.capabilities.context_window_tokens, Some(200000));
        assert_eq!(model.capabilities.max_output_tokens, Some(8192));
    }

    #[test]
    fn provider_api_type_helpers_filter_google_generation_models() {
        let skipped = serde_json::json!({
            "name": "models/gemini-embedding-001",
            "baseModelId": "gemini-embedding-001",
            "supportedGenerationMethods": ["embedContent"]
        });
        assert!(create_google_runtime_model(&skipped).is_none());

        let entry = serde_json::json!({
            "name": "models/gemini-3.1-pro-preview",
            "baseModelId": "gemini-3.1-pro-preview",
            "displayName": "Gemini 3.1 Pro Preview",
            "description": "Preview reasoning model",
            "supportedGenerationMethods": ["generateContent"],
            "thinking": true,
            "inputTokenLimit": 1048576,
            "outputTokenLimit": 65536
        });
        let model = create_google_runtime_model(&entry).expect("model should parse");

        assert_eq!(model.id, "gemini-3.1-pro-preview");
        assert_eq!(model.label.as_deref(), Some("Gemini 3.1 Pro Preview"));
        assert_eq!(model.capabilities.reasoning, Some(true));
        assert_eq!(model.capabilities.context_window_tokens, Some(1048576));
        assert_eq!(model.capabilities.max_output_tokens, Some(65536));
        assert!(model.recommended_for.contains(&"coding".to_string()));
        assert!(model.recommended_for.contains(&"vision".to_string()));
    }

    #[test]
    fn provider_api_type_helpers_resolve_langdock_base_url() {
        let mut env = HashMap::new();
        assert_eq!(
            resolve_langdock_base_url(&env),
            "https://api.langdock.com/openai/eu/v1"
        );

        env.insert("LANGDOCK_REGION".to_string(), "US".to_string());
        assert_eq!(
            resolve_langdock_base_url(&env),
            "https://api.langdock.com/openai/us/v1"
        );

        env.insert(
            "LANGDOCK_BASE_URL".to_string(),
            " https://example.test/api/public/// ".to_string(),
        );
        assert_eq!(
            resolve_langdock_base_url(&env),
            "https://example.test/api/public/openai/us/v1"
        );
        assert_eq!(
            resolve_langdock_api_base_url(&env, LangdockApiFamily::Anthropic),
            "https://example.test/api/public/anthropic/us/v1"
        );
        assert_eq!(
            resolve_langdock_api_base_url(&env, LangdockApiFamily::Google),
            "https://example.test/api/public/google/us/v1beta"
        );

        env.insert(
            "LANGDOCK_BASE_URL".to_string(),
            "https://api.langdock.com/google/eu/v1beta/models/gemini-2.5-pro:generateContent"
                .to_string(),
        );
        assert_eq!(
            resolve_langdock_base_url(&env),
            "https://api.langdock.com/openai/eu/v1"
        );
        assert_eq!(
            resolve_langdock_api_base_url(&env, LangdockApiFamily::Anthropic),
            "https://api.langdock.com/anthropic/eu/v1"
        );
        assert_eq!(
            resolve_langdock_api_base_url(&env, LangdockApiFamily::Google),
            "https://api.langdock.com/google/eu/v1beta"
        );
    }
}
