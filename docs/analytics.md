# Machdoch analytics

Swetrix runs at https://swetrix.pureportal.io. The integrations use its public collection API directly; the management API key is never included in the applications. Analytics are off until someone chooses **Share usage and diagnostics**. Development builds remain off.

| Application                             | Private project | Consent control                                     |
| --------------------------------------- | --------------- | --------------------------------------------------- |
| Landing page                            | `kUVZeJbmLZnJ`  | Footer → Analytics                                  |
| Fleet manager and embedded device tools | `CPs0D0S7QOfV`  | Privacy; also collapsed below sign-in               |
| Desktop and CLI                         | `6UblQ7EkvVkW`  | Settings → Privacy; explicit CLI environment opt-in |

Consent is separate for each application, remembered for six months, and tied to notice revision `machdoch-analytics-2026-10-10`. The fleet manager and its same-origin embedded tools share their choice. Withdrawal aborts requests, disconnects performance and exposure observers, removes event listeners, and prevents delayed operation results from being reported. Do Not Track and Global Privacy Control disable browser analytics. The integration's only browser storage is the consent choice, not an analytics identifier. No analytics cookie, offline queue, session replay, identity API, or DOM autocapture is used.

## Coverage

- Page views, static application views, visible active time, heartbeats, and scroll milestones.
- Feature exposure, use, and exposed-but-unused summaries. Explicitly annotated visible controls establish exposure; hidden or disabled controls do not.
- Landing download conversions by distribution, GitHub clicks, and download funnel.
- Chat, voice, Ralph, scheduler, instructions, MCP, workspaces, terminal, files, Git, media generation, library, workflows, training, models, settings, fleet enrollment, user administration, and copilot actions.
- Operation starts, completion, failure, and duration. Background lists, status queries, progress polling, terminal output, and keystrokes are excluded. A resolved command means the API operation completed; it does not imply a successful background job.
- Observed desktop and media job completion, failure, and cancellation. Only jobs observed active after consent receive an outcome. Their duration covers the observed interval, not time before observation.
- Navigation DNS, TLS, connection, response, rendering, DOM load, page load, and TTFB timings; LCP, FCP, CLS, INP, and TTFB observations where the browser or webview exposes them.
- Scrubbed JavaScript errors: standard error class and bundled JavaScript filename/line/column. Messages, function names, machine paths, and source hostnames are removed.

Every event includes only fixed application, release, and surface values plus an explicit metadata allowlist. Device, job, session, workspace, file, model, provider, account, and user identifiers are not sent. Neither prompts, responses, filenames, URLs with queries, form values, DOM text, nor application content are sent. Ephemeral job IDs are used only inside the running application to deduplicate outcomes. Static device route templates replace device IDs. Referrers and credentials are omitted.

Swetrix still receives network IP addresses and user agents and can derive device, browser, operating system, location, and pseudonymous visitor/session information. Cookie-free does not mean anonymous or exempt from privacy law. Cloudflare and hosting providers remain processors even though PurePortal operates Swetrix itself.

## Interpreting the dashboards

Each project has Feature adoption, Page performance, Web vitals, Load and engagement, Operation latency, and Job outcomes views. Landing has a download funnel, fleet has a device-opening funnel, and software has automation and media funnels. Swetrix's regular traffic, live visitors, session journeys, error analysis, metadata filtering, and geographical/device breakdowns work on the same events.

Use `feature.summary` grouped by `feature` and `used` to compare adoption among people who saw a feature. Exposure and use events can also show activity volumes. Multiple actions may produce multiple use events. These numbers describe consenting users and observed views; they do not establish non-use across every installation. Small or heavily filtered populations should not be used to identify individuals.

Performance measurements depend on available browser APIs. CLS and INP cover the consenting observation interval. INP uses event timing and interaction counts where exposed; browsers without counts provide an estimate. Unsupported metrics are omitted. Remembered consent starts collection after navigation finishes so page-loading statistics are complete. Repeated web-vital updates are observations, not separate visitors; filter by metric before averaging.

Collection is bounded to 16 concurrent requests, 240 requests per minute, 10 distinct scrubbed errors per minute, and five-second request timeouts. Delivery failures never fail user operations. Heartbeats stop while hidden or after five minutes without interaction. There is no retry or background upload after withdrawal.

## CLI choice

After reading https://pureportal.io/privacy and the Machdoch notice, a user can explicitly enable CLI usage and diagnostics:

