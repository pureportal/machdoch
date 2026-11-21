function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function shareStructure<Value>(previous: unknown, next: Value): Value {
  if (Object.is(previous, next)) return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(previous)) return next;
    let unchanged = previous.length === next.length;
    const shared = next.map((item: unknown, index) => {
      const reused = shareStructure(previous[index], item);
      if (reused !== previous[index]) unchanged = false;
      return reused;
    });
    return (unchanged ? previous : shared) as Value;
  }
  if (!isRecord(next) || !isRecord(previous)) return next;
  const keys = Object.keys(next);
  let unchanged = keys.length === Object.keys(previous).length;
  const shared: Record<string, unknown> = {};
  for (const key of keys) {
    const reused = shareStructure(previous[key], next[key]);
    if (!Object.hasOwn(previous, key) || reused !== previous[key])
      unchanged = false;
    shared[key] = reused;
  }
  return (unchanged ? previous : shared) as Value;
}
