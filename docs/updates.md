# Updating Machdoch

The desktop app checks GitHub's latest stable release on startup and every six hours. Install with **Update and restart**, or silence the dialog for one hour, one day, one week, or the displayed release. Skipping a release does not suppress the next one. Desktop settings also include **Check for updates**, which ignores reminder preferences for that check.

In a terminal:

```sh
machdoch update --check
machdoch update
machdoch update --check --json
```

Updates retain the installation type: MSI, NSIS, Debian, RPM, AppImage, or headless. Linux package updates need administrator access. Restart independently running CLI or Fleet services after updating. Source checkouts use Git instead of self-update.

Versions released before this updater need one manual installation of a release containing it.

## Research and design

Research performed on 2026-10-07 against the published Tauri updater 2.13.1 and CLI 2.12.1, GitHub documentation, and Minisign documentation.

GitHub's `releases/latest/download/latest.json` resolves the manifest from the release marked latest. Artifact URLs inside it use the exact version tag, preventing a release published during a download from changing which package is fetched. Hosting a static manifest also avoids unauthenticated REST API polling and its rate limits. [GitHub release links](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases), [GitHub REST practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).

The desktop uses the maintained Tauri updater rather than replacing installer logic. Its native bundle detection selects the correct installer type and architecture. Updates require a signature from the embedded public key, HTTPS transport, and a newer semantic version. Windows uses the updater's passive installer mode. [Tauri updater documentation](https://v2.tauri.app/plugin/updater/), [published updater API](https://docs.rs/tauri-plugin-updater/2.13.1/tauri_plugin_updater/).

Artifact signatures also authenticate their release version. `requireSignedVersion` prevents a modified manifest from announcing a new version while supplying a valid signature for an older artifact. The CLI verifies Minisign's BLAKE2b prehash, Ed25519 artifact signature, global signature over the trusted comment, key identifier, and signed version, using Node's cryptographic primitives. SHA-256 and exact byte counts additionally detect incomplete downloads. [Tauri signer source](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-cli/src/helpers/updater_signature.rs), [Minisign](https://jedisct1.github.io/minisign/).

The headless package contains `releases/<version>` and a `current` file. Downloads are verified before extraction. Extraction rejects traversal, links, special files, duplicate entries, and excessive expansion. Package metadata, the required Node version, essential files, and the bundled CLI startup are checked before activation. Files are synchronized before atomically replacing `current` on the same filesystem. The previous release remains present; existing processes finish using their original files.

Desktop installation checks activity before downloading and immediately before installation, and flushes session persistence. CLI and desktop installations share an installation-specific process lock. Automatic network failures do not interrupt normal desktop use; manual checks show errors and a retry action.

## Release operation

The release workflow builds packages in a draft release, signs the canonical assets, verifies signatures against the committed public key, generates the complete manifest, and checks that every package, signature, and manifest exists before publication. Published releases cannot be rebuilt in place. Publication explicitly marks the completed release latest.

GitHub Actions requires `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; both have been configured for `pureportal/machdoch`. The encrypted signing key and password backup are stored outside this checkout under the releasing user's local application data in `machdoch/release-signing`, with restricted filesystem access. Back up that directory securely. The private key must remain consistent with the public key embedded in installed applications.

The installer workflow uses the same signing and verification steps. All seven current package types have distinct manifest targets. macOS and other architectures are not advertised because this repository does not publish those packages.

Tauri 2.12 is required for signed release versions and installer-specific targets. The development MCP bridge is pinned to the upstream Windows dependency fix at commit `be7c1d1e86f7f9fc0514f7de588313a3e0407ac9`. [Upstream fix](https://github.com/hypothesi/mcp-server-tauri/pull/49).

## Recovery and limits

| Condition                                                   | Result                                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| Offline, timeout, missing manifest, HTTP failure            | No files changed; retry later                                              |
| Invalid signature, hash, length, URL, or signed version     | Installation rejected; staged download removed                             |
| No newer release                                            | No installation, including when the latest tag is older                    |
| Unsupported installation or architecture                    | Explicit error                                                             |
| Extraction, metadata, runtime, permissions, or disk failure | Headless active release remains intact                                     |
| Concurrent update                                           | Installation lock rejects the competing updater                            |
| Running desktop work                                        | Installation waits for the user to finish it                               |
| Reminder cannot be saved                                    | Dialog stays open with an error                                            |
| Installer launched on Windows                               | CLI reports `installerStarted`; completion belongs to the native installer |
| Restart fails after desktop installation                    | Dialog offers another restart attempt                                      |

Operating-system installers own their installation transaction and elevation UI. This updater does not promise rollback of external package-manager actions. Windows installer downloads stay in their temporary directory while the detached installer runs. Headless releases are retained so running processes remain valid; administrators can remove inactive releases after stopping processes that use them.

Live end-to-end updating requires two published releases containing this updater and signed assets. The pre-updater 29.2.0 release has no update manifest, so it cannot provide that validation target.
