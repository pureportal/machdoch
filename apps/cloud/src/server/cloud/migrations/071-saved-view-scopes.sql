ALTER TABLE cloud_saved_views ADD COLUMN description text NOT NULL DEFAULT '' CHECK (length(description) <= 500);
ALTER TABLE cloud_saved_views ADD COLUMN icon text NOT NULL DEFAULT 'bookmark' CHECK (icon ~ '^[a-z][a-z-]{0,39}$');
ALTER TABLE cloud_saved_views ADD COLUMN scope text NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal','team','workspace'));
ALTER TABLE cloud_saved_views ADD COLUMN team_id uuid;
ALTER TABLE cloud_saved_views ADD CONSTRAINT cloud_saved_views_team_fk FOREIGN KEY (organization_id,team_id) REFERENCES cloud_teams(organization_id,id) ON DELETE CASCADE;
ALTER TABLE cloud_saved_views ADD CONSTRAINT cloud_saved_views_team_scope CHECK ((scope = 'team') = (team_id IS NOT NULL));
UPDATE cloud_saved_views SET scope = 'workspace' WHERE shared;
DROP INDEX cloud_saved_views_shared;
ALTER TABLE cloud_saved_views DROP COLUMN shared;
CREATE INDEX cloud_saved_views_scope ON cloud_saved_views(organization_id,scope,team_id) WHERE scope <> 'personal';

CREATE TABLE cloud_team_pinned_views (
  organization_id uuid NOT NULL,
  team_id uuid NOT NULL,
  view_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (organization_id,team_id,view_id),
  UNIQUE (organization_id,team_id,position) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (organization_id,team_id) REFERENCES cloud_teams(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,view_id) REFERENCES cloud_saved_views(organization_id,id) ON DELETE CASCADE
);
CREATE INDEX cloud_team_pinned_views_view ON cloud_team_pinned_views(organization_id,view_id);
