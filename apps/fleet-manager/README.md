# Fleet Manager

Fleet Manager is a self-hosted dashboard, WebSocket relay, and optional managed-settings service for enrolled Machdoch instances. It stores its state in SQLite.

Headless hosts support remote project services and private previews: start, stop, restart, health and logs, with isolated HTTP/WebSocket previews and backend routing. Set the optional `previews.baseUrl` and configure wildcard HTTPS to enable previews.

Workspaces lists sessions across devices, opens the selected session, and can stop selected tasks. It also shows CPU and memory usage, device version warnings, and reported task failures.

The [Android controller](../fleet-android/README.md) connects to the same HTTPS manager and uses the same product views.

## Docker

Releases publish `ghcr.io/pureportal/machdoch-fleet-manager` for Linux `amd64`. Copy `fleet-manager.example.json` to a deployment directory as `fleet-manager.json`, then set `externalBaseUrl` to the HTTPS origin served by your reverse proxy. Keep the example port and loopback address.

Set the owner credentials and image tag, then initialize the database:

```bash
export FLEET_IMAGE=ghcr.io/pureportal/machdoch-fleet-manager:latest
export FLEET_MANAGER_SEED_USERNAME=owner
export FLEET_MANAGER_SEED_PASSWORD='replace-this-password'

docker volume create machdoch-fleet-data
docker run --rm --network host \
  --mount type=bind,source="$(pwd)/fleet-manager.json",target=/config/fleet-manager.json,readonly \
  --mount type=volume,source=machdoch-fleet-data,target=/config/data \
  --env FLEET_MANAGER_SEED_USERNAME \
  --env FLEET_MANAGER_SEED_PASSWORD \
  "$FLEET_IMAGE" seed --config /config/fleet-manager.json
```

Start Fleet Manager:

```bash
docker run --detach \
  --name machdoch-fleet \
  --restart unless-stopped \
  --network host \
  --mount type=bind,source="$(pwd)/fleet-manager.json",target=/config/fleet-manager.json,readonly \
  --mount type=volume,source=machdoch-fleet-data,target=/config/data \
  "$FLEET_IMAGE"
```

The image uses host networking because Fleet Manager accepts loopback listeners only; ordinary Docker port publishing cannot reach it. The published image is therefore intended for Docker Engine on Linux with a same-host HTTPS reverse proxy. The proxy must forward `Authorization`, `Host`, `Origin`, `X-Forwarded-Host`, and `X-Forwarded-Proto`, overwrite `X-Forwarded-For` with the connecting client's address, and preserve WebSocket upgrades for `/api/gateway/connect/*`.

Back up the `machdoch-fleet-data` volume. It contains the manager identity, owner accounts, enrolled instances, and managed settings.

## Source

Copy `fleet-manager.example.json` to `fleet-manager.json`, set `FLEET_MANAGER_SEED_USERNAME` and `FLEET_MANAGER_SEED_PASSWORD` in the workspace `.env`, and initialize the owner:

```bash
pnpm --filter @machdoch/fleet-manager seed
```

Build and start it behind an HTTPS reverse proxy:

```bash
pnpm build:fleet-manager
pnpm --filter @machdoch/fleet-manager start
```

The proxy must forward `Authorization`, `Host`, `Origin`, `X-Forwarded-Host`, and `X-Forwarded-Proto`, overwrite `X-Forwarded-For` with the connecting client's address, and preserve WebSocket upgrades for `/api/gateway/connect/*`. The application listens only on loopback.

## Settings Manager

To enable managed settings, set `settingsManager.enabled` and configure one encryption key source. `MACHDOCH_SETTINGS_KEY` must contain 32 random bytes encoded as URL-safe Base64 without padding.

For Docker, keep `encryptionKeyEnvironmentVariable` and add `--env MACHDOCH_SETTINGS_KEY` to the server command. Store and back up the key separately from the data volume.

For a file-backed key, set `encryptionKeyFile`, remove `encryptionKeyEnvironmentVariable`, then run:

```bash
pnpm --filter @machdoch/fleet-manager settings-key
```

Back up the encryption key separately from the SQLite database. Encrypted secrets cannot be recovered without it.

Desktop clients and headless `fleet service` instances receive assigned profiles and report the revision they applied. Headless clients retain the last profile during a manager outage and keep local settings separate, so disabling the connection or removing the assignment restores local values.

Clients capture their original settings before applying their first profile. Open a profile's **Device settings** tab, select a device, review the differences, and choose which value to keep for each conflict. **Merge settings** updates the profile for every assigned device. API credentials are excluded from this capture; use the **Secrets** tab to share credentials.

Headless hosts also expose assigned prompts, instructions, and context packs. Context packs that require desktop-only controls return an explicit error when applied on a headless host.

## Enrollment and connection recovery

The Enrollment page lists unused, unexpired enrollment keys and allows the owner to revoke them immediately. It displays key values only when they are created; refreshing the inventory returns metadata only. Revoking an unused key releases its enrollment slot. Revoke an instance separately on the Instances page to disconnect it and invalidate its credential.

Clients reconnect after manager restarts and temporary duplicate-connection conflicts. Revocations and invalid credentials stop reconnection. WebSocket heartbeats run every 15 seconds; configure `connectionPolicy.heartbeatTimeoutSeconds` between 30 and 300 seconds (default 45). Closing connections have a five-second cleanup deadline, and manager shutdown has a ten-second deadline.

Gateway requests have bounded queues, payloads, buffered writes, and response deadlines. Command receipts must match the submitted command ID. API integrations should supply a stable `commandId` when retrying a command: a timeout or a cancelled HTTP request does not prove that a command was never executed. The client retains a bounded history of command receipts for duplicate detection.

## Projects

Headless hosts also support a remote project library: clone repositories, create empty projects, import existing folders, and open agent tasks in a host-configured workspace root.

## Verification

After building, `node apps/fleet-manager/scripts/verify-live.mjs` runs an isolated production manager over temporary TLS, enrolls two real CLI services, and checks the browser merge, revision conflicts, outage recovery, and device revocation. It requires Chrome and OpenSSL; set `CHROME_PATH` and `OPENSSL_PATH` for installations outside the script's Windows defaults. Fixtures and screenshots stay under `.next/fleet-verification/`.

Run `pnpm --filter @machdoch/client build:cli-bundle` and set `FLEET_VERIFY_CLIENT_BUNDLE=1` to verify the built CLI instead of the TypeScript entry point.

Set `FLEET_VERIFY_ANDROID_SERIAL` to a running isolated emulator, such as `emulator-5568`, to also check APK installation, HTTPS validation, certificate rejection, and connection recovery. This resets the controller's data on that emulator. Authenticated Android workflows require a manager certificate trusted by Android.

See [requirement evidence and remaining gaps](../../docs/fleet-manager-verification-2026-10-05.md) before treating the full remote-control goal as complete.
