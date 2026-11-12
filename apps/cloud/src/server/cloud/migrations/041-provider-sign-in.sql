ALTER TABLE cloud_ai_providers ADD COLUMN sign_in boolean NOT NULL DEFAULT false;
UPDATE cloud_ai_providers SET sign_in=true WHERE provider IN ('claude-code-cli','codex-cli');
ALTER TABLE cloud_ai_providers ADD CONSTRAINT cloud_ai_providers_sign_in CHECK (NOT sign_in OR provider IN ('claude-code-cli','codex-cli','copilot-cli'));
