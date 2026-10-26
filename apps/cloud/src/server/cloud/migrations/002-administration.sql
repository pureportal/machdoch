ALTER TABLE cloud_organizations ADD COLUMN accent text NOT NULL DEFAULT 'sky' CHECK (accent IN ('sky','violet','emerald','amber','rose'));
ALTER TABLE cloud_memberships ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE cloud_memberships ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);
