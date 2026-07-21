# Encrypted settings file transfer

Status: implemented

Investigated: 2026-07-21

Re-audited: 2026-07-21

## Product flow

The Settings **Transfer** panel exposes four peer actions: the existing **Transfer Settings** and
**Receive Settings** local-network flow, plus **Export Encrypted File** and **Import Encrypted
File**.

- Export uses the same closed category catalog, availability inspection, safe defaults, counts,
  sensitivity labels, and complete snapshots as local-network transfer. The user selects categories,
  enters and confirms a passphrase, then chooses a `.machdoch-settings` destination. Empty selected
  categories are represented explicitly and will clear that category when imported. Categories that
  cannot produce a valid complete snapshot are shown as unavailable and omitted without dropping
  other valid selections, matching the direct-transfer offer. The native save dialog owns overwrite
  confirmation; the backend accepts only a regular-file destination, writes a same-directory
  temporary encrypted file, atomically replaces the destination, and verifies the result.
- Import starts with the same receiver-side category choices. The user chooses a file and enters its
  passphrase. Machdoch decrypts and validates the complete file before showing the same replace,
  clear, keep-not-selected, and keep-not-offered review. The passphrase field is cleared as soon as
  inspection is submitted. A separate **Replace selected settings** action is required before any live
  setting changes.
- Closing or leaving the file-import screen invalidates an inspection and discards any pending
  decrypted payload. Each inspection has a random operation id; scoped cancellation tombstones make
  teardown safe even if its IPC command reaches the backend before the inspection command, and one
  window cannot cancel another window's review. The backend checks cancellation immediately after
  authentication, again after payload validation, and between local snapshot/preview stages. Pending reviews are
  evicted by a backend timer after ten minutes even if no later command is invoked, with command-time
  expiry checks as a fallback. Consuming or cancelling a review also cancels its detached expiry
  task, so repeated retries do not accumulate sleeping tasks. One backend operation lease spans the
  complete network session or file export/review/import lifecycle, so network and file operations
  cannot race or run concurrently.

The transferable catalog remains the source of truth:

1. API keys
2. agent and provider preferences
3. desktop and appearance preferences
4. global memory
5. global instruction files
6. global prompts
7. global MCP servers and marketplace registries
8. global RALPH flows and their instruction files

Workspace-scoped data remains deliberately unsupported. Import is complete replacement per selected
category, never merge. Unselected and unavailable categories remain unchanged.

## Passphrases and sensitive data

Export requires matching passphrases of 12 or more Unicode scalar values (maximum 1,024 UTF-8
bytes). The UI recommends a unique multi-word passphrase and does not persist it. Import accepts the
exact UTF-8 sequence used at export. Machdoch does not normalize, trim, log, store, or place a
passphrase in an event, and the fields request that the webview not autocomplete credentials. Rust
passphrase request strings (including validation and busy-operation exits), backend review
capability tokens, derived
keys, serialized plaintext, and decrypted or failed-authentication buffers are explicitly zeroized
on their normal drop paths; category payload objects use the same recursive zeroization as network
transfer. Export releases the passphrase, plaintext JSON, and plaintext category graph before
destination I/O begins. Import releases the passphrase and encrypted input buffer before parsing
the authenticated plaintext, then releases the plaintext bytes before receiver snapshot and
transaction-preview work begins. JavaScript strings cannot be reliably zeroized, so the UI keeps
them only long enough to submit the active operation and immediately clears the rendered field
state. Unavoidable JavaScript closure and IPC copies may remain until the request settles. Operating-system
copies, crash dumps, allocator remnants, and swap remain residual platform risks.

The UI computes the UTF-8 byte bound before invoking the backend, disables passphrase fields while a
dialog, KDF, or commit is active, and uses an immediate in-flight guard in addition to disabled
controls. The backend independently enforces every bound and operation lease; UI state is not a
security boundary.

Each export derives a fresh 256-bit key with Argon2id v1.3 using a random 16-byte salt, 65,536 KiB of
memory, three passes, and one lane. These settings exceed OWASP's current minimum Argon2id profile;
the salt length follows RFC 9106. The derived key encrypts exactly one file and is never persisted.
Anyone who obtains the file can still make offline passphrase guesses: the memory-hard KDF raises
the cost of each guess but cannot compensate for a short, reused, or predictable passphrase.
Machdoch then uses RFC 8439 ChaCha20-Poly1305 with a fresh 96-bit nonce and the full 128-bit tag. A
fresh salt creates a new key for every export; the independently random nonce is still required and
stored in the header. The exact binary preamble and serialized header are authenticated as AEAD
additional data, so algorithm, KDF, size, and content-type metadata cannot be changed undetected.

References:

