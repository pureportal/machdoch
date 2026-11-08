const INVALID_BRANCH_CHARACTERS = /[~^:?*[\\]/u;

const hasControlOrSpaceCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x20 || code === 0x7f;
  });

export const isValidGitBranchName = (name: string): boolean =>
  name.length > 0 &&
  name.length <= 255 &&
  name !== "@" &&
  name !== "HEAD" &&
  !name.startsWith("-") &&
  !name.endsWith(".") &&
  !name.includes("..") &&
  !name.includes("@{") &&
  !INVALID_BRANCH_CHARACTERS.test(name) &&
  !hasControlOrSpaceCharacter(name) &&
  name
    .split("/")
    .every(
      (component) =>
        component.length > 0 &&
        !component.startsWith(".") &&
        !component.endsWith(".lock"),
    );
