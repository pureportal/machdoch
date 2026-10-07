export function prepareRpmExecutable(executable) {
  const marker = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK");
  const offset = executable.indexOf(marker);
  if (offset < 0 || executable.indexOf(marker, offset + marker.length) >= 0) {
    throw new Error("Expected one unbundled Tauri executable marker");
  }
  const result = Buffer.from(executable);
  result.write("__TAURI_BUNDLE_TYPE_VAR_RPM", offset, "utf8");
  return result;
}
