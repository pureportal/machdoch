ALTER TABLE cloud_organizations RENAME COLUMN logo TO logo_dark;
ALTER TABLE cloud_organizations
  ADD COLUMN logo_light text CHECK (length(logo_light) <= 60000);
