export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

/** A service configuration failure must not trigger an endless supervisor restart loop. */
export class CliConfigurationError extends Error {
  readonly exitCode = 78;
}

export const isBrokenPipeError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "EPIPE";

export const hasJsonOutputFlag = (argv: readonly string[]): boolean => {
  const optionTerminator = argv.indexOf("--");
  const options = optionTerminator < 0 ? argv : argv.slice(0, optionTerminator);
  return options.includes("--json");
};
