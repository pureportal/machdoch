import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface MachdochCliLaunch {
  command: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
}

interface MachdochCliRuntime {
  execPath: string;
  execArgv: readonly string[];
  argv: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
}

const assertLaunchValue = (value: string, label: string): void => {
  if (
    value.trim().length === 0 ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n") ||
    value.includes("\t")
  ) {
    throw new Error(`The Machdoch CLI ${label} is unavailable or invalid.`);
  }
};

const assertRegularFile = (path: string, label: string): void => {
  try {
    if (statSync(path).isFile()) return;
  } catch (error) {
    throw new Error(`The Machdoch CLI ${label} does not exist: ${path}`, {
      cause: error,
    });
  }
  throw new Error(`The Machdoch CLI ${label} is not a regular file: ${path}`);
};

const resolveNodePreloadSpecifier = (
  specifier: string,
  entry: string,
  asImport: boolean,
): string => {
  if (
    isAbsolute(specifier) ||
    /^(?:node|data|file):/u.test(specifier)
  ) {
    return specifier;
  }
  try {
    const resolved = createRequire(entry).resolve(specifier);
    return asImport ? pathToFileURL(resolved).href : resolved;
  } catch (error) {
    throw new Error(
      `The Machdoch CLI Node preload module cannot be resolved from ${entry}: ${specifier}`,
      { cause: error },
    );
  }
};

const resolveNodePreloadArguments = (
  args: readonly string[],
  entry: string,
): string[] => {
  const resolved: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    const separatedImport =
      argument === "--import" ||
      argument === "--loader" ||
      argument === "--experimental-loader";
    const separatedRequire = argument === "--require" || argument === "-r";
    if (separatedImport || separatedRequire) {
      const specifier = args[index + 1];
      if (specifier === undefined) {
        throw new Error(`The Machdoch CLI Node option ${argument} has no value.`);
      }
      resolved.push(
        argument,
        resolveNodePreloadSpecifier(specifier, entry, separatedImport),
      );
      index += 1;
      continue;
    }
    const inlineMatch =
      /^(--import|--loader|--experimental-loader|--require)=(.+)$/u.exec(
        argument,
      );
    if (inlineMatch) {
      const flag = inlineMatch[1] ?? "";
      const specifier = inlineMatch[2] ?? "";
      resolved.push(
        `${flag}=${resolveNodePreloadSpecifier(
          specifier,
          entry,
          flag !== "--require",
        )}`,
      );
      continue;
    }
    resolved.push(argument);
  }
  return resolved;
};

export const assertMachdochCliLaunch = (
  launch: MachdochCliLaunch,
): MachdochCliLaunch => {
  assertLaunchValue(launch.command, "runtime executable");
  assertLaunchValue(launch.cwd, "working directory");
  for (const argument of launch.args) {
    if (argument.includes("\0")) {
      throw new Error("The Machdoch CLI launch arguments contain a null byte.");
    }
  }
  for (const [key, value] of Object.entries(launch.environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new Error(
        `The Machdoch CLI launch environment key is invalid: ${key}`,
      );
    }
    assertLaunchValue(value, `launch environment value for ${key}`);
  }
  return {
    command: launch.command,
    args: [...launch.args],
    cwd: launch.cwd,
    environment: { ...launch.environment },
  };
};

export const resolveMachdochCliLaunch = (
  runtime: MachdochCliRuntime = {
    execPath: process.execPath,
    execArgv: process.execArgv,
    argv: process.argv,
    cwd: process.cwd(),
    environment: process.env,
  },
): MachdochCliLaunch => {
  const cwd = resolve(runtime.cwd);
  const command = isAbsolute(runtime.execPath)
    ? resolve(runtime.execPath)
    : resolve(cwd, runtime.execPath);
  const rawEntry = runtime.argv[1];
  if (rawEntry === undefined) {
    throw new Error(
      "The running Machdoch CLI has no entry script, so MCP proxy commands cannot be generated.",
    );
  }
  assertLaunchValue(rawEntry, "entry script");
  const entry = isAbsolute(rawEntry)
    ? resolve(rawEntry)
    : resolve(cwd, rawEntry);
  assertRegularFile(command, "runtime executable");
  assertRegularFile(entry, "entry script");

  const userConfigDirectory =
    runtime.environment.MACHDOCH_USER_CONFIG_DIR?.trim();
  return assertMachdochCliLaunch({
    command,
    args: [...resolveNodePreloadArguments(runtime.execArgv, entry), entry],
    cwd,
    environment: userConfigDirectory
      ? { MACHDOCH_USER_CONFIG_DIR: resolve(cwd, userConfigDirectory) }
      : {},
  });
};
