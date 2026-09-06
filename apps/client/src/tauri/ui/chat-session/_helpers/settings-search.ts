export const matchesSettingsSearch = (text: string, query: string): boolean => {
  const normalize = (value: string): string =>
    value.toLowerCase().replace(/[-&/]/g, " ");
  const searchable = normalize(text);
  return normalize(query)
    .trim()
    .split(/\s+/)
    .every((word) => searchable.includes(word));
};
