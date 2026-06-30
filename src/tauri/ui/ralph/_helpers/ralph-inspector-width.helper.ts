export const RALPH_INSPECTOR_STORAGE_KEY = "machdoch.ralph.inspector-width";
export const RALPH_INSPECTOR_MIN_WIDTH = 352;
export const RALPH_INSPECTOR_DEFAULT_WIDTH = 448;
export const RALPH_INSPECTOR_MAX_WIDTH = 704;
export const RALPH_INSPECTOR_SCROLL_EPSILON = 4;

export const clampRalphInspectorWidth = (
  value: number,
  viewportWidth = typeof window === "undefined" ? undefined : window.innerWidth,
): number => {
  const viewportMax =
    typeof viewportWidth === "number" && Number.isFinite(viewportWidth)
      ? Math.max(
          RALPH_INSPECTOR_MIN_WIDTH,
          Math.floor(viewportWidth * 0.48),
        )
      : RALPH_INSPECTOR_MAX_WIDTH;
  const maxWidth = Math.min(RALPH_INSPECTOR_MAX_WIDTH, viewportMax);

  return Math.min(
    maxWidth,
    Math.max(RALPH_INSPECTOR_MIN_WIDTH, Math.round(value)),
  );
};

export const loadRalphInspectorWidth = (): number => {
  if (typeof window === "undefined") {
    return RALPH_INSPECTOR_DEFAULT_WIDTH;
  }

  try {
    const storedWidth = window.localStorage.getItem(RALPH_INSPECTOR_STORAGE_KEY);
    const parsedWidth = storedWidth ? Number.parseInt(storedWidth, 10) : NaN;

    return Number.isFinite(parsedWidth)
      ? clampRalphInspectorWidth(parsedWidth)
      : clampRalphInspectorWidth(RALPH_INSPECTOR_DEFAULT_WIDTH);
  } catch {
    return clampRalphInspectorWidth(RALPH_INSPECTOR_DEFAULT_WIDTH);
  }
};

export const saveRalphInspectorWidth = (width: number): void => {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(RALPH_INSPECTOR_STORAGE_KEY, String(width));
  } catch {
    // Inspector width is a preference; ignore persistence failures.
  }
};