```powershell
$env:MACHDOCH_ANALYTICS_CONSENT = 'machdoch-analytics-2026-10-10'
machdoch run
```

Remove the environment variable to withdraw. Bash uses `export MACHDOCH_ANALYTICS_CONSENT=machdoch-analytics-2026-10-10` and `unset MACHDOCH_ANALYTICS_CONSENT`. Commands, arguments, prompts, and output are never serialized into telemetry; only the fixed command category and its outcome/duration are sent. The variable is an explicit choice, not an installation default. Do not set it centrally on behalf of employees. CLI `help`, inspection, and other unlisted categories send nothing.

## Administration

Supply `SWETRIX_API_KEY` to the current shell through your secret-management process. It is used only by these commands:

```text
node --experimental-strip-types scripts/analytics/configure-swetrix.mjs
node --experimental-strip-types scripts/analytics/verify-swetrix.mjs
node --experimental-strip-types scripts/analytics/verify-browser.mjs
node --experimental-strip-types scripts/analytics/enforce-retention.mjs
```

Configuration is repeatable and affects only the three explicit Machdoch projects. Verification reads each saved view's metrics and the custom-event charts. The browser verification serves the production landing build through Playwright routing, uses a temporary private project, checks ingestion and statistics, and deletes the project afterward. It does not download installers or start a server. Build the landing page first with its real `MACHDOCH_LANDING_URL`.

The browser projects currently have no domain allowlist because their deployment domains were not supplied. Set the real landing/fleet hostnames in Swetrix before publication. The software project allows `tauri.localhost`, `localhost`, and `127.0.0.1`. All projects have basic bot protection; verification disables it only on the temporary headless-browser project.

## Privacy and release requirements

PurePortal's published policy, checked on 10 October 2026, expressly requires opt-in before Swetrix initializes. This implementation follows that approach, with one optional control in existing privacy/settings locations and no banner or startup dialog. Necessary consent-preference storage is distinct from optional analytics processing.

GDPR Articles 5, 6, 7, 13, and 25 require a specified purpose, lawful basis, informed and demonstrable consent, transparency, minimization, and appropriate defaults. German TDDDG §25 separately regulates storing/accessing terminal information; avoiding cookies alone does not settle that question. Ownership of the analytics service does not create a consent exemption. Fleet administrators cannot provide consent for other users, and analytics must remain optional without reducing product access.

Two deployment requirements remain blocked:

1. The linked policy currently describes `pureportal.io`, not the Machdoch landing page, fleet manager, desktop, and CLI. Publish the Machdoch scope, actual processors, data categories, retention, withdrawal method, and rights in that policy before production use. The repository has no access to the policy website. See `analytics-privacy-notice.md` for the publication draft and required unresolved retention detail.
2. Automatic retention is not enforced. The supplied retention command deletes data older than 90 days, and systemd unit/timer definitions are included, but the installed Swetrix partial-deletion API returns HTTP 500, including for empty historical ranges. Repair that endpoint or implement and verify a ClickHouse TTL covering analytics, errors, profiles/session data, auxiliary records, backups, and logs. Do not publish a promise of 90-day retention until it actually runs. Do not enable the supplied timer while deletion is broken.

Keep the production integration opt-in, verify the published notice and retention first, and document the consent and processing arrangements. The management API provides no access to publish the company policy or repair the Swetrix host. Cookie-free operation and passing technical tests do not by themselves establish GDPR compliance.

## Sources

- [PurePortal privacy policy](https://pureportal.io/privacy)
- [Swetrix documentation](https://swetrix.com/docs/)
- [Events API](https://swetrix.com/docs/events-api)
- [Admin API](https://swetrix.com/docs/admin-api)
- [Swetrix script reference](https://swetrix.com/docs/swetrix-js-reference)
- [Funnels](https://swetrix.com/docs/analytics-dashboard/funnels)
- [German TDDDG §25](https://www.gesetze-im-internet.de/ttdsg/__25.html)
- [German supervisory authorities' digital-services guidance](https://www.datenschutzkonferenz-online.de/media/oh/OH_Digitale_Dienste.pdf)
- [GDPR](https://eur-lex.europa.eu/eli/reg/2016/679/oj)
- [European Data Protection Board consent guidance](https://www.edpb.europa.eu/sites/default/files/files/file1/edpb_guidelines_202005_consent_en.pdf)
