import { stripVTControlCharacters } from "node:util";

export interface RalphVerificationDiagnostic {
  category: string;
  message: string;
  retryCondition: string;
}

export const diagnoseRalphEmptyVerification = (
  output: string,
): RalphVerificationDiagnostic | undefined => {
  const counts = [
    ...output.matchAll(/^\s*(?:Ran|running) (\d+) tests?\b/gmu),
  ].map((match) => Number(match[1]));
  if (counts.length === 0 || counts.some((count) => count > 0)) {
    return undefined;
  }
  return {
    category: "empty-verification",
    message: "The selected verification command ran no tests.",
    retryCondition:
      "Select a test command that exercises the task's business logic.",
  };
};

export const diagnoseRalphVerificationFailure = (
  output: string,
): RalphVerificationDiagnostic | undefined => {
  if (
    /Unable to find libclang|libclang (?:was not found|is missing)|libclang\.dll is missing/iu.test(
      output,
    )
  ) {
    return {
      category: "missing-libclang",
      message: "Native verification requires a usable libclang installation.",
      retryCondition:
        "Install LLVM and set LIBCLANG_PATH to its bin directory.",
    };
  }
  if (
    /WHISPER_DONT_GENERATE_BINDINGS|bindings\.rs[\s\S]*(?:12_usize - 16_usize|208_usize - 216_usize)/u.test(
      output,
    )
  ) {
    return {
      category: "invalid-native-bindings",
      message: "Native verification is using bindings for the wrong target.",
      retryCondition:
        "Remove WHISPER_DONT_GENERATE_BINDINGS and regenerate bindings with libclang for the current target.",
    };
  }
  if (
    /Python was not found|Python verification runtime is unavailable|python[^\n]*Microsoft Store|No module named (?:pytest|unittest)/iu.test(
      output,
    )
  ) {
    return {
      category: "python-unavailable",
      message: "The Python verification runtime is unavailable.",
      retryCondition:
        "Install the selected Python runtime and its test dependencies.",
    };
  }
  if (
    /CMake is required|Visual Studio C\+\+ (?:Build Tools|x64 compiler) (?:are|is) required|CMAKE_C_COMPILER[^\n]*not found/iu.test(
      output,
    )
  ) {
    return {
      category: "native-toolchain-unavailable",
      message: "The native build toolchain is unavailable.",
      retryCondition: "Install CMake and the Visual Studio C++ build tools.",
    };
  }
  if (
    /LNK110[45][^\n]*(?:\.exe|\.dll)|error 1224|being used by another process/iu.test(
      output,
    )
  ) {
    return {
      category: "native-artifact-contention",
      message: "Another process is holding a native build artifact.",
      retryCondition:
        "Stop the process holding the artifact before retrying verification.",
    };
  }
  if (
    /not recognized as (?:the name|an internal)|command not found|No tests? (?:were )?found|no tests ran/iu.test(
      output,
    )
  ) {
    return {
      category: "verification-unavailable",
      message: "The selected verification command could not run its checks.",
      retryCondition:
        "Provide an installed command that exercises the selected task.",
    };
  }
  return undefined;
};

export const normalizeRalphFailureDiagnosticText = (value: string): string =>
  stripVTControlCharacters(value)
    .replace(
      /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu,
      "<timestamp>",
    )
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu,
      "<uuid>",
    )
    .replace(/(thread '[^']+' )\(\d+\)( panicked)/gu, "$1(<pid>)$2")
    .replace(/\b(?:pid|process id)[=: ]+\d+\b/giu, "pid=<pid>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|seconds?|secs?)\b/giu, "<duration>");
