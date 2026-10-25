import {
  githubRepositorySchema,
  maximumRepositoryTransferBytes,
} from "@machdoch/fleet-protocol/cloud-repository";
import type { WorkerRepositoryRequest } from "../../../lib/cloud-repository-contract";
import { CloudError } from "../access";
import type { CloudDatabase } from "../database";
import { mayExecute, readAttempt } from "./attempts";
import { requireWorker } from "./workers";

const maximumRunBytes = 512 * 1024 * 1024;

export class CloudRepositories {
  private activeTransfers = 0;
  constructor(
    private readonly database: CloudDatabase,
    private readonly transport: typeof fetch = fetch,
  ) {}

  private reserve(
    token: string,
    input: WorkerRepositoryRequest,
  ): Promise<{ organizationId: string; repository: string }> {
    return this.database.transaction(async (sql) => {
      const worker = await requireWorker(sql, token);
      const { run, attempt } = await readAttempt(sql, worker, input);
      if (!(await mayExecute(sql, worker, run, attempt)))
        throw new CloudError(
          409,
          "attempt_stopped",
          "Repository access ended with the task's execution authority.",
        );
      await sql.query(
        "UPDATE cloud_repository_transfers SET state='failed' WHERE organization_id=$1 AND state='pending' AND expires_at<=clock_timestamp()",
        [worker.organizationId],
      );
      const usage = (
        await sql.query<{
          count: number;
          bytes: number;
          active: number;
          organizationActive: number;
        }>(
          `SELECT count(*) FILTER (WHERE run_id=$2)::integer AS count,
        COALESCE(sum(charged_bytes) FILTER (WHERE run_id=$2),0)::double precision AS bytes,
        count(*) FILTER (WHERE run_id=$2 AND state='pending')::integer AS active,
        count(*) FILTER (WHERE state='pending')::integer AS "organizationActive"
        FROM cloud_repository_transfers WHERE organization_id=$1`,
          [worker.organizationId, run.id],
        )
      ).rows[0]!;
      if (usage.active || usage.organizationActive >= 4)
        throw new CloudError(
          409,
          "repository_busy",
          "Wait for the active repository transfer to finish.",
        );
      if (
        usage.count >= 128 ||
        usage.bytes + maximumRepositoryTransferBytes > maximumRunBytes
      )
        throw new CloudError(
          409,
          "repository_limit",
          "The task reached its repository transfer limit.",
        );
      const duplicate = await sql.query(
        "SELECT id FROM cloud_repository_transfers WHERE organization_id=$1 AND id=$2",
        [worker.organizationId, input.id],
      );
      if (duplicate.rows.length)
        throw new CloudError(
          409,
          "transfer_used",
          "Start a new repository transfer instead of replaying this transfer ID.",
        );
      await sql.query(
        "INSERT INTO cloud_repository_transfers(organization_id,id,run_id,attempt_id,epoch,state,charged_bytes,expires_at) VALUES ($1,$2,$3,$4,$5,'pending',$6,clock_timestamp()+interval '60 seconds')",
        [
          worker.organizationId,
          input.id,
          run.id,
          attempt.id,
          attempt.epoch,
          maximumRepositoryTransferBytes,
        ],
      );
      return {
        organizationId: worker.organizationId,
        repository: run.manifest.profile.repository,
      };
    });
  }

  async transfer(
    token: string,
    input: WorkerRepositoryRequest,
    signal: AbortSignal,
  ): Promise<Response> {
    if (this.activeTransfers >= 8)
      throw new CloudError(
        503,
        "repository_busy",
        "Repository transfers are at capacity. Try again shortly.",
      );
    this.activeTransfers++;
    let reservation: { organizationId: string; repository: string } | undefined;
    let received = 0;
    let complete = false;
    const abort = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
    try {
      reservation = await this.reserve(token, input);
      const parsed = githubRepositorySchema.safeParse(reservation.repository);
      if (!parsed.success)
        throw new CloudError(
          422,
          "repository_invalid",
          "Choose a valid GitHub repository URL.",
        );
      const repository = parsed.data.replace(/\.git$/, "") + ".git";
      const organizationId = reservation.organizationId;
      const advertise = input.operation === "advertise";
      const contentType = advertise
        ? "application/x-git-upload-pack-advertisement"
        : "application/x-git-upload-pack-result";
      const response = await this.transport(
        repository +
          (advertise
            ? "/info/refs?service=git-upload-pack"
            : "/git-upload-pack"),
        {
          method: advertise ? "GET" : "POST",
          redirect: "error",
          signal: abort,
          headers: {
            "Git-Protocol": "version=2",
            Accept: contentType,
            ...(input.encoding ? { "Content-Encoding": input.encoding } : {}),
            ...(advertise
              ? {}
              : { "Content-Type": "application/x-git-upload-pack-request" }),
          },
          ...(advertise ? {} : { body: Buffer.from(input.body, "base64") }),
        },
      );
      if (
        response.status !== 200 ||
        response.headers.get("content-type")?.split(";", 1)[0] !==
          contentType ||
        !response.body
      ) {
        await response.body?.cancel();
        throw new CloudError(
          502,
          "repository_unavailable",
          "The repository could not be fetched. Check repository access and its URL.",
        );
      }
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > maximumRepositoryTransferBytes) {
        await response.body.cancel();
        throw new CloudError(
          413,
          "repository_too_large",
          "The repository transfer exceeds the supported size.",
        );
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          abort.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          received += chunk.value.byteLength;
          if (received > maximumRepositoryTransferBytes)
            throw new CloudError(
              413,
              "repository_too_large",
              "The repository transfer exceeds the supported size.",
            );
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      await this.database.transaction(async (sql) => {
        const worker = await requireWorker(sql, token);
        const { run, attempt } = await readAttempt(sql, worker, input);
        if (!(await mayExecute(sql, worker, run, attempt)))
          throw new CloudError(
            409,
            "attempt_stopped",
            "Repository access ended before the transfer completed.",
          );
        const updated = await sql.query(
          "UPDATE cloud_repository_transfers SET state='complete',charged_bytes=$3 WHERE organization_id=$1 AND id=$2 AND state='pending' AND expires_at>clock_timestamp() RETURNING id",
          [organizationId, input.id, received],
        );
        if (!updated.rows.length)
          throw new CloudError(
            409,
            "transfer_expired",
            "Start a new repository transfer.",
          );
      });
      abort.throwIfAborted();
      complete = true;
      let released = false;
      let stop: () => void;
      const release = () => {
        if (released) return;
        released = true;
        this.activeTransfers--;
        chunks.length = 0;
        abort.removeEventListener("abort", stop);
      };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stop = () => {
            release();
            controller.error(new Error("Repository response expired"));
          };
          abort.addEventListener("abort", stop, { once: true });
        },
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk) controller.enqueue(chunk);
          else {
            release();
            controller.close();
          }
        },
        cancel: release,
      });
      return new Response(body, {
        headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
      });
    } catch (error) {
      if (error instanceof CloudError) throw error;
      throw new CloudError(
        502,
        "repository_unavailable",
        "The repository transfer was interrupted. Start a new transfer.",
      );
    } finally {
      if (!complete) this.activeTransfers--;
      if (!complete && reservation)
        await this.database.transaction((sql) =>
          sql.query(
            "UPDATE cloud_repository_transfers SET state='failed' WHERE organization_id=$1 AND id=$2 AND state='pending'",
            [reservation!.organizationId, input.id],
          ),
        );
    }
  }
}
