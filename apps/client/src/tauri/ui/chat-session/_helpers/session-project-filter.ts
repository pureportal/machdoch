import {
  ALL_SESSION_PROJECTS_FILTER,
  type SessionProjectFilter,
} from "@machdoch/product-ui";

export const DEFAULT_SESSION_PROJECT_FILTER: SessionProjectFilter = {
  mode: "include",
  projectIds: [],
};

export const matchesSessionProjectFilter = (
  filter: SessionProjectFilter,
  projectId: string,
): boolean => {
  if (filter.projectIds.length === 0) {
    return true;
  }

  return filter.projectIds.includes(projectId) === (filter.mode === "include");
};

export const toggleSessionProjectFilterProject = (
  filter: SessionProjectFilter,
  projectId: string,
): SessionProjectFilter => {
  if (projectId === ALL_SESSION_PROJECTS_FILTER) {
    return { ...filter, projectIds: [] };
  }

  return {
    ...filter,
    projectIds: filter.projectIds.includes(projectId)
      ? filter.projectIds.filter((selectedId) => selectedId !== projectId)
      : [...filter.projectIds, projectId],
  };
};

export const retainAvailableSessionProjects = (
  filter: SessionProjectFilter,
  availableProjectIds: ReadonlySet<string>,
): SessionProjectFilter => {
  const projectIds = filter.projectIds.filter((projectId) =>
    availableProjectIds.has(projectId),
  );

  return projectIds.length === filter.projectIds.length
    ? filter
    : { ...filter, projectIds };
};
