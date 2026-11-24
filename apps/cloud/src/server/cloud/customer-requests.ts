import { randomBytes, randomUUID } from "node:crypto";
import { issueInputSchema, type CloudActor } from "../../lib/cloud-contract";
import {
  requestChannels,
  type CloudCustomer,
  type CustomerInput,
  type CustomerRequest,
  type RequestChannel,
  type RequestChannelSecret,
  type RequestIntakeResult,
  type RequestIntakeSettings,
} from "../../lib/cloud-customer-request-contract";
import {
  parseCustomerRequest,
  requestFingerprint,
  requesterDomain,
  type ParsedCustomerRequest,
} from "../../lib/customer-request-intake";
import { CloudError, requireMembership, requireTeam } from "./access";
import type { CloudDatabase, CloudSql } from "./database";
import { hashSourceSecret } from "./loops/loop-sources";
import { createIssueInTransaction, readIssue } from "./planning";

const requestColumns = `r.id,r.issue_id AS "issueId",r.customer_id AS "customerId",c.name AS "customerName",r.channel,r.requester,r.title,r.body,r.mentions,
  to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(r.last_received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastReceivedAt"`;

function isRequestChannel(channel: string): channel is RequestChannel {
  return (requestChannels as readonly string[]).includes(channel);
}

async function triageStatus(
  sql: CloudSql,
  organizationId: string,
  teamId: string,
): Promise<{ id: string; revision: number } | null> {
  return (
    (
      await sql.query<{ id: string; revision: number }>(
        "SELECT id,revision FROM cloud_workflow_statuses WHERE organization_id=$1 AND team_id=$2 AND category='triage' AND NOT archived ORDER BY position LIMIT 1",
        [organizationId, teamId],
      )
    ).rows[0] ?? null
  );
}

async function createTriageIssue(
  sql: CloudSql,
  actor: CloudActor,
  teamId: string,
  request: ParsedCustomerRequest,
): Promise<string> {
  const team = await requireTeam(sql, actor, teamId, "issues.edit");
  const status = await triageStatus(sql, actor.organizationId, team.id);
  if (!status)
    throw new CloudError(
      409,
      "triage_status_required",
      "The customer request team has no triage status.",
    );
  return (
    await createIssueInTransaction(
      sql,
      actor,
      team,
      issueInputSchema.parse({
        teamId: team.id,
        title: request.title,
        description: request.body,
        status,
      }),
    )
  ).id;
}

async function mergeRequest(
  sql: CloudSql,
  organizationId: string,
  fromId: string,
  intoId: string,
): Promise<void> {
  await sql.query(
    `UPDATE cloud_customer_requests r SET mentions=r.mentions+f.mentions,last_received_at=GREATEST(r.last_received_at,f.last_received_at)
    FROM cloud_customer_requests f WHERE r.organization_id=$1 AND r.id=$3 AND f.organization_id=$1 AND f.id=$2`,
    [organizationId, fromId, intoId],
  );
  await sql.query(
    "UPDATE cloud_customer_request_messages SET request_id=$3 WHERE organization_id=$1 AND request_id=$2",
    [organizationId, fromId, intoId],
  );
  await sql.query(
    "DELETE FROM cloud_customer_requests WHERE organization_id=$1 AND id=$2",
    [organizationId, fromId],
  );
}

export async function moveCustomerRequests(
  sql: CloudSql,
  organizationId: string,
  fromIssueId: string,
  toIssueId: string,
): Promise<void> {
  const conflicts = (
    await sql.query<{ fromId: string; intoId: string }>(
      `SELECT f.id AS "fromId",t.id AS "intoId" FROM cloud_customer_requests f
      JOIN cloud_customer_requests t ON t.organization_id=f.organization_id AND t.issue_id=$3 AND t.customer_id=f.customer_id
      WHERE f.organization_id=$1 AND f.issue_id=$2`,
      [organizationId, fromIssueId, toIssueId],
    )
  ).rows;
  for (const conflict of conflicts)
    await mergeRequest(sql, organizationId, conflict.fromId, conflict.intoId);
  await sql.query(
    "UPDATE cloud_customer_requests SET issue_id=$3 WHERE organization_id=$1 AND issue_id=$2",
    [organizationId, fromIssueId, toIssueId],
  );
}

