export const extractRalphInterviewJsonObject = (text: string): unknown => {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  const candidate = fencedMatch?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate) as unknown;
  } catch (error) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");

    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1)) as unknown;
    }

    throw new SyntaxError(
      `Interview AI response did not contain valid JSON. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
};
