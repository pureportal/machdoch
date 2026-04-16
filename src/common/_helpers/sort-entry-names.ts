export const sortEntryNames = (left: string, right: string): number => {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
};
