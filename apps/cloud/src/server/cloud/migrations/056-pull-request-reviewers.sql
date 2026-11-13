ALTER TABLE cloud_git_pull_requests ADD COLUMN requested_reviewers text[] NOT NULL DEFAULT '{}' CHECK (cardinality(requested_reviewers) <= 50);
CREATE INDEX cloud_git_pull_requests_reviewers ON cloud_git_pull_requests USING gin (requested_reviewers) WHERE state = 'open';
CREATE INDEX cloud_git_pull_requests_author ON cloud_git_pull_requests(organization_id, lower(author));
