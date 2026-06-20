export const normalizeModelId = (model: string | null | undefined): string =>
  model?.trim().toLowerCase() ?? "";
