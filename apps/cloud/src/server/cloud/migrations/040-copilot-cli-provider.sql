ALTER TABLE cloud_ai_providers DROP CONSTRAINT cloud_ai_providers_provider_check;
ALTER TABLE cloud_ai_providers ADD CONSTRAINT cloud_ai_providers_provider_check CHECK (provider IN ('openai','anthropic','google','langdock','claude-code-cli','codex-cli','copilot-cli'));
