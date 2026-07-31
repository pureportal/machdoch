CREATE TABLE flows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  head_revision_id TEXT NOT NULL,
  head_revision_number INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  document_digest TEXT NOT NULL,
  execution_digest TEXT NOT NULL,
  layout_digest TEXT NOT NULL
);

CREATE TABLE flow_revisions (
  revision_id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  parent_revision_id TEXT,
  created_at TEXT NOT NULL,
  change_summary TEXT NOT NULL,
  document_digest TEXT NOT NULL,
  execution_digest TEXT NOT NULL,
  layout_digest TEXT NOT NULL,
  node_count INTEGER NOT NULL,
  edge_count INTEGER NOT NULL,
  flow_json TEXT NOT NULL,
  layout_json TEXT NOT NULL,
  artifact_relative_path TEXT NOT NULL,
  UNIQUE(flow_id, revision_number),
  FOREIGN KEY(flow_id) REFERENCES flows(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(parent_revision_id) REFERENCES flow_revisions(revision_id)
);

CREATE TABLE flow_save_requests (
  flow_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  created_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(flow_id, idempotency_key),
  FOREIGN KEY(flow_id) REFERENCES flows(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(revision_id) REFERENCES flow_revisions(revision_id)
);

CREATE TABLE flow_revision_imports (
  revision_id TEXT PRIMARY KEY,
  bundle_digest TEXT NOT NULL,
  source_flow_id TEXT NOT NULL,
  source_revision_id TEXT NOT NULL,
  source_display_name TEXT NOT NULL,
  review_token TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  report_json TEXT NOT NULL,
  bundle_artifact_relative_path TEXT NOT NULL,
  FOREIGN KEY(revision_id) REFERENCES flow_revisions(revision_id)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  flow_name TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model_label TEXT NOT NULL,
  target TEXT,
  output_count INTEGER NOT NULL,
  diagnostic_count INTEGER NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  current_step TEXT NOT NULL,
  executor TEXT NOT NULL,
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  aspect_ratio TEXT NOT NULL,
  plan_snapshot_json TEXT,
  flow_revision_id TEXT REFERENCES flow_revisions(revision_id)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  started_at TEXT,
  finished_at TEXT,
  heartbeat_at TEXT,
  error TEXT
);

CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  message TEXT NOT NULL,
  progress REAL,
  step_id TEXT,
  node_id TEXT,
  UNIQUE(run_id, sequence)
);

CREATE TABLE resource_leases (
  resource_key TEXT PRIMARY KEY,
  owner_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE blobs (
  digest TEXT PRIMARY KEY,
  byte_size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  available INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  blob_digest TEXT NOT NULL REFERENCES blobs(digest),
  kind TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  output_index INTEGER NOT NULL,
  fixture INTEGER NOT NULL DEFAULT 0,
  operation_json TEXT,
  deleted_at TEXT,
  deletion_mode TEXT,
  UNIQUE(run_id, output_index)
);

CREATE TABLE asset_inputs (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  input_asset_id TEXT NOT NULL REFERENCES assets(id),
  role TEXT NOT NULL,
  PRIMARY KEY(asset_id, input_asset_id, role)
);

CREATE TABLE asset_renditions (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  profile TEXT NOT NULL,
  blob_digest TEXT NOT NULL REFERENCES blobs(digest),
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(asset_id, profile)
);

CREATE TABLE asset_exports (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  destination_path TEXT NOT NULL,
  digest TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT,
  mode TEXT NOT NULL DEFAULT 'verified-original',
  source_digest TEXT,
  metadata_stripped INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE asset_tags (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  normalized_tag TEXT NOT NULL,
  display_tag TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(asset_id, normalized_tag, source)
);

CREATE TABLE asset_tag_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE asset_deletions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  impact_token TEXT NOT NULL,
  reclaimed_bytes INTEGER NOT NULL DEFAULT 0,
  retained_bytes INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE blob_gc_queue (
  deletion_id INTEGER NOT NULL REFERENCES asset_deletions(id) ON DELETE CASCADE,
  digest TEXT NOT NULL REFERENCES blobs(digest),
  relative_path TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  reclaimed_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(deletion_id, digest)
);

CREATE TABLE media_providers (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  target TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  privacy_summary TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  stale_after_seconds INTEGER NOT NULL,
  source_url TEXT,
  catalog_revision TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE media_models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES media_providers(id),
  display_name TEXT NOT NULL,
  family TEXT NOT NULL,
  target TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  lifecycle_checked_at TEXT NOT NULL,
  lifecycle_stale_after_seconds INTEGER NOT NULL,
  lifecycle_source_url TEXT,
  catalog_revision TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  bundled INTEGER NOT NULL,
  package_type TEXT NOT NULL,
  license_name TEXT NOT NULL,
  license_spdx_id TEXT,
  license_source_url TEXT NOT NULL,
  license_commercial_use TEXT NOT NULL,
  license_requires_acceptance INTEGER NOT NULL,
  recommended INTEGER NOT NULL,
  speed_score INTEGER NOT NULL,
  quality_score INTEGER NOT NULL,
  min_vram_gb REAL,
  expected_download_gb REAL,
  cost_hint TEXT,
  privacy_summary TEXT NOT NULL,
  limitation TEXT,
  updated_at TEXT NOT NULL,
  architecture TEXT,
  addon_capabilities_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE media_model_lifecycle_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT NOT NULL REFERENCES media_models(id),
  lifecycle TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  source_url TEXT,
  catalog_revision TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(model_id, lifecycle, catalog_revision)
);

CREATE TABLE media_model_license_acceptances (
  model_id TEXT NOT NULL REFERENCES media_models(id),
  revision TEXT NOT NULL,
  license_digest TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY(model_id, revision, license_digest)
);

CREATE TABLE media_model_installations (
  model_id TEXT PRIMARY KEY REFERENCES media_models(id),
  revision TEXT NOT NULL,
  status TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  bytes_on_disk INTEGER NOT NULL DEFAULT 0,
  installed_at TEXT,
  verified_at TEXT,
  error TEXT,
  updated_at TEXT NOT NULL,
  relative_path TEXT
);

CREATE TABLE media_model_install_jobs (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES media_models(id),
  revision TEXT NOT NULL,
  status TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  license_digest TEXT NOT NULL,
  files_total INTEGER NOT NULL,
  files_completed INTEGER NOT NULL DEFAULT 0,
  bytes_total INTEGER NOT NULL,
  bytes_downloaded INTEGER NOT NULL DEFAULT 0,
  current_file TEXT,
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE media_model_install_files (
  job_id TEXT NOT NULL REFERENCES media_model_install_jobs(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  bytes_downloaded INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(job_id, path)
);

CREATE TABLE media_model_removals (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES media_models(id),
  revision TEXT NOT NULL,
  status TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  trash_relative_path TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE media_model_addons (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('lora', 'textual-inversion')),
  display_name TEXT NOT NULL,
  architecture TEXT NOT NULL,
  architecture_confidence TEXT NOT NULL,
  format TEXT NOT NULL CHECK(format = 'safetensors'),
  target_components_json TEXT NOT NULL,
  base_model_hint TEXT,
  trigger_words_json TEXT NOT NULL,
  default_token TEXT,
  digest TEXT NOT NULL UNIQUE,
  header_digest TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size > 0),
  relative_path TEXT NOT NULL,
  source_url TEXT,
  license_name TEXT NOT NULL,
  license_source_url TEXT NOT NULL,
  license_commercial_use TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_metadata_json TEXT,
  embedding_vectors_json TEXT NOT NULL,
  lora_profile_json TEXT
);

CREATE TABLE media_model_addon_removals (
  id TEXT PRIMARY KEY,
  addon_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('prepared', 'cleanup-pending', 'removed')),
  relative_path TEXT NOT NULL,
  trash_relative_path TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size > 0),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE media_model_runtime_probes (
  model_id TEXT PRIMARY KEY REFERENCES media_models(id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  model_digest TEXT NOT NULL,
  runtime_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready', 'failed')),
  worker_version TEXT NOT NULL,
  pipeline_class TEXT,
  device_label TEXT,
  diagnostic TEXT NOT NULL,
  probed_at TEXT NOT NULL
);

CREATE TABLE provider_jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  raw_state TEXT,
  scenario TEXT NOT NULL,
  phase_cursor INTEGER NOT NULL DEFAULT 0,
  request_digest TEXT NOT NULL,
  idempotency_key TEXT,
  provider_job_id TEXT,
  provider_request_id TEXT,
  estimated_cost_min REAL NOT NULL,
  estimated_cost_max REAL NOT NULL,
  currency TEXT NOT NULL,
  poll_attempts INTEGER NOT NULL DEFAULT 0,
  next_poll_at TEXT,
  reconciliation_deadline TEXT NOT NULL,
  accepted_at TEXT,
  retention_expires_at TEXT,
  late_success INTEGER NOT NULL DEFAULT 0,
  review_required INTEGER NOT NULL DEFAULT 0,
  review_reason TEXT,
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  policy_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(run_id, attempt)
);

CREATE TABLE provider_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_job_id TEXT NOT NULL REFERENCES provider_jobs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  normalized_state TEXT NOT NULL,
  raw_state TEXT NOT NULL,
  source TEXT NOT NULL,
  retry_after_ms INTEGER,
  observed_at TEXT NOT NULL,
  UNIQUE(provider_job_id, sequence)
);

CREATE TABLE human_reviews (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL,
  instructions TEXT NOT NULL,
  max_selections INTEGER NOT NULL,
  require_comment INTEGER NOT NULL,
  candidate_asset_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  UNIQUE(run_id, node_id),
  UNIQUE(run_id, sequence)
);

CREATE TABLE human_review_decisions (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL UNIQUE REFERENCES human_reviews(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  selected_asset_ids_json TEXT NOT NULL,
  comment TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE node_executions (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  node_label TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'pending', 'queued', 'running', 'waiting-for-review', 'retrying',
    'completed', 'cached', 'skipped', 'failed', 'canceled', 'blocked'
  )),
  active_step_id TEXT,
  runtime_phase TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  progress REAL,
  message TEXT,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  state_sequence INTEGER NOT NULL DEFAULT 0,
  first_step_id TEXT,
  last_step_id TEXT,
  PRIMARY KEY(run_id, node_id)
);

CREATE TABLE media_catalog_revisions (
  catalog TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0)
);

INSERT INTO media_catalog_revisions(catalog, instance_id, revision)
  VALUES ('asset-library', lower(hex(randomblob(16))), 1);
INSERT INTO media_catalog_revisions(catalog, instance_id, revision)
  VALUES ('run-library', lower(hex(randomblob(16))), 1);

CREATE INDEX flows_updated_at_idx ON flows(updated_at DESC);
CREATE INDEX flow_revisions_flow_idx ON flow_revisions(flow_id, revision_number DESC);
CREATE INDEX flow_revision_imports_bundle_idx
  ON flow_revision_imports(bundle_digest, imported_at DESC);
CREATE INDEX runs_created_at_idx ON runs(created_at DESC);
CREATE INDEX runs_flow_revision_idx ON runs(flow_revision_id);
CREATE INDEX run_events_run_idx ON run_events(run_id, sequence);
CREATE INDEX assets_created_at_idx ON assets(created_at DESC);
CREATE INDEX assets_active_created_idx ON assets(deleted_at, created_at DESC);
CREATE INDEX asset_renditions_blob_idx ON asset_renditions(blob_digest);
CREATE INDEX asset_exports_asset_idx ON asset_exports(asset_id, created_at DESC);
CREATE INDEX asset_tags_value_idx ON asset_tags(normalized_tag, asset_id);
CREATE INDEX asset_tag_revisions_asset_idx ON asset_tag_revisions(asset_id, id DESC);
CREATE INDEX asset_deletions_asset_idx ON asset_deletions(asset_id, id DESC);
CREATE INDEX blob_gc_queue_status_idx ON blob_gc_queue(status, deletion_id);
CREATE INDEX media_models_provider_idx ON media_models(provider_id, lifecycle);
CREATE INDEX media_model_lifecycle_idx
  ON media_model_lifecycle_snapshots(model_id, observed_at DESC);
CREATE INDEX media_model_install_jobs_model_idx
  ON media_model_install_jobs(model_id, created_at DESC);
CREATE INDEX media_model_removals_status_idx
  ON media_model_removals(status, created_at);
CREATE INDEX media_model_addons_architecture_kind_idx
  ON media_model_addons(architecture, kind, display_name);
CREATE INDEX media_model_addon_removals_status_idx
  ON media_model_addon_removals(status, created_at);
CREATE INDEX media_model_runtime_probes_status_idx
  ON media_model_runtime_probes(status, probed_at);
CREATE INDEX provider_jobs_run_idx ON provider_jobs(run_id, attempt DESC);
CREATE INDEX provider_jobs_due_idx ON provider_jobs(status, next_poll_at);
CREATE INDEX provider_observations_job_idx
  ON provider_observations(provider_job_id, sequence);
CREATE INDEX human_reviews_run_idx ON human_reviews(run_id, sequence);
CREATE INDEX human_reviews_pending_idx ON human_reviews(status, updated_at);
CREATE INDEX node_executions_run_status_idx
  ON node_executions(run_id, status, ordinal);

CREATE TRIGGER asset_library_revision_assets_insert
AFTER INSERT ON assets BEGIN
  UPDATE media_catalog_revisions SET revision = revision + 1
    WHERE catalog = 'asset-library';
END;

CREATE TRIGGER asset_library_revision_assets_update
AFTER UPDATE ON assets BEGIN
  UPDATE media_catalog_revisions SET revision = revision + 1
    WHERE catalog = 'asset-library';
END;

CREATE TRIGGER asset_library_revision_assets_delete
AFTER DELETE ON assets BEGIN
  UPDATE media_catalog_revisions SET revision = revision + 1
    WHERE catalog = 'asset-library';
END;

CREATE TRIGGER asset_library_revision_inputs_insert
AFTER INSERT ON asset_inputs BEGIN
  UPDATE media_catalog_revisions SET revision = revision + 1
    WHERE catalog = 'asset-library';
END;

CREATE TRIGGER asset_library_revision_inputs_update
AFTER UPDATE ON asset_inputs BEGIN
  UPDATE media_catalog_revisions SET revision = revision + 1
    WHERE catalog = 'asset-library';
END;

CREATE TRIGGER asset_library_revision_inputs_delete
AFTER DELETE ON asset_inputs BEGIN
  UPDATE media_catalog_revisions SET revision = revision + 1
    WHERE catalog = 'asset-library';
END;

CREATE TRIGGER asset_library_revision_tags_insert
AFTER INSERT ON asset_tags BEGIN
  UPDATE media_catalog_revisions SET revision = revision + 1
    WHERE catalog = 'asset-library';
END;

CREATE TRIGGER asset_library_revision_tags_update
AFTER UPDATE ON asset_tags BEGIN
  UPDATE media_catalog_revisions SET revision = revision + 1
    WHERE catalog = 'asset-library';
END;

CREATE TRIGGER asset_library_revision_tags_delete
AFTER DELETE ON asset_tags BEGIN
  UPDATE media_catalog_revisions SET revision = revision + 1
    WHERE catalog = 'asset-library';
END;

CREATE TRIGGER asset_library_revision_reviews_insert
AFTER INSERT ON human_reviews BEGIN
  UPDATE media_catalog_revisions SET revision = revision + 1
    WHERE catalog = 'asset-library';
END;

CREATE TRIGGER asset_library_revision_reviews_update
AFTER UPDATE ON human_reviews BEGIN
  UPDATE media_catalog_revisions SET revision = revision + 1
    WHERE catalog = 'asset-library';
END;

CREATE TRIGGER asset_library_revision_reviews_delete
AFTER DELETE ON human_reviews BEGIN
  UPDATE media_catalog_revisions SET revision = revision + 1
    WHERE catalog = 'asset-library';
END;

CREATE TRIGGER asset_library_revision_decisions_insert
AFTER INSERT ON human_review_decisions BEGIN
  UPDATE media_catalog_revisions SET revision = revision + 1
    WHERE catalog = 'asset-library';
END;

CREATE TRIGGER asset_library_revision_decisions_update
AFTER UPDATE ON human_review_decisions BEGIN
  UPDATE media_catalog_revisions SET revision = revision + 1
    WHERE catalog = 'asset-library';
END;

CREATE TRIGGER asset_library_revision_decisions_delete
AFTER DELETE ON human_review_decisions BEGIN
  UPDATE media_catalog_revisions SET revision = revision + 1
    WHERE catalog = 'asset-library';
END;

CREATE TRIGGER asset_library_revision_run_status
AFTER UPDATE OF status ON runs
WHEN OLD.status IS NOT NEW.status BEGIN
  UPDATE media_catalog_revisions SET revision = revision + 1
    WHERE catalog = 'asset-library';
END;

CREATE TRIGGER run_library_revision_runs_insert
AFTER INSERT ON runs BEGIN
  UPDATE media_catalog_revisions SET revision = revision + 1
    WHERE catalog = 'run-library';
END;

CREATE TRIGGER run_library_revision_runs_delete
AFTER DELETE ON runs BEGIN
  UPDATE media_catalog_revisions SET revision = revision + 1
    WHERE catalog = 'run-library';
END;
