import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLEET_SERVICE_NAME,
  manageFleetService,
  renderFleetUserService,
  type FleetServiceDependencies,
} from "./fleet-service.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-systemd-"));
  roots.push(root);
  const execute = vi.fn(async (_command: string, _args: string[]) => ({
    stdout: "",
  }));
  const dependencies: FleetServiceDependencies = {
    platform: "linux",
    uid: 1000,
    home: root,
    configHome: join(root, "xdg"),
    configDirectory: () => join(root, "config"),
    enabled: async () => true,
    launch: () => ({
      command: process.execPath,
      args: [join(root, "cli.cjs")],
      cwd: root,
      environment: { OPENAI_API_KEY: "never-copy-me" },
    }),
    execute,
  };
  const unitPath = join(
    dependencies.configHome,
    "systemd",
    "user",
    FLEET_SERVICE_NAME,
  );
  return { root, dependencies, execute, unitPath };
};

describe("Fleet systemd management", () => {
  it("escapes systemd expansion and excludes credentials and relative PATH entries", () => {
    const unit = renderFleetUserService({
      launch: {
        command: "/opt/node",
        args: ['/opt/Mach doch/%i/$HOME/cli".cjs'],
        cwd: "/",
        environment: { SECRET: "hidden" },
      },
      workspaceRoot: "/work/$HOME/%n",
      configDirectory: "/home/test/config",
      homeDirectory: "/home/test",
      executablePath: "/opt/tools:.:relative:/usr/bin:/opt/tools",
    });
    expect(unit).toContain('"/opt/Mach doch/%%i/$$HOME/cli\\".cjs"');
    expect(unit).toContain('"/work/$$HOME/%%n" "--json"');
    expect(unit).toContain(
      "EnvironmentFile=-/home/test/config/fleet-service.env",
    );
    expect(unit).toContain("WorkingDirectory=/work/$HOME/%%n/");
    expect(unit).toContain("PATH=/opt/tools:/usr/bin:/usr/local/bin:/bin");
    expect(unit).not.toMatch(/hidden|relative/u);
    expect(unit).toContain("RestartPreventExitStatus=78");
    expect(unit).toContain("KillMode=mixed");
  });

  it("rejects newline injection", () => {
    expect(() =>
      renderFleetUserService({
        launch: {
          command: "/usr/bin/node",
          args: ["cli\nExecStart=bad"],
          cwd: "/",
          environment: {},
        },
        workspaceRoot: "/work",
        configDirectory: "/config",
        homeDirectory: "/home/test",
      }),
    ).toThrow(/control characters/u);
  });

  it("previews without invoking systemctl and installs an enabled service", async () => {
    const { root, dependencies, execute, unitPath } = await fixture();
    const preview = await manageFleetService("unit", root, dependencies);
    expect(preview.unit).toContain("fleet");
    expect(execute).not.toHaveBeenCalled();
    await manageFleetService("install", root, dependencies);
    expect(await readFile(unitPath, "utf8")).toBe(preview.unit);
    expect(execute.mock.calls.map(([, args]) => args)).toEqual([
      ["--user", "show-environment"],
      ["--user", "daemon-reload"],
      ["--user", "enable", FLEET_SERVICE_NAME],
      ["--user", "restart", FLEET_SERVICE_NAME],
    ]);
    expect(await readFile(unitPath, "utf8")).not.toContain("never-copy-me");
  });

  it("does not overwrite an administrator's unit", async () => {
    const { root, dependencies, execute, unitPath } = await fixture();
    await mkdir(join(dependencies.configHome, "systemd/user"), {
      recursive: true,
    });
    await writeFile(unitPath, "[Service]\nExecStart=/custom\n");
    await expect(
      manageFleetService("install", root, dependencies),
    ).rejects.toThrow(/managed outside/u);
    await expect(
      manageFleetService("uninstall", root, dependencies),
    ).rejects.toThrow(/managed outside/u);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rolls back a failed first installation", async () => {
    const { root, dependencies, execute, unitPath } = await fixture();
    execute.mockImplementation(async (_command, args) => {
      if (args.includes("restart")) throw new Error("start failed");
      return { stdout: "" };
    });
    await expect(
      manageFleetService("install", root, dependencies),
    ).rejects.toThrow("start failed");
    await expect(readFile(unitPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(execute).toHaveBeenCalledWith("systemctl", [
      "--user",
      "disable",
      "--now",
      FLEET_SERVICE_NAME,
    ]);
  });

  it("restores the previous owned unit when an update fails", async () => {
    const { root, dependencies, execute, unitPath } = await fixture();
    await manageFleetService("install", root, dependencies);
    const old = await readFile(unitPath, "utf8");
    execute.mockImplementation(async (_command, args) => {
      if (args.includes("restart")) throw new Error("start failed");
      return { stdout: "" };
    });
    await expect(
      manageFleetService("install", root, {
        ...dependencies,
        configDirectory: () => join(root, "different"),
      }),
    ).rejects.toThrow();
    expect(await readFile(unitPath, "utf8")).toBe(old);
  });

  it("uninstalls idempotently and keeps enrollment data", async () => {
    const { root, dependencies, unitPath } = await fixture();
    await manageFleetService("install", root, dependencies);
    await mkdir(dependencies.configDirectory(), { recursive: true });
    const enrollment = join(
      dependencies.configDirectory(),
      "fleet-connection.json",
    );
    await writeFile(enrollment, "keep");
    await manageFleetService("uninstall", root, dependencies);
    await manageFleetService("uninstall", root, dependencies);
    await expect(readFile(unitPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(enrollment, "utf8")).toBe("keep");
  });

  it("reports service and lingering state", async () => {
    const { root, dependencies, execute } = await fixture();
    execute.mockImplementation(async (command) => ({
      stdout:
        command === "loginctl"
          ? "yes\n"
          : "LoadState=loaded\nActiveState=active\nMainPID=123\n",
    }));
    expect(
      await manageFleetService("status", root, dependencies),
    ).toMatchObject({ ActiveState: "active", MainPID: "123", linger: "yes" });
  });

  it("requires enrollment and a non-root Linux service account", async () => {
    const { root, dependencies, execute } = await fixture();
    await expect(
      manageFleetService("install", root, {
        ...dependencies,
        enabled: async () => false,
      }),
    ).rejects.toThrow(/Enroll/u);
    await expect(
      manageFleetService("install", root, { ...dependencies, uid: 0 }),
    ).rejects.toThrow(/regular service account/u);
    await expect(
      manageFleetService("install", root, {
        ...dependencies,
        platform: "win32",
      }),
    ).rejects.toThrow(/tray/u);
    expect(execute).not.toHaveBeenCalled();
  });
});
