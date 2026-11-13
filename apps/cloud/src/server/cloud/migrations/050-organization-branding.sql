ALTER TABLE cloud_organizations
  ADD COLUMN brand jsonb,
  ADD COLUMN logo text CHECK (length(logo) <= 60000);
UPDATE cloud_organizations SET brand=jsonb_build_object(
  'color', CASE accent WHEN 'violet' THEN '#a79bff' WHEN 'emerald' THEN '#73d7b1' WHEN 'amber' THEN '#e9c074' WHEN 'rose' THEN '#f59db3' ELSE '#7bc8ef' END,
  'gradient', null,
  'mark', 'icon',
  'icon', 'command',
  'initials', '',
  'shape', 'rounded',
  'tintedSidebar', false,
  'signIn', false
);
ALTER TABLE cloud_organizations
  ALTER COLUMN brand SET DEFAULT '{"color":"#7bc8ef","gradient":null,"mark":"icon","icon":"command","initials":"","shape":"rounded","tintedSidebar":false,"signIn":false}'::jsonb,
  ALTER COLUMN brand SET NOT NULL,
  ADD CHECK (jsonb_typeof(brand)='object'),
  DROP COLUMN accent;