async function resolveCustomer(
  sql: CloudSql,
  organizationId: string,
  request: ParsedCustomerRequest,
): Promise<string | null> {
  if (request.customer) {
    const existing = (
      await sql.query<{ id: string }>(
        "SELECT id FROM cloud_customers WHERE organization_id=$1 AND (lower(name)=lower($2) OR domain=$3) ORDER BY (lower(name)=lower($2)) DESC LIMIT 1",
        [organizationId, request.customer.name, request.customer.domain],
      )
    ).rows[0];
    if (existing) return existing.id;
    const id = randomUUID();
    await sql.query(
      "INSERT INTO cloud_customers (organization_id,id,name,domain) VALUES ($1,$2,$3,$4)",
      [organizationId, id, request.customer.name, request.customer.domain],
    );
    return id;
  }
  const domain = requesterDomain(request.requester);
  if (!domain) return null;
  return (
    (
      await sql.query<{ id: string }>(
        "SELECT id FROM cloud_customers WHERE organization_id=$1 AND domain=$2",
        [organizationId, domain],
      )
    ).rows[0]?.id ?? null
  );
}

async function requireCustomer(
  sql: CloudSql,
  organizationId: string,
  customerId: string,
): Promise<void> {
  const found = await sql.query(
    "SELECT 1 FROM cloud_customers WHERE organization_id=$1 AND id=$2",
    [organizationId, customerId],
  );
  if (!found.rows[0])
    throw new CloudError(404, "not_found", "Customer is unavailable.");
}

async function customerConflict(
  sql: CloudSql,
  organizationId: string,
  input: CustomerInput,
  exceptId: string | null,
): Promise<void> {
  const taken = (
    await sql.query<{ sameName: boolean }>(
      'SELECT lower(name)=lower($2) AS "sameName" FROM cloud_customers WHERE organization_id=$1 AND (lower(name)=lower($2) OR domain=$3) AND id IS DISTINCT FROM $4::uuid LIMIT 1',
      [organizationId, input.name, input.domain, exceptId],
    )
  ).rows[0];
  if (taken)
    throw new CloudError(
      409,
      taken.sameName ? "customer_name_taken" : "customer_domain_taken",
      taken.sameName
        ? "A customer with this name already exists."
        : "Another customer uses this domain.",
    );
}

export class CloudCustomerRequests {
  constructor(
    private readonly database: CloudDatabase,
    private readonly origin: string,
  ) {}