- [RFC 9106: Argon2 Memory-Hard Function](https://www.rfc-editor.org/rfc/rfc9106.html)
- [RFC 8439: ChaCha20 and Poly1305 for IETF Protocols](https://www.rfc-editor.org/rfc/rfc8439.html)
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)

## Version 1 container

All integers in the binary prefix are unsigned big-endian values. The file is:

```text
magic "MACHDOCH-SETTINGS\n"
container version: u16 (= 1)
JSON header length: u32
strict UTF-8 JSON header
ChaCha20-Poly1305 ciphertext || 16-byte tag
```

The bounded header records only the fixed Argon2id parameters and salt, fixed
ChaCha20-Poly1305 algorithm and nonce, payload media type/schema, plaintext size, and ciphertext
size. It contains no category names, counts, setting values, device name, or application patch
version. The encrypted payload is strict JSON containing payload schema version 1, a random export
identifier, creation time, and the canonical category snapshots used by network transfer.
The authenticated creation time is informational and bounded to the exact JavaScript `Date` range;
it does not expire a portable file or require the exporting and importing machines to have
synchronized clocks. Review tokens use a fresh importing-machine deadline instead.
The container necessarily reveals that it is a Machdoch settings file, its cryptographic profile,
and its total encrypted/plaintext length; it does not attempt traffic-analysis resistance or padding.

Import first checks the magic, outer version, bounded lengths, exact file length, strict header
shape, supported algorithms, fixed version-1 KDF parameters, canonical base64url encodings, and size
limits. These checks occur before the memory-hard KDF, preventing attacker-selected work factors.
Version 1 readers accept only the version 1 profile. Future writers must use a new outer version for
incompatible container or cryptographic changes; readers route on the outer version before parsing
that version's header. Category schemas remain independently versioned. Newer applications retain
the version 1 reader while they support its category schemas; unknown outer versions or category
schemas fail closed without importing a subset.

## Validation and atomicity

Malformed containers and unsupported versions have distinct, non-sensitive errors. Once a container
passes those structural and fixed-profile checks, authentication failure intentionally combines a
wrong passphrase with header/ciphertext tampering: neither case reveals whether a guessed passphrase
was correct. AEAD authentication must succeed before JSON is parsed. The complete decrypted payload
then passes the existing strict category schemas, path and scope rules, duplicate checks, item/byte
caps, semantic count checks, and per-category SHA-256 completeness checks.

Only after validation does Machdoch compute the requested/offered intersection and capture the
receiver preview fingerprint. Current-item counts for effective categories come from that same
authoritative fingerprint capture, replacing any earlier catalog count so the displayed review and
commit precondition describe one receiver state. Approval rechecks the ten-minute review and passes the filtered
canonical envelope to the existing transaction service. That service takes cooperative locks,
recaptures the preview fingerprint, writes a short-lived plaintext payload and rollback data under
the protected user-config staging directory (mode `0700`/`0600` on Unix) plus a value-free
write-ahead journal, applies every category, reads every category back, and either commits all of
them or restores and verifies the complete backup. Staging is removed after verified commit or
rollback; if the process crashes, startup recovery consumes it before settings-dependent services
start. Wrong credentials, malformed/tampered data, unsupported versions, cancelled review, receiver
edits after review, write failures, and verification failures therefore cannot produce an accepted
partial import. A compromised account or machine can still read passphrases, live settings, or this
short-lived recovery material; file encryption does not defend a running compromised endpoint.
If an in-process rollback cannot be verified, the UI does not recommend a blind re-import: it tells
the user to restart immediately so startup recovery can consume the retained journal and backup.
Graceful application exit observes both network and file operation leases. Once a file import enters
its non-interruptible prepare/commit path, shutdown uses the same 15-minute commit/rollback grace
period as direct transfer; a forced process or OS termination still relies on the startup journal
recovery described above.

Export replacement is atomic at the destination namespace: readers see the old complete file or the
new complete ciphertext, never a partially written destination. Post-rename verification streams the
published file through a fixed-size buffer and checks its exact byte length and SHA-256 digest, rather
than allocating a second container-sized buffer. If reopening the new destination for verification
fails, the command reports failure but does not attempt to reconstruct the previous destination. A
process or OS crash can also leave a same-directory encrypted temporary file; it contains ciphertext,
not plaintext settings. Durable-rename and permission behavior still depends on the destination
filesystem and platform.

## Drift prevention

Network and file paths share `SettingsCategoryId::ALL`, category metadata, snapshot adapters,
double-read collection under the same cooperative locks, category serialization, strict validators,
zeroization helpers, preview fingerprints, prepared transactions, rollback/read-back verification,
and post-import reload events. The file container wraps those canonical snapshots; it does not define
a second settings DTO. Adding a future globally transferable category requires one canonical catalog
entry and snapshot/apply validation support, after which both transfer selectors and both transports
see it through the shared catalog and service tests. A committed version-1 fixture with fixed KDF
and cipher material pins the exact container bytes and is also decrypted by the reader test, catching
accidental writer drift or loss of backward-read compatibility.
