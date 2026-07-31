const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const withoutObjectPath = <Value extends object>(
  value: Value,
  path: readonly string[],
): Value => {
  if (path.length === 0) return value;

  const [key, ...remaining] = path;
  if (!key || !Object.prototype.hasOwnProperty.call(value, key)) return value;

  const next = { ...value } as Record<string, unknown>;
  if (remaining.length === 0) {
    delete next[key];
    return next as Value;
  }

  const child = next[key];
  if (!isRecord(child)) return value;

  const nextChild = withoutObjectPath(child, remaining);
  if (Object.keys(nextChild).length === 0) {
    delete next[key];
  } else {
    next[key] = nextChild;
  }

  return next as Value;
};
