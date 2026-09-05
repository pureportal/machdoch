# Remote services and private previews

Fleet Manager's **Services & previews** page manages project servers on a connected headless host. Open it from a project card, or the services icon in the product toolbar. Select a project, add a command, save it, and press **Start**. **Restart** stops the process tree before starting a new generation. **Stop** also closes its preview connections and cancels pending automatic restarts.

This requires an updated `machdoch fleet service` on Linux or Windows. The extension is negotiated as `workspace-runs.v1`; older hosts and the desktop gateway return an explanatory unsupported-host message. The manager never executes project commands or opens project ports on its own machine.

## What can run

| Project output                                     | How to use it                                                         |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| Frontend, landing page, documentation, static site | Run its HTTP development/static server and declare its port.          |
| Backend, REST or GraphQL API, file upload/download | Preview its HTTP port, or route a path from a frontend preview to it. |
| HMR, Socket.IO, browser WebSocket application      | WebSocket upgrades and subprotocols travel through the preview.       |
| SSE and streaming HTTP output                      | Responses stream incrementally with backpressure.                     |
| Worker, watcher, build, test or other command      | Leave ports empty; inspect state, exit code and logs.                 |
| Several services                                   | Use a parallel or sequential composite in `run.json`.                 |

The browser uses HTTPS in production; the application side currently uses HTTP/1.1 over loopback, including WebSocket upgrades. Native TCP/UDP protocols, databases, SSH, HTTP/2-only gRPC, remote desktops, and self-signed HTTPS upstreams are outside this browser relay. Use an authenticated VPN or SSH forwarding for those protocols. There is no public sharing mode. Restart controls apply to project processes, not OS reboot or privileged machine administration.

## Enable previews

Add this optional field to Fleet Manager's configuration:

```json
"previews": { "baseUrl": "https://preview.example.net" }
```

Configure wildcard DNS and a TLS certificate for `*.preview.example.net`. Route those hosts to the same loopback Fleet Manager listener, preserving the original `Host`. Use a domain you control, preferably a separate registrable domain from the manager. The manager hostname must not fall under the preview wildcard. Unknown hosts do not serve the manager UI or API. Omitting this setting leaves service management available and previews disabled.

For example, with the manager at `fleet.example.com`, an Nginx configuration can use separate certificates and identical forwarding settings for `fleet.example.com` and `*.preview.example.net`:

```nginx
# In the http context:
map $http_upgrade $machdoch_connection {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name *.preview.example.net;
    ssl_certificate     /etc/ssl/machdoch/preview-fullchain.pem;
    ssl_certificate_key /etc/ssl/machdoch/preview-key.pem;

    client_max_body_size 100m;
    location / {
        proxy_pass http://127.0.0.1:43188;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $machdoch_connection;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

The existing manager HTTPS virtual host must also forward WebSocket upgrades and preserve `Host`; hosts establish their outbound control and preview tunnels there. Only the manager needs an inbound HTTPS endpoint. The development host can remain behind NAT, with its application ports bound to `127.0.0.1`. IPv6 loopback is supported by listing `http://[::1]:PORT` in the task's URLs. Declared preview ports must be 1024–65535.

For local source development only, `http://preview.localhost:43188` is accepted. Production continues to require HTTPS. This does not change production enrollment/TLS validation.

## Project configuration

Headless services use the existing `.machdoch/run.json` version 2 format:

```json
{
  "schemaVersion": 2,
  "configurations": [
    {
      "id": "web",
      "name": "Frontend",
      "kind": "task",
      "primary": false,
      "command": "pnpm run dev --host 127.0.0.1 --port 5173 --strictPort",
      "workingDirectory": "frontend",
      "ports": [5173],
      "urls": ["http://127.0.0.1:5173"]
    },
    {
      "id": "api",
      "name": "Backend",
      "kind": "task",
      "primary": false,
      "command": "pnpm run dev",
      "workingDirectory": "backend",
      "environment": { "PORT": "3000", "HOST": "127.0.0.1" },
      "ports": [3000],
      "urls": ["http://127.0.0.1:3000"],
      "healthCheck": {
        "kind": "http",
        "url": "http://127.0.0.1:3000/health",
        "restartOnFailure": true
      },
      "restartPolicy": {
        "onCrash": true,
        "maxRestarts": 5,
        "windowMs": 60000,
        "backoffMs": 1000,
        "maxBackoffMs": 30000
      }
    },
    {
      "id": "application",
      "name": "Application",
      "kind": "composite",
      "primary": true,
      "children": ["api", "web"],
      "startOrder": "sequence"
    }
  ]
}
```

