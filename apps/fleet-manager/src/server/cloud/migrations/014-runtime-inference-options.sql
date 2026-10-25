ALTER TABLE cloud_inference_calls
  ADD COLUMN model_options jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(model_options)='object');
