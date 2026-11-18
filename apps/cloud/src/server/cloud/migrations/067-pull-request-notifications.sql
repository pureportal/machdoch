ALTER TABLE cloud_notifications DROP CONSTRAINT cloud_notifications_kind_check;
ALTER TABLE cloud_notifications ADD CONSTRAINT cloud_notifications_kind_check CHECK (kind IN ('assigned','commented','mentioned','task_finished','status_changed','pull_request'));
