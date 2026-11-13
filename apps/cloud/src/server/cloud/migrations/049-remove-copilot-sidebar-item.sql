UPDATE cloud_sidebar_preferences
SET preferences=jsonb_set(preferences,'{items}',COALESCE((SELECT jsonb_agg(item) FROM jsonb_array_elements(preferences->'items') item WHERE item->>'id'<>'copilot'),'[]'::jsonb)),updated_at=clock_timestamp()
WHERE preferences->'items' @> '[{"id":"copilot"}]'::jsonb;
