import {
  productSnapshotSchema,
  type ProductSnapshot,
} from "@machdoch/fleet-protocol";
import type { CloudDatabase, CloudSql } from "../database";
import type { FleetInstance, FleetStore } from "../../fleet-store";
import { GatewayError, type GatewayHub } from "../../gateway";
import {
  observeClient,
  presenceEvent,
  type ClientEvent,
  type ClientObservation,
} from "./client-events";
import { recordAiActivity } from "./journal";

const snapshotIntervalMs = 30_000;
const snapshotTimeoutMs = 10_000;
const presenceTimeoutSeconds = 120;

export interface ClientFleet {
  fleetStore: Pick<FleetStore, "listInstances">;
  gateways: Pick<GatewayHub, "isOnline" | "relay">;
}

export class CloudClientMonitor {
  private readonly observedAt = new Map<string, number>();

  constructor(
    private readonly database: CloudDatabase,
    private readonly fleet: ClientFleet,
    private readonly now: () => number = Date.now,
  ) {}

  async tick(): Promise<number> {
    const organizationId = (
      await this.database.transaction((sql) =>
        sql.query<{ organizationId: string }>(
          `SELECT organization_id AS "organizationId" FROM cloud_installation WHERE id=1 AND organization_id IS NOT NULL`,
        ),
      )
    ).rows[0]?.organizationId;
    if (!organizationId) return 0;
    const instances = (await this.fleet.fleetStore.listInstances()).filter(
      (instance) => instance.revokedAt === null,
    );
    let recorded = await this.recordPresence(organizationId, instances);
    for (const instance of instances) {
      if (!this.fleet.gateways.isOnline(instance.instanceId)) continue;
      const last = this.observedAt.get(instance.instanceId);
      if (last !== undefined && this.now() - last < snapshotIntervalMs)
        continue;
      this.observedAt.set(instance.instanceId, this.now());
      const snapshot = await this.snapshot(instance.instanceId);
      if (snapshot)
        recorded += await this.observe(organizationId, instance, snapshot);
    }
    return recorded;
  }

  private recordPresence(
    organizationId: string,
    instances: FleetInstance[],
  ): Promise<number> {
    return this.database.transaction(async (sql) => {
      let recorded = 0;
      for (const instance of instances) {
        const online =
          instance.lastSeenAt !== null &&
          this.now() / 1000 - instance.lastSeenAt <= presenceTimeoutSeconds;
        const created = await sql.query(
          "INSERT INTO cloud_client_observations (instance_id,online) VALUES ($1,$2) ON CONFLICT (instance_id) DO NOTHING RETURNING instance_id",
          [instance.instanceId, online],
        );
        if (created.rows.length) continue;
        const changed = await sql.query(
          "UPDATE cloud_client_observations SET online=$2,observed_at=clock_timestamp() WHERE instance_id=$1 AND online<>$2 RETURNING instance_id",
          [instance.instanceId, online],
        );
        if (!changed.rows.length) continue;
        await record(sql, organizationId, instance, presenceEvent(online));
        recorded++;
      }
      return recorded;
    });
  }

  private async snapshot(instanceId: string): Promise<ProductSnapshot | null> {
    try {
      const response = await this.fleet.gateways.relay(
        instanceId,
        { type: "getProductSnapshot" },
        AbortSignal.timeout(snapshotTimeoutMs),
      );
      if (response.type !== "productSnapshot") return null;
      const parsed = productSnapshotSchema.safeParse(response.snapshot);
      return parsed.success ? parsed.data : null;
    } catch (error) {
      if (error instanceof GatewayError) return null;
      throw error;
    }
  }

  private observe(
    organizationId: string,
    instance: FleetInstance,
    snapshot: ProductSnapshot,
  ): Promise<number> {
    return this.database.transaction(async (sql) => {
      const previous = (
        await sql.query<{ state: ClientObservation | null }>(
          "SELECT state FROM cloud_client_observations WHERE instance_id=$1 FOR UPDATE",
          [instance.instanceId],
        )
      ).rows[0]?.state;
      const { observation, events } = observeClient(previous ?? null, snapshot);
      await sql.query(
        `INSERT INTO cloud_client_observations (instance_id,online,state) VALUES ($1,true,$2)
        ON CONFLICT (instance_id) DO UPDATE SET state=$2,observed_at=clock_timestamp()`,
        [instance.instanceId, JSON.stringify(observation)],
      );
      for (const event of events)
        await record(sql, organizationId, instance, event);
      return events.length;
    });
  }
}

function record(
  sql: CloudSql,
  organizationId: string,
  instance: FleetInstance,
  event: ClientEvent,
): Promise<void> {
  return recordAiActivity(sql, {
    organizationId,
    kind: "client",
    status: event.status,
    title: event.title,
    detail: event.detail,
    provider: event.provider ?? null,
    model: event.model ?? null,
    client: { id: instance.instanceId, name: instance.displayName },
  });
}
