CREATE TABLE enrollment_settings (
  instance_id TEXT PRIMARY KEY REFERENCES instances(instance_id),
  document_ciphertext BLOB NOT NULL,
  captured_at INTEGER NOT NULL
) STRICT;
