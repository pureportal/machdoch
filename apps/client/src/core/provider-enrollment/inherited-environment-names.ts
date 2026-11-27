import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MACHDOCH_ENVIRONMENT_PREFIX = "MACHDOCH_";

const WINDOWS_ENVIRONMENT_REGISTRY_KEYS = [
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  "HKCU\\Environment",
  "HKCU\\Volatile Environment",
] as const;

const WINDOWS_SYSTEM_DEFINED_ENVIRONMENT_NAMES = [
  "ALLUSERSPROFILE",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "COMPUTERNAME",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "PUBLIC",
  "SystemDrive",
  "SystemRoot",
] as const;

const REGISTRY_VALUE_PATTERN = /^ {4}(\S.*?) {4}REG_[A-Z_]+(?: {4}|$)/u;

const isMissingRegistryKeyError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === 1 &&
  "stderr" in error &&
  typeof error.stderr === "string" &&
  /unable to find/iu.test(error.stderr);

const readRegistryValueNames = async (key: string): Promise<string[]> => {
  try {
    const { stdout } = await execFileAsync("reg.exe", ["query", key], {
      encoding: "utf8",
      windowsHide: true,
    });
    return stdout.split(/\r?\n/u).flatMap((line) => {
      const name = REGISTRY_VALUE_PATTERN.exec(line)?.[1];
      return name ? [name] : [];
    });
  } catch (error) {
    if (isMissingRegistryKeyError(error)) return [];
    throw new Error(`Could not read the Windows environment from ${key}.`, {
      cause: error,
    });
  }
};

const normalizeEnvironmentNames = (names: readonly string[]): string[] => {
  const unique = new Map<string, string>();
  for (const name of names) {
    const canonical =
      process.platform === "win32" ? name.toLocaleUpperCase("en-US") : name;
    if (canonical.toLocaleUpperCase("en-US").startsWith(MACHDOCH_ENVIRONMENT_PREFIX)) {
      continue;
    }
    if (!unique.has(canonical)) unique.set(canonical, name);
  }
  return [...unique.values()].sort();
};

export const listInheritedEnvironmentNames = async (
  processEnvironment: Record<string, string>,
): Promise<string[]> => {
  if (process.platform !== "win32") {
    return normalizeEnvironmentNames(Object.keys(processEnvironment));
  }
  const registryNames = await Promise.all(
    WINDOWS_ENVIRONMENT_REGISTRY_KEYS.map(readRegistryValueNames),
  );
  return normalizeEnvironmentNames([
    ...WINDOWS_SYSTEM_DEFINED_ENVIRONMENT_NAMES,
    ...registryNames.flat(),
  ]);
};
