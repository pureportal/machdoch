export const normalizeChatSessionOptionalString = (
  value: unknown,
): string | undefined => {
  return typeof value === "string" ? value : undefined;
};
