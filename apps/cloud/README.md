# machdoch.cloud

Self-hosted planning, AI tasks and chat, team administration, and remote access to Machdoch clients. Accounts, linked devices, settings and credentials are stored in PostgreSQL.

## Install

The Linux image is `ghcr.io/pureportal/machdoch-cloud:latest`. The only required application environment variable is:

```text
MACHDOCH_CLOUD_DATABASE_URL=postgresql://user:password@postgres:5432/machdoch
```

Start the container behind an HTTPS reverse proxy, expose port 43188, and open its public address. Create the organization and owner in the setup form. Cloud stores the public origin and generates its credential encryption key in PostgreSQL. No seed command, origin variable, encryption-key variable, SQLite volume, or Redis service is required for the application.

```bash
docker run --detach --name machdoch-cloud --restart unless-stopped \
  --publish 127.0.0.1:43188:43188 \
  --env MACHDOCH_CLOUD_DATABASE_URL \
  ghcr.io/pureportal/machdoch-cloud:latest
```

The proxy must preserve `Host`, `Origin`, `Authorization`, cookies, and WebSocket upgrades under `/api/gateway/connect/`. Configure HTTPS at the proxy. `PORT` and `MACHDOCH_CLOUD_LISTEN_ADDRESS` optionally change the listener. The default listener is `0.0.0.0:43188`.

Back up PostgreSQL, including the installation key. Optional AI execution workers, repository access, email delivery, private preview domains and artifact storage retain their own configuration requirements; configure the integrations that you use.

## Upgrade an existing installation

1. Stop the old application and take a verified backup of its database, configuration and settings key.
2. Provision PostgreSQL and set `MACHDOCH_CLOUD_DATABASE_URL` on the new image.
3. For the first start, retain the existing `/config` mounts and the settings encryption key source. The importer discovers `/config/fleet-manager.json`; a source installation elsewhere can use `serve --import-config /absolute/path/to/config.json`.
4. Start the new image on the same public address. Startup imports the owner, device credentials and revocations, enrollment grants, audit history, profile revisions, assignments, captured device settings and session routes in one PostgreSQL transaction. Secrets are decrypted with the source key and encrypted with the installation key. Existing Cloud data is never overwritten.
5. The importer compares the imported rows, verifies the committed owner, and then deletes the SQLite database and its journal files. It also removes unchanged, writable configuration and key files within the source configuration directory. Read-only mounts, symlinks, external key files and files changed during import are retained. Failed imports retain the source. A committed import whose cleanup was interrupted resumes without duplicating data, including after SQLite was deleted. Check the startup migration result before removing the old mounts and any explicit migration argument or environment variable.

Existing usernames and passwords continue to work. Sign in again in the browser; device credentials and installation identity are retained, so linked clients reconnect without reenrollment. Remote controls are available to the installation organization's owners and administrators. Other organization roles cannot control its clients.

Source account conflicts, unsupported source tables, unavailable encryption keys or a populated remote-device destination stop migration without removing source data. Stop all old application processes before upgrading. Do not run the old and new applications against the same installation concurrently.

When upgrading an installation that already used Cloud credentials, supply its existing `MACHDOCH_CLOUD_ENCRYPTION_KEY` for the first start. It is verified and persisted; it is no longer required on subsequent starts. An existing `MACHDOCH_CLOUD_ORIGIN` is likewise adopted on first initialization.

## Clients

Open **Clients** to inspect devices, enroll or revoke them, open remote workspaces, and manage profiles. The remote workspace retains chat, tasks, scheduler, RALPH, files, Git, terminal, services, previews, speech and media controls. Device-backed features still depend on the connected client's capabilities.

The [Android controller](../fleet-android/README.md) uses the same Cloud sign-in and remote views. Updated desktop and CLI clients use the Cloud name while retaining their enrolled device identity.

## Source

```bash
pnpm build:cloud
pnpm start:cloud
```

Use the same PostgreSQL environment variable. The application performs schema migrations before listening. The Cloud migration tests exercise password/device preservation, encrypted data, rollback, conflicting destinations and interrupted cleanup; remote API and gateway tests cover authentication, revocation and reconnect behavior.

After building, `pnpm --filter @machdoch/cloud verify:cloud:cutover` checks browser setup and client controls. `pnpm --filter @machdoch/cloud verify:cloud:migration` rehearses a SQLite upgrade against PostgreSQL. These checks create and remove their own databases on the configured test server and require Chrome, OpenSSL, and permission to create databases.
