ALTER TABLE cloud_favorites DROP CONSTRAINT cloud_favorites_kind_check;
ALTER TABLE cloud_favorites ADD CONSTRAINT cloud_favorites_kind_check CHECK (kind IN ('issue','project','cycle','view'));
