import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCACertificates } from "node:tls";
import { CloudError } from "../access";
import type { OidcMetadata } from "../../../lib/cloud-sso-contract";
import type { OidcJob, OidcClaims } from "./oidc-protocol";

const NativeWorker = (
  process.getBuiltinModule(
    "worker_threads",
  ) as typeof import("node:worker_threads")
).Worker;
const active = new Map<string, number>();

export async function runOidcJob<T extends OidcJob>(
  organizationId: string,
  job: T,
  signal?: AbortSignal,
): Promise<T extends { kind: "discover" } ? OidcMetadata : OidcClaims> {
  signal?.throwIfAborted();
  const identity = `${organizationId.toLowerCase()}/${job.kind}`;
  const count = active.get(identity) ?? 0;
  if (
    [...active.values()].reduce((sum, value) => sum + value, 0) >= 8 ||
    count >= (job.kind === "discover" ? 1 : 4)
  )
    throw new CloudError(
      429,
      "sso_busy",
      "A sign-in provider request is running. Try again shortly.",
    );
  active.set(identity, count + 1);
  try {
    return await new Promise((done, reject) => {
      const worker = new NativeWorker(
        resolve(
          dirname(fileURLToPath(import.meta.url)),
          "../../../../dist/cloud-oidc-worker.mjs",
        ),
        {
          workerData: { job, ca: getCACertificates("default") },
          execArgv: [],
          env: process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {},
          resourceLimits: {
            maxOldGenerationSizeMb: 64,
            maxYoungGenerationSizeMb: 16,
            stackSizeMb: 4,
          },
          stdout: true,
          stderr: true,
        },
      );
      worker.stdout.resume();
      worker.stderr.resume();
      let settled = false;
      const timer = setTimeout(() => finish(), 20000);
      const aborted = () => finish();
      function finish(result?: unknown) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        void worker.terminate().then(
          () => {
            if (result !== undefined)
              done(
                result as T extends { kind: "discover" }
                  ? OidcMetadata
                  : OidcClaims,
              );
            else
              reject(
                new CloudError(
                  422,
                  "sso_provider_failed",
                  "The sign-in provider request failed. Check its configuration and start again.",
                ),
              );
          },
          () =>
            reject(
              new CloudError(
                503,
                "sso_worker_failed",
                "Sign-in is unavailable. Try again shortly.",
              ),
            ),
        );
      }
      worker.once("message", (value: unknown) => {
        if (
          value &&
          typeof value === "object" &&
          "ok" in value &&
          value.ok === true &&
          "result" in value
        )
          finish(value.result);
        else {
          if (
            value &&
            typeof value === "object" &&
            "code" in value &&
            typeof value.code === "string" &&
            /^(?:OAUTH|OIDC|ERR)_[A-Z_]{1,70}$/.test(value.code)
          )
            console.error("OIDC provider request rejected", value.code);
          finish();
        }
      });
      worker.once("error", () => finish());
      worker.once("exit", () => finish());
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  } finally {
    const remaining = active.get(identity)! - 1;
    if (remaining) active.set(identity, remaining);
    else active.delete(identity);
  }
}
