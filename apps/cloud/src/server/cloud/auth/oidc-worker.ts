import { request } from "node:https";
import { parentPort, workerData } from "node:worker_threads";
import type { CustomFetch } from "openid-client";
import { executeOidcJob, type OidcJob } from "./oidc-protocol";

const { job, ca } = workerData as { job: OidcJob; ca: string[] };
const allowed = new Set(
  job.kind === "discover"
    ? [job.issuer.replace(/\/$/, "") + "/.well-known/openid-configuration"]
    : [
        job.configuration.metadata.token_endpoint,
        job.configuration.metadata.jwks_uri,
        job.configuration.metadata.userinfo_endpoint,
      ].filter((url): url is string => !!url),
);
let requests = 0;
let received = 0;
const boundedFetch: CustomFetch = async (url, options) => {
  if (!allowed.has(url) || ++requests > 6)
    throw new Error("OIDC destination denied");
  return new Promise((resolve, reject) => {
    const call = request(
      url,
      {
        method: options.method,
        headers: options.headers,
        signal: options.signal,
        ca,
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
        maxHeaderSize: 16384,
        timeout: 10000,
        agent: false,
      },
      (response) => {
        if (
          !response.statusCode ||
          response.statusCode < 200 ||
          response.statusCode >= 300
        ) {
          response.destroy();
          call.destroy();
          reject(new Error("OIDC request failed"));
          return;
        }
        const chunks: Buffer[] = [];
        response.on("data", (data: Buffer) => {
          received += data.length;
          if (received > 262144) {
            response.destroy();
            call.destroy();
            reject(new Error("OIDC response limit"));
          } else chunks.push(data);
        });
        response.once("error", reject);
        response.once("end", () => {
          const body = Buffer.concat(chunks);
          if (
            job.kind === "exchange" &&
            url === job.configuration.metadata.jwks_uri
          ) {
            try {
              const keys = JSON.parse(body.toString("utf8")).keys as unknown;
              if (!Array.isArray(keys) || !keys.length || keys.length > 64)
                throw new Error("Invalid signing keys");
              for (const key of keys) {
                if (
                  !key ||
                  typeof key !== "object" ||
                  JSON.stringify(key).length > 8192
                )
                  throw new Error("Signing key limit");
                for (const [field, limit] of [
                  ["n", 1366],
                  ["e", 8],
                  ["x", 88],
                  ["y", 88],
                  ["kid", 256],
                ] as const)
                  if (
                    key[field] !== undefined &&
                    (typeof key[field] !== "string" ||
                      key[field].length > limit)
                  )
                    throw new Error("Signing key material limit");
              }
            } catch {
              reject(new Error("Invalid signing key response"));
              return;
            }
          }
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers))
            if (value !== undefined)
              headers.set(
                name,
                Array.isArray(value) ? value.join(", ") : value,
              );
          resolve(
            new Response(body, {
              status: response.statusCode,
              headers,
            }),
          );
        });
      },
    );
    call.once("error", reject);
    call.once("timeout", () => call.destroy(new Error("OIDC timeout")));
    if (options.body instanceof URLSearchParams)
      call.end(options.body.toString());
    else if (typeof options.body === "string" || options.body == null)
      call.end(options.body ?? undefined);
    else call.destroy(new Error("Unsupported OIDC body"));
  });
};
try {
  parentPort!.postMessage({
    ok: true,
    result: await executeOidcJob(job, boundedFetch),
  });
} catch (error) {
  const code =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^(?:OAUTH|OIDC|ERR)_[A-Z_]{1,70}$/.test(error.code)
      ? error.code
      : "OIDC_REQUEST_FAILED";
  parentPort!.postMessage({ ok: false, code });
}
