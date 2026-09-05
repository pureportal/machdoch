import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:https";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

if (process.platform !== "linux")
  throw new Error("Verify the headless package on Linux.");
const archive = resolve(process.argv[2]);
const parent = tmpdir();
const temp = mkdtempSync(join(parent, "machdoch-headless-verify-"));
if (dirname(temp) !== parent)
  throw new Error("Refusing to use an unexpected verification path.");
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
};
try {
  const extracted = run("tar", ["-xzf", archive, "-C", temp]);
  assert.equal(extracted.status, 0, extracted.stderr);
  const root = join(temp, "machdoch");
  const launcher = join(root, "machdoch");
  const env = {
    ...process.env,
    HOME: temp,
    MACHDOCH_USER_CONFIG_DIR: join(temp, "config"),
    DISPLAY: "",
    WAYLAND_DISPLAY: "",
  };
  const help = run(launcher, ["fleet", "--help"], { env });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /fleet service install/u);
  const status = run(launcher, ["fleet", "status", "--json"], { env });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).configured, false);
  mkdirSync(join(temp, "workspace"));
  const unconfigured = run(
    launcher,
    ["fleet", "service", "run", "--cwd", join(temp, "workspace")],
    { env },
  );
  assert.equal(
    unconfigured.status,
    78,
    `${unconfigured.stdout}\n${unconfigured.stderr}`,
  );
  assert.match(unconfigured.stderr, /Enroll/u);
  assert.match(
    readFileSync(join(root, "machdoch-fleet.service"), "utf8"),
    /KillMode=mixed/u,
  );
  // The only external bundle dependency must resolve from the extracted archive.
  const browser = run(process.execPath, ["-e", "require('playwright-core')"], {
    cwd: root,
    env,
  });
  assert.equal(browser.status, 0, browser.stderr);
  const workspace = join(temp, 'workspace %n $HOME "quoted" \\');
  mkdirSync(workspace);
  const unit = run(launcher, ["fleet", "service", "unit", "--cwd", workspace], {
    env,
  });
  assert.equal(unit.status, 0, unit.stderr);
  const unitPath = join(temp, "machdoch-user.service");
  writeFileSync(unitPath, unit.stdout);
  const verify = run("systemd-analyze", ["verify", unitPath]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(verify.stderr.trim(), "", verify.stderr);
  const systemPath = join(temp, "machdoch-system.service");
  writeFileSync(
    systemPath,
    readFileSync(join(root, "machdoch-fleet.service"), "utf8").replace(
      "/opt/machdoch/machdoch fleet",
      `${launcher} fleet`,
    ),
  );
  const systemVerify = run("systemd-analyze", ["verify", systemPath]);
  assert.equal(systemVerify.status, 0, systemVerify.stderr);
  assert.equal(systemVerify.stderr.trim(), "", systemVerify.stderr);
  // Exercise the packaged product runtime against a local trusted HTTPS endpoint.
  // No production enrollment or machine-wide certificate trust is modified.
  const certificate = join(temp, "test-cert.pem");
  const key = join(temp, "test-key.pem");
  const generateCertificate = run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    key,
    "-out",
    certificate,
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  assert.equal(generateCertificate.status, 0, generateCertificate.stderr);
  let httpStatus = 401;
  let requests = 0;
  const secret = `mch_instance_${Buffer.alloc(32, 1).toString("base64url")}`;
  const manager = createServer(
    { key: readFileSync(key), cert: readFileSync(certificate) },
    (request, response) => {
      assert.equal(request.headers.authorization, `Bearer ${secret}`);
      requests++;
      response.writeHead(httpStatus);
      response.end();
    },
  );
  manager.listen(0, "127.0.0.1");
  await once(manager, "listening");
  try {
    mkdirSync(env.MACHDOCH_USER_CONFIG_DIR, { recursive: true });
    writeFileSync(
      join(env.MACHDOCH_USER_CONFIG_DIR, "fleet-connection.json"),
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        managerUrl: `https://127.0.0.1:${manager.address().port}`,
        managerId: `manager_${Buffer.alloc(18, 1).toString("base64url")}`,
        instanceId: `instance_${Buffer.alloc(18, 2).toString("base64url")}`,
        instanceSecret: secret,
        displayName: "Package verification",
      }),
      { mode: 0o600 },
    );
    const runService = async (stopOnRetry) => {
      const child = spawn(
        launcher,
        ["fleet", "service", "run", "--cwd", workspace, "--json"],
        {
          env: { ...env, NODE_EXTRA_CA_CERTS: certificate },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
      let output = "";
      let stopSent = false;
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (
          stopOnRetry &&
          !stopSent &&
          output.includes('"phase":"reconnecting"')
        ) {
          stopSent = true;
          child.kill("SIGTERM");
        }
      });
      child.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      try {
        const [code, signal] = await once(child, "exit");
        assert.equal(signal, null, output);
        assert.equal(code, stopOnRetry ? 0 : 78, output);
        assert.ok(
          !output.includes(secret),
          "The instance secret appeared in service logs",
        );
        assert.ok(
          !readdirSync(env.MACHDOCH_USER_CONFIG_DIR).some((name) =>
            name.endsWith(".lock"),
          ),
          "The service left its ownership lock behind",
        );
      } finally {
        clearTimeout(deadline);
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }
    };
    await runService(false);
    httpStatus = 503;
    await runService(true);
    assert.equal(
      requests,
      2,
      "Authentication failure should not loop; SIGTERM should stop backoff",
    );
  } finally {
    await new Promise((resolve) => manager.close(resolve));
  }
  console.log(
    "Headless archive: launcher, no-display runtime, isolated config, auth rejection, SIGTERM/lock cleanup, Playwright dependency, and both systemd units passed.",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
