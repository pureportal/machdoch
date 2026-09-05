export const normalizeLocalCommandCwd = (
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string => {
  if (platform !== "win32") {
    return cwd;
  }

  const uncMatch = /^\\\\[?.]\\UNC\\/iu.exec(cwd);

  if (uncMatch) {
    return `\\\\${cwd.slice(uncMatch[0].length)}`;
  }

  const namespaceMatch = /^\\\\[?.]\\/u.exec(cwd);

  if (!namespaceMatch) {
    return cwd;
  }

  const withoutPrefix = cwd.slice(namespaceMatch[0].length);

  return /^[a-z]:[\\/]/i.test(withoutPrefix) ? withoutPrefix : cwd;
};
