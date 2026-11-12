UPDATE cloud_saved_views
SET filters = (filters - 'statusId' - 'assigneeId' - 'labelId' - 'projectId' - 'cycleId')
  || jsonb_strip_nulls(jsonb_build_object(
    'status', filters->'statusId',
    'assignee', filters->'assigneeId',
    'label', filters->'labelId',
    'project', filters->'projectId',
    'cycle', filters->'cycleId'))
WHERE filters ?| array['statusId','assigneeId','labelId','projectId','cycleId'];
