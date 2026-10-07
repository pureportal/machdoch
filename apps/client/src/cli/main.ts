#!/usr/bin/env node

import process from "node:process";
import { runCli } from "./app.js";
import {
  CliUsageError,
  CliConfigurationError,
  hasJsonOutputFlag,
  isBrokenPipeError,
  formatCliErrorMessage,
} from "./_helpers/cli-error.js";
import { createCliStyle } from "./_helpers/cli-terminal.js";

const retainRalphExecution = Boolean(process.env.MACHDOCH_RALPH_CANCEL_PATH?.trim());

const handleStreamError = (error: unknown): void => {
  if (isBrokenPipeError(error)) {
    if (!retainRalphExecution) process.exit(0);
    return;
  }

  throw error;
};

process.stdout.on("error", handleStreamError);
process.stderr.on("error", handleStreamError);

const exitAfterOutputFlush = async (): Promise<never> => {
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) =>
        new Promise<void>((resolve, reject) => {
          if (retainRalphExecution && isBrokenPipeError(stream.errored)) {
            resolve();
            return;
          }
          stream.write("", (error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  process.exit();
};

runCli(process.argv.slice(2))
  .then(async (command) => {
    if (command === "run") await exitAfterOutputFlush();
    if (process.stdin.isTTY) process.stdin.unref();
  })
  .catch(async (error: unknown) => {
    const message = formatCliErrorMessage(error);
    const usageError = error instanceof CliUsageError;
    const exitCode =
      error instanceof CliConfigurationError
        ? error.exitCode
        : usageError
          ? 2
          : 1;

    if (hasJsonOutputFlag(process.argv.slice(2))) {
      process.stderr.write(`${JSON.stringify({ error: message, exitCode })}\n`);
    } else {
      const style = createCliStyle({ isTTY: process.stderr.isTTY === true });
      process.stderr.write(`${style.error("Error:")} ${message}\n`);
      if (usageError) {
        process.stderr.write(
          `${style.muted("Run `machdoch help` or `machdoch help <command>` for usage.")}\n`,
        );
      }
    }

    process.exitCode = exitCode;
    await exitAfterOutputFlush();
  });
