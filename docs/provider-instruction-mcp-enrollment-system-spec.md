# Provider Instruction and MCP Enrollment

Status: implemented
Last implementation review: 2026-08-04

## Boundaries

Instruction delivery and MCP projection share a run-scoped adapter but remain
different data domains:

- Machdoch resolves central instruction files and delivers their complete
  frozen envelope as system/developer prompt content.
- MCP projection supplies enabled MCP server configuration and bounded server
  initialization hints.
- Persistent provider synchronization, when enabled, manages MCP entries only.
  It never reads, writes, projects, reconciles, or owns instruction files.

## CLI enrollment

Every delegated run creates an owner-private temporary root and probes the
actual provider executable before launch. The probe-selected route must match
the preflight delivery plan or execution stops.

| Provider    | Instruction route                              | User prompt route    |
| ----------- | ---------------------------------------------- | -------------------- |
| Codex CLI   | isolated `CODEX_HOME` `developer_instructions` | `codex exec -` stdin |
| Claude CLI  | `--append-system-prompt-file`                  | stdin                |
| Copilot CLI | isolated custom agent                          | stdin                |

Provider-native workspace instructions are disabled or isolated where the
provider supports it. Native inventory is diagnostic only and never becomes a
Machdoch instruction source.

The materializer records digests, route, capability evidence, and content
coverage in a run manifest. It removes the temporary root on failure and
exposes one disposal function for normal completion; stale roots are bounded
and cleaned after abnormal termination.

## Fidelity

Delivery is allowed only when the adapter can supply the complete resolved
content without truncation. Instruction content never travels as a user
message, command-line argument, environment variable, or instruction to open a
prompt file. A run-scoped file is used only when the provider explicitly
supports that file as its native system-instruction channel.

MCP policy, credentials, and generated provider configuration do not alter
instruction selection. Instructions do not grant tools, filesystem access,
network access, or permission bypasses.
