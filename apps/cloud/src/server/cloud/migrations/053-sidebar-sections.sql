UPDATE cloud_sidebar_preferences
SET preferences=jsonb_set(preferences,'{items}',COALESCE((SELECT jsonb_agg(item) FROM jsonb_array_elements(preferences->'items') item WHERE NOT item->>'id' = ANY(ARRAY['roadmap','tasks','schedules','workspaces','enrollment','profiles','privacy','execution'])),'[]'::jsonb)),updated_at=clock_timestamp()
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(preferences->'items') item WHERE item->>'id' = ANY(ARRAY['roadmap','tasks','schedules','workspaces','enrollment','profiles','privacy','execution']));