Install dependencies before starting commands. Keep servers in the foreground; do not daemonize them or hand them to a second supervisor. Version 1 files should be migrated using the desktop run editor before using them headlessly. Commands are explicit owner-authorized code running as the service account, not an OS sandbox. A malicious command has that account's filesystem and network privileges. Use the dedicated unprivileged account and systemd controls described in [background service setup](fleet-background-service.md), or containers/VMs for stronger isolation.

Configuration is never executed merely because a repository was cloned or a page opened. Saves require the current revision and all project services stopped. The editor preserves existing redacted environment values; changing a variable supplies a new value and removing it deletes the override. Snapshot and output redaction covers configured environment values, not secrets printed from arbitrary files or included directly in command text. Put secrets in environment overrides or a suitable project secret store, never in the command field. Inherited environment names containing `SECRET`, `TOKEN`, `PASSWORD`, or `API_KEY`, plus Machdoch/Fleet supervisor variables, are excluded from project commands; explicitly supply required project variables.

The supervisor validates workspace membership, confines working directories, rejects linked configuration directories/files, checks for occupied ports before launch, and reserves declared ports between active tasks. Only a live supervised task's declared ports can be tunneled. The feature does not scan or expose arbitrary host services. Local processes running as the same OS user are not separated by these checks; use OS isolation when running untrusted code.

## Frontend plus backend

Before opening a frontend preview, expand **Connect a backend to the next preview**, select its running backend and choose a path such as `/api`. The frontend should request relative URLs (`fetch('/api/items')`). The path is preserved by default; **Remove the prefix** forwards `/api/items` as `/items` instead. Matching respects path-segment boundaries and includes WebSocket upgrades. Additional routes, including landing pages and socket endpoints, can be supplied through the preview API, up to eight per preview. Prefer separate origins for applications requiring their own root path.

Each preview gets its own random host and full root path, so root-relative scripts, assets and app cookies work. Set dev-server host allowlists to the preview domain you control; do not disable host validation globally. For Vite, use `server.allowedHosts: ['.preview.example.net']`, bind loopback, enable `strictPort`, and ensure HMR uses the browser's public host/HTTPS port rather than a hard-coded LAN address. The same principle applies to Django `ALLOWED_HOSTS`, framework trusted-proxy settings and OAuth callback allowlists. Absolute URLs embedded in HTML/JavaScript and application-specific OAuth configuration are not automatically rewritten. Loopback HTTP `Location` redirects for the selected port are rewritten to the preview origin.

Independent preview origins do not receive permissive cross-origin credentials/CORS. Use path routing for frontend/backend integration. Do not route mutually untrusted applications under one preview origin: they intentionally share its browser trust boundary.

## Lifecycle, security and limits

