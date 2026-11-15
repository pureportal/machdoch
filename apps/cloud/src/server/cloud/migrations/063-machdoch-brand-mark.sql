UPDATE cloud_organizations
  SET brand=jsonb_set(brand, '{mark}', '"machdoch"')
  WHERE brand->>'mark'='icon' AND brand->>'icon'='command';
ALTER TABLE cloud_organizations
  ALTER COLUMN brand SET DEFAULT '{"color":"#7bc8ef","gradient":null,"mark":"machdoch","icon":"command","initials":"","shape":"rounded","tintedSidebar":false,"signIn":false}'::jsonb;
