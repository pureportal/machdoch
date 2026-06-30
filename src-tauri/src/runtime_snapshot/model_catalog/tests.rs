#[cfg(test)]
mod model_catalog_parser_tests {
    use super::super::{
        codex_cli::parse_codex_cli_model_catalog, copilot_cli::parse_copilot_cli_model_catalog,
        provider_api::parse_langdock_model_catalog,
    };

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
}