  settings(actor: CloudActor): Promise<RequestIntakeSettings> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "settings.manage");
      const intake = (
        await sql.query<{ teamId: string }>(
          'SELECT team_id AS "teamId" FROM cloud_request_intake WHERE organization_id=$1',
          [actor.organizationId],
        )
      ).rows[0];
      const stored = (
        await sql.query<{
          channel: RequestChannel;
          enabled: boolean;
          configured: boolean;
          rotatedAt: string | null;
        }>(
          `SELECT channel,enabled,secret_hash IS NOT NULL AS configured,
            to_char(rotated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "rotatedAt"
          FROM cloud_request_channels WHERE organization_id=$1`,
          [actor.organizationId],
        )
      ).rows;
      return {
        teamId: intake?.teamId ?? null,
        channels: requestChannels.map(
          (channel) =>
            stored.find((state) => state.channel === channel) ?? {
              channel,
              enabled: false,
              configured: false,
              rotatedAt: null,
            },
        ),
      };
    });
  }

  updateSettings(actor: CloudActor, teamId: string): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "settings.manage");
      await requireTeam(sql, actor, teamId, "issues.edit");
      if (!(await triageStatus(sql, actor.organizationId, teamId)))
        throw new CloudError(
          422,
          "triage_status_required",
          "Add a triage status to this team first.",
        );
      await sql.query(
        `INSERT INTO cloud_request_intake (organization_id,team_id,configured_by) VALUES ($1,$2,$3)
        ON CONFLICT (organization_id) DO UPDATE SET team_id=EXCLUDED.team_id,configured_by=EXCLUDED.configured_by,updated_at=clock_timestamp()`,
        [actor.organizationId, teamId, actor.userId],
      );
    });
  }

  setChannelEnabled(
    actor: CloudActor,
    channel: RequestChannel,
    enabled: boolean,
  ): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "settings.manage");
      await sql.query(
        `INSERT INTO cloud_request_channels (organization_id,channel,enabled) VALUES ($1,$2,$3)
        ON CONFLICT (organization_id,channel) DO UPDATE SET enabled=EXCLUDED.enabled`,
        [actor.organizationId, channel, enabled],
      );
    });
  }

  rotate(
    actor: CloudActor,
    channel: RequestChannel,
  ): Promise<RequestChannelSecret> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "settings.manage");
      const secret = randomBytes(32).toString("base64url");
      await sql.query(
        `INSERT INTO cloud_request_channels (organization_id,channel,secret_hash,rotated_at) VALUES ($1,$2,$3,clock_timestamp())
        ON CONFLICT (organization_id,channel) DO UPDATE SET secret_hash=EXCLUDED.secret_hash,rotated_at=EXCLUDED.rotated_at`,
        [actor.organizationId, channel, hashSourceSecret(secret)],
      );
      return {
        channel,
        secret,
        url: `${this.origin}/api/v1/customer-requests/intake/${actor.organizationId}/${channel}/${secret}`,
      };
    });
  }

  async receive(
    organizationId: string,
    channel: string,
    secret: string,
    payload: unknown,
  ): Promise<RequestIntakeResult> {
    if (!isRequestChannel(channel))
      throw new CloudError(404, "not_found", "Channel is unavailable.");
    return this.database.transaction(async (sql) => {
      const intake = (
        await sql.query<{
          matches: boolean;
          enabled: boolean;
          teamId: string | null;
          configuredBy: string | null;
        }>(
          `SELECT c.secret_hash IS NOT NULL AND c.secret_hash=$3 AS matches,c.enabled,i.team_id AS "teamId",i.configured_by AS "configuredBy"
          FROM cloud_request_channels c LEFT JOIN cloud_request_intake i ON i.organization_id=c.organization_id
          WHERE c.organization_id=$1 AND c.channel=$2`,
          [organizationId, channel, hashSourceSecret(secret)],
        )
      ).rows[0];
      if (!intake)
        throw new CloudError(404, "not_found", "Channel is unavailable.");
      if (!intake.matches)
        throw new CloudError(
          401,
          "request_invalid_secret",
          "The request was rejected.",
        );
      if (!intake.enabled)
        throw new CloudError(
          409,
          "request_channel_disabled",
          "This channel is off.",
        );
      if (!intake.teamId || !intake.configuredBy)
        throw new CloudError(
          409,
          "request_intake_unconfigured",
          "Choose a triage team for customer requests.",
        );
      const request = parseCustomerRequest(channel, payload);
      if (!request)
        throw new CloudError(422, "request_empty", "The request is empty.");
      await sql.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('customer-requests:' || $1::text,0))",
        [organizationId],
      );
      if (request.externalId) {
        const known = (
          await sql.query<{ requestId: string; issueId: string }>(
            `SELECT m.request_id AS "requestId",r.issue_id AS "issueId" FROM cloud_customer_request_messages m
            JOIN cloud_customer_requests r ON r.organization_id=m.organization_id AND r.id=m.request_id
            WHERE m.organization_id=$1 AND m.channel=$2 AND m.external_id=$3`,
            [organizationId, channel, request.externalId],
          )
        ).rows[0];
        if (known) return { ...known, created: false };
      }
      const actor: CloudActor = {
        organizationId,
        userId: intake.configuredBy,
        automation: "Customer requests",
      };
      const customerId = await resolveCustomer(sql, organizationId, request);
      const fingerprint = requestFingerprint(request.title);
      const matchedIssueId = fingerprint
        ? ((
            await sql.query<{ issueId: string }>(
              `SELECT r.issue_id AS "issueId" FROM cloud_customer_requests r
              JOIN cloud_issues i ON i.organization_id=r.organization_id AND i.id=r.issue_id
              WHERE r.organization_id=$1 AND r.fingerprint=$2 AND NOT i.archived AND i.state NOT IN ('complete','canceled')
              ORDER BY r.created_at,r.id LIMIT 1`,
              [organizationId, fingerprint],
            )
          ).rows[0]?.issueId ?? null)
        : null;
      const existingRequestId =
        matchedIssueId && customerId
          ? ((
              await sql.query<{ id: string }>(
                "SELECT id FROM cloud_customer_requests WHERE organization_id=$1 AND issue_id=$2 AND customer_id=$3",
                [organizationId, matchedIssueId, customerId],
              )
            ).rows[0]?.id ?? null)
          : null;
      const issueId =
        matchedIssueId ??
        (await createTriageIssue(sql, actor, intake.teamId, request));
      let requestId = existingRequestId;
      if (requestId)
        await sql.query(
          "UPDATE cloud_customer_requests SET mentions=mentions+1,last_received_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
          [organizationId, requestId],
        );
      else {
        requestId = randomUUID();
        await sql.query(
          `INSERT INTO cloud_customer_requests (organization_id,id,issue_id,customer_id,channel,requester,title,body,fingerprint)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            organizationId,
            requestId,
            issueId,
            customerId,
            channel,
            request.requester,
            request.title,
            request.body,
            fingerprint,
          ],
        );
      }
      if (request.externalId)
        await sql.query(
          "INSERT INTO cloud_customer_request_messages (organization_id,channel,external_id,request_id) VALUES ($1,$2,$3,$4)",
          [organizationId, channel, request.externalId, requestId],
        );
      return { issueId, requestId, created: !matchedIssueId };
    });
  }

  forIssue(actor: CloudActor, issueId: string): Promise<CustomerRequest[]> {
    return this.database.transaction(async (sql) => {
      await readIssue(sql, actor, issueId);
      return (
        await sql.query<CustomerRequest & Record<string, unknown>>(
          `SELECT ${requestColumns} FROM cloud_customer_requests r
          LEFT JOIN cloud_customers c ON c.organization_id=r.organization_id AND c.id=r.customer_id
          WHERE r.organization_id=$1 AND r.issue_id=$2 ORDER BY r.last_received_at DESC,r.id`,
          [actor.organizationId, issueId],
        )
      ).rows;
    });
  }

  link(
    actor: CloudActor,
    requestId: string,
    customerId: string | null,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      const request = (
        await sql.query<{ issueId: string }>(
          'SELECT issue_id AS "issueId" FROM cloud_customer_requests WHERE organization_id=$1 AND id=$2',
          [actor.organizationId, requestId],
        )
      ).rows[0];
      if (!request)
        throw new CloudError(404, "not_found", "Request is unavailable.");
      await readIssue(sql, actor, request.issueId, "issues.edit");
      if (customerId) {
        await requireCustomer(sql, actor.organizationId, customerId);
        const existing = (
          await sql.query<{ id: string }>(
            "SELECT id FROM cloud_customer_requests WHERE organization_id=$1 AND issue_id=$2 AND customer_id=$3 AND id<>$4",
            [actor.organizationId, request.issueId, customerId, requestId],
          )
        ).rows[0];
        if (existing) {
          await mergeRequest(sql, actor.organizationId, requestId, existing.id);
          return { id: existing.id };
        }
      }
      await sql.query(
        "UPDATE cloud_customer_requests SET customer_id=$3 WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, requestId, customerId],
      );
      return { id: requestId };
    });
  }

  customers(actor: CloudActor): Promise<CloudCustomer[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return (
        await sql.query<CloudCustomer & Record<string, unknown>>(
          `SELECT c.id,c.name,c.domain,
            (SELECT count(*)::int FROM cloud_customer_requests r WHERE r.organization_id=c.organization_id AND r.customer_id=c.id) AS "requestCount"
          FROM cloud_customers c WHERE c.organization_id=$1 ORDER BY lower(c.name),c.id`,
          [actor.organizationId],
        )
      ).rows;
    });
  }

  createCustomer(
    actor: CloudActor,
    input: CustomerInput,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "settings.manage");
      await customerConflict(sql, actor.organizationId, input, null);
      const id = randomUUID();
      await sql.query(
        "INSERT INTO cloud_customers (organization_id,id,name,domain) VALUES ($1,$2,$3,$4)",
        [actor.organizationId, id, input.name, input.domain],
      );
      return { id };
    });
  }

  removeCustomer(actor: CloudActor, customerId: string): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "settings.manage");
      await requireCustomer(sql, actor.organizationId, customerId);
      await sql.query(
        "DELETE FROM cloud_customers WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, customerId],
      );
    });
  }
}
