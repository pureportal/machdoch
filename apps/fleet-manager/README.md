# Fleet Manager

Fleet Manager is a self-hosted dashboard, WebSocket relay, and optional managed-settings service for enrolled Machdoch instances. It stores its state in SQLite.

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
