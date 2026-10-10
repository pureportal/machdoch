# Machdoch analytics notice — publication draft

This draft is for extending https://pureportal.io/privacy. It is not published or linked as an effective policy. Confirm the actual hosting, Cloudflare processing arrangements, international transfers, security-log retention, and backup deletion periods. Replace the unresolved retention paragraph with the verified period before publication. Do not publish the planned 90-day period until deletion is enforced.

## Optional analytics in Machdoch

PurePortal is responsible for analytics on the Machdoch landing page, fleet manager, desktop application, and command-line application. The controller and contact details are listed in our [privacy policy](https://pureportal.io/privacy).

If you choose **Share usage and diagnostics**, we use our own Swetrix service at `swetrix.pureportal.io` to understand which features people use, improve performance, and investigate application errors. The legal basis is your consent under GDPR Article 6(1)(a). Where access to information on your device requires consent, the basis is TDDDG §25(1). Analytics are optional and do not affect your access to Machdoch.

We receive page and feature categories, feature exposure and use, distribution choices, application version, browser/device information, language, time zone, approximate location, activity and performance measurements, operation and observed job outcomes, and scrubbed error types with bundled-code locations. Network requests expose your IP address and user agent to the service and its infrastructure. Swetrix derives pseudonymous visitor and session information from network information.

We do not collect prompts, conversations, generated content, files, paths, account or device identifiers, entered form values, or command arguments through this integration. We do not record your screen, replay sessions, identify you by name, or set analytics cookies. A local preference records your choice for six months; a changed notice or an expired preference requires a new opt-in.

The service is operated by PurePortal. Our infrastructure providers process network requests on our behalf; the hosting, Cloudflare processing, and transfer arrangements described in the privacy policy must be confirmed to cover this service.

**Retention must be completed before publication:** state the period actually enforced for analytics, diagnostic errors, pseudonymous session/profile records, infrastructure logs, and backups. A 90-day analytics deletion command has been prepared, but the deployed service currently rejects deletion requests.

You can withdraw at any time in the landing page's Analytics control, the fleet manager's Privacy page, or desktop Settings → Privacy. For CLI analytics, remove `MACHDOCH_ANALYTICS_CONSENT` from your environment. Withdrawal stops future collection and does not affect processing that occurred while consent was valid. Do Not Track and Global Privacy Control disable browser collection.

Your rights to access, correction, erasure, restriction, portability, and to complain to a supervisory authority, together with the controller's contact details, are described in the privacy policy. Contact PurePortal for a request concerning previously collected data; do not assume that withdrawing a device preference automatically erases earlier server records.
