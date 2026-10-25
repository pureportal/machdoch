ALTER TABLE cloud_execution_workers ADD COLUMN workspace_binding jsonb CHECK (workspace_binding IS NULL OR jsonb_typeof(workspace_binding)='object');
ALTER TABLE cloud_outbox ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE cloud_outbox ADD COLUMN worker_id uuid;
ALTER TABLE cloud_outbox ADD FOREIGN KEY (organization_id,worker_id) REFERENCES cloud_execution_workers(organization_id,id);
ALTER TABLE cloud_outbox ADD CONSTRAINT cloud_outbox_actor CHECK ((actor_id IS NOT NULL)::integer+(worker_id IS NOT NULL)::integer=1);
