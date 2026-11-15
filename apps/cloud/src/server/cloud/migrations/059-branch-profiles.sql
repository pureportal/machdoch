UPDATE cloud_runs SET state='failed',stop_reason='failed',stop_message='Execution settings changed. Start the task again.',revision=revision+1
WHERE state NOT IN ('succeeded','failed','canceled','timed_out') AND manifest->'profile' ? 'baseCommit';

UPDATE cloud_runs SET
  base_commit=manifest->'profile'->>'baseCommit',
  manifest=jsonb_set(
    jsonb_set(manifest #- '{profile,baseCommit}','{profile,autopilot}','false'::jsonb),
    '{branch}','null'::jsonb)
WHERE manifest->'profile' ? 'baseCommit';

UPDATE cloud_execution_profiles SET definition=(definition - 'baseCommit') || '{"autopilot":false}'::jsonb
WHERE definition ? 'baseCommit';

CREATE UNIQUE INDEX cloud_execution_profiles_autopilot ON cloud_execution_profiles(organization_id,project_id)
WHERE (definition->>'autopilot')::boolean;
