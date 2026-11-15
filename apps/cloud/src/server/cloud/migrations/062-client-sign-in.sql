ALTER TABLE cloud_oauth_requests ADD COLUMN client_name text CHECK (client_name IS NULL OR length(client_name) BETWEEN 1 AND 80);
