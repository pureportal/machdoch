import {
  sameFileObjectIdentity,
  sameFileSnapshotIdentity,
} from "./same-file-identity.helper.js";

describe("same file identity", () => {
  it("accepts Node 22's missing Windows path device for the same file id", () => {
    expect(
      sameFileObjectIdentity(
        { dev: 0, ino: 42 },
        { dev: 2_631_681_379, ino: 42 },
        "win32",
      ),
    ).toBe(true);
  });

  it("still rejects a different Windows file id or known device", () => {
    expect(
      sameFileObjectIdentity(
        { dev: 0, ino: 41 },
        { dev: 2_631_681_379, ino: 42 },
        "win32",
      ),
    ).toBe(false);
    expect(
      sameFileObjectIdentity(
        { dev: 1, ino: 42 },
        { dev: 2, ino: 42 },
        "win32",
      ),
    ).toBe(false);
  });

  it("does not ignore a zero device on non-Windows platforms", () => {
    expect(
      sameFileObjectIdentity(
        { dev: 0, ino: 42 },
        { dev: 2, ino: 42 },
        "linux",
      ),
    ).toBe(false);
  });

  it("requires size and modification time for a matching snapshot", () => {
    expect(
      sameFileSnapshotIdentity(
        { dev: 0, ino: 42, size: 10, mtimeMs: 1 },
        { dev: 2, ino: 42, size: 11, mtimeMs: 1 },
        "win32",
      ),
    ).toBe(false);
    expect(
      sameFileSnapshotIdentity(
        { dev: 0, ino: 42, size: 10, mtimeMs: 1 },
        { dev: 2, ino: 42, size: 10, mtimeMs: 2 },
        "win32",
      ),
    ).toBe(false);
  });
});
