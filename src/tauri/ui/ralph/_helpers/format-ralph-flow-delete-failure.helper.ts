const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message.trim() : String(error).trim();

export const formatRalphFlowDeleteFailure = (
  flowName: string,
  error: unknown,
): string => {
  const message = getErrorMessage(error);

  if (message.includes("Ralph flow CAS conflict")) {
    return `Ralph flow "${flowName}" changed. Refresh the flow list, then delete it again.`;
  }

  if (message.includes("was not found")) {
    return `Ralph flow "${flowName}" no longer exists. Refresh the flow list.`;
  }

  return message
    ? `Could not delete Ralph flow "${flowName}": ${message}`
    : `Could not delete Ralph flow "${flowName}". Try again.`;
};
