CREATE TABLE cloud_sandbox_runtime (
  id smallint PRIMARY KEY CHECK (id = 1),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE cloud_execution_workers ADD COLUMN hosted_token bytea;
