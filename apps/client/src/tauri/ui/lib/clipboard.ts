export const copyText = async (value: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    throw new Error("Could not copy. Check clipboard access and try again.");
  }
};