- A CSRF-protected owner action creates a one-use launch credential, valid for 60 seconds. A narrowly scoped manager launch page removes the URL fragment before submitting it to the preview via POST. Credentials are not placed in query strings. The main manager page keeps its original restrictive CSP.
- The preview uses its own host-only, Secure, HttpOnly cookie. Manager and preview authentication cookies are stripped before forwarding to project servers; reserved cookies cannot be set by upstream responses. Application cookie `Domain` attributes are removed. Browser WebSockets require the exact preview origin. Foreign-origin fetches are rejected.
- Grants expire after one hour. Logout, password/session revocation, host disconnect/reconnect, explicit **Close preview**, or manager shutdown invalidates access. Live streams are closed within the one-second revocation sweep. Preview activity does not extend the manager login's idle deadline. Closing a preview does not stop the project server. Restarting a project closes old streams; reload its still-authorized preview when the new process is ready.
- Traffic uses separate authenticated, one-use outbound WebSocket connections, not JSON snapshot payloads. Node streams provide backpressure. Hop-by-hop HTTP headers and client-supplied forwarding headers are filtered. Forwarded host/protocol describe the public preview; the relay does not bypass certificate verification or resolve arbitrary destinations.
- Limits: 16 active tasks per host; 32 configurations per project; 1 MiB configuration files; 64 retained run states; 80 log entries per task, each at most 1024 characters and 64 KiB total; 128 command receipts per service process. Status polling runs every three seconds only while the page is visible; log payloads are requested only while a log panel is open. Host CPU is sampled every five seconds.
- Limits: 64 preview grants per manager; 128 simultaneous streams per manager, 32 per host, 24 per preview; eight additional routes; 100 MiB uploads; 32 KiB upstream headers; bounded WebSocket frame/stream buffers. Opening a tunnel times out after 12 seconds; upstream headers after 30 seconds. Streams end no later than grant expiry. Large downloads and SSE are not accumulated as whole responses. The HTTP server currently allows 30 seconds to receive request bodies; large uploads on slow connections may hit that deadline before the byte limit.
- TCP/HTTP health probes run every five seconds with bounded deadlines. Three failures mark a service unhealthy. Optional health/crash restarts have exponential backoff and a windowed restart limit. A sequential composite waits for each child's configured health check (or running state without a check), up to 150 seconds, before starting the next. It is a service startup order, not a build dependency executor. Cancellation does not leave later children queued to start.
- Run state/logs and preview grants are in memory. Fleet service restart stops managed processes; services require an explicit new start afterward. Manager restart revokes preview grants while project servers continue running. Automatic process-tree cleanup uses POSIX process groups or Windows `taskkill /T`; abrupt host termination and deliberately detached/daemonized descendants require OS supervision. Linux systemd's cgroup supplies final cleanup when the service is killed. Windows does not currently provide a Job Object boundary for this Node supervisor.

## Research behind the design

Coder documents owner-private application forwarding and wildcard application domains, and warns that path-based apps can access its control-plane API. That supports isolating project origins from the Fleet Manager origin instead of serving arbitrary project HTML beneath `/api/preview`. [Coder port forwarding](https://coder.com/docs/admin/networking/port-forwarding), [Coder security/configuration reference](https://coder.com/docs/admin/setup/configuration-reference).

Host-prefixed cookies bind authentication to the exact host. HTTP intermediaries must remove connection-specific headers. These informed the cookie and header boundaries in the relay. [MDN secure cookies](https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/Cookies), [RFC 9110, section 7.6.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-7.6.1).

The transport uses the installed `ws` package's stream adapter rather than an unbounded custom message queue. Deployment needs explicit WebSocket forwarding and streaming proxy settings; development frameworks still need proper host allowlists. [ws stream API](https://github.com/websockets/ws/blob/master/doc/ws.md), [Nginx WebSocket proxying](https://nginx.org/en/docs/http/websocket.html), [Nginx buffering](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering), [Vite server options](https://vite.dev/config/server-options.html).

## Verification

`fleet-runs.spec.ts` exercises real process lifecycle, redaction, revision conflicts, workspace/port boundaries, crash limits and cleanup. `previews.test.ts` uses real HTTP and WebSocket servers for uploads/downloads, SSE, WebSocket subprotocols, API routing, cookie/header isolation and revocation. API/config tests cover authentication and deployment validation.

`pnpm verify:fleet-previews` runs a real headless runtime through an isolated Fleet Manager and Puppeteer. It creates and controls project servers, opens a private frontend with backend routing and HMR, verifies restart/stop/close behavior, and checks mobile/desktop layouts. Use the isolated fixture credentials/environment documented in `scripts/verify-fleet-previews.ts`; configure `http://preview.localhost:43188` on that development-only manager. It revokes its enrolled instance and removes its temporary project on completion. `scripts/verify-fleet-runs-smoke.ts` additionally verifies process and descendant cleanup on Windows and, when bundled, inside a Linux container.
