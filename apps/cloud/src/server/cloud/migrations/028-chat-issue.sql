ALTER TABLE cloud_chats ADD COLUMN issue_id uuid;
ALTER TABLE cloud_chats ADD CONSTRAINT cloud_chat_issue FOREIGN KEY (organization_id,issue_id) REFERENCES cloud_issues(organization_id,id);
