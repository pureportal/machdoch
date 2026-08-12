# Workspace Run

Workspace Run is Machdoch's canonical system for starting and supervising applications and servers. The Rust desktop process owns configuration persistence, process trees, health monitoring, restart policy, logs, and live state. Workspace Management, chat, and AI tools all read and mutate that same manager.

## Architecture

```text
.machdoch/run.json
        |
        v
RunManager (Tauri/Rust) ---- state snapshots + log batches ----> React surfaces
        |
        +---- process supervisor ----> cmd.exe /D /S /C (Windows)
        |                              /bin/sh -c (Linux/macOS)
        |
        +---- authenticated 127.0.0.1 bridge ----> agent run tools
        |
        +---- bounded AI snapshot ----> conversation context
```

The manager resolves and canonicalizes the active workspace before every operation. A task's `workingDirectory` must be relative, exist, and remain inside that workspace after canonicalization. Commands therefore start from the selected workspace on Windows and Linux, including child-package directories.

Runtime state is keyed by canonical workspace and configuration id. Starting an active task is idempotent, so a composite, Workspace Management, chat, and the AI cannot create duplicate instances of the same saved task. Operations are serialized per workspace without blocking independent workspaces. React surfaces receive coalesced state and output events and perform a low-frequency reconciliation poll so window or event timing cannot leave a stale control visible.

The desktop process injects a fresh, size-bounded `workspaceRun` snapshot into each chat task. Environment names remain visible, but their values and occurrences of those values in commands, diagnostics, health results, and captured output are redacted from AI context and tool results. Dedicated agent tools then query live state or start, stop, and restart configurations through a random-token loopback bridge. The bridge address and token are process environment values used by tool implementations and are not placed in model-visible context. Ask mode receives only status and draft-detection tools; lifecycle mutations require Machdoch mode.

## Configuration model

Run documents use schema version 1 and live at `.machdoch/run.json`.

```json
{
  "schemaVersion": 1,
  "primaryConfigurationId": "fullstack-start",
  "configurations": [
    {
      "id": "backend",
      "name": "Backend",
      "kind": "task",
      "command": "pnpm run dev",
      "workingDirectory": "backend",
      "environment": {},
      "hotReload": true,
      "ports": [3000],
      "urls": ["http://localhost:3000"],
      "healthCheck": {
        "kind": "http",
        "url": "http://localhost:3000/health",
        "startupDelayMs": 3000,
        "intervalMs": 5000,
        "timeoutMs": 2000,
        "failureThreshold": 3,
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
      "id": "frontend",
      "name": "Frontend",
      "kind": "task",
      "command": "pnpm run dev",
      "workingDirectory": "frontend",
      "environment": {},
      "hotReload": true,
      "ports": [5173],
      "urls": ["http://localhost:5173"],
      "restartPolicy": {
        "onCrash": true,
        "maxRestarts": 5,
        "windowMs": 60000,
        "backoffMs": 1000,
        "maxBackoffMs": 30000
      }
    },
    {
      "id": "fullstack-start",
      "name": "Fullstack Start",
      "kind": "composite",
      "children": ["backend", "frontend"],
      "startOrder": "parallel"
    }
  ]
}
```

Task configurations carry the command, workspace-relative directory, environment, hot-reload capability, known ports and URLs, optional TCP or HTTP health check, and bounded restart policy. Composites reference task ids and start in parallel by default; sequence is available when service order matters. The primary configuration is the one surfaced in chat and at the top of Workspace Management.

Validation rejects duplicate or missing ids, nested or overlapping composites, paths outside the workspace, invalid health targets, duplicate or invalid ports and URLs, unbounded timings, excessive restart limits, and documents larger than 1 MB. Configuration changes are blocked while workspace tasks are active.

## Lifecycle and reliability

A task moves through `stopped`, `starting`, `running`, `unhealthy`, `restarting`, `crashed`, and `stopping`. A successful zero-code exit remains canonically `stopped` and is presented as Completed. A composite derives its state from its children and exposes every child snapshot, including partial running and failed states.

Health checks have a startup delay, interval, timeout, and consecutive-failure threshold. A successful check moves the task to running and resets its failure counter. A failed check marks it unhealthy at the threshold. When `restartOnFailure` is enabled, the supervisor terminates the process tree and applies the same bounded restart budget used for crashes. Checks run independently from process monitoring so stop and shutdown remain responsive during a slow endpoint check.

Restart attempts use exponential backoff capped by `maxBackoffMs`. `maxRestarts` is enforced within `windowMs`; reaching the limit records a diagnostic and stops automatic recovery. Explicit stop cancels pending sequence starts and restart delays. Manual restart waits for the prior tree to stop before starting another generation.

On Windows, each root process is assigned to a Job Object with kill-on-close and explicit tree termination. On Unix, each root process receives its own process group; stop sends `TERM`, checks the whole group, then uses `KILL` if needed. Standard output and error readers drain before a normal attempt is finalized. Each task retains its latest 400 lines in memory, with individual lines bounded to 4 KiB and terminal control sequences removed. Output events are coalesced, preserve a cross-task sequence, and feed the same visible terminal in Workspace Management and chat. Composite output defaults to the latest 400 merged lines; selecting a child exposes that child's full retained ring.

The manager keeps the last valid document while a run is active. This keeps the launched configuration visible and stoppable if `.machdoch/run.json` is changed or becomes invalid externally. Repeated starts still reuse an active process. New launches reject a changed or invalid document until active runs stop, and the UI keeps an editable recovery surface available for invalid files.

## Detection and review

Detection scans up to three workspace levels while excluding dependency and build directories. It recognizes runnable `package.json` scripts, package managers from lockfiles, explicit ports and URLs, common watch/dev commands, Docker Compose files, and Rust binaries in mixed stacks. Multiple independent applications produce a `Fullstack Start` draft. A root package remains primary only when its command explicitly orchestrates the workspace, avoiding both duplicate starts and omitted nested applications.

Detection never saves or executes a result. Workspace Management opens the generated JSON for review, and uncertainty markers identify fields such as ports or health checks that could not be determined. The AI exposes the same detector as a read-only draft tool. Unknown values are omitted rather than inferred from framework defaults.

## Research-informed choices

- [VS Code Tasks](https://code.visualstudio.com/docs/debugtest/tasks) informed one-instance behavior, workspace-relative `cwd`, parallel composites, optional sequence order, and a shared task-output stream.
- [Docker health checks](https://docs.docker.com/reference/dockerfile#healthcheck) informed the startup period, check interval, timeout, consecutive failures, compact diagnostics, and health-state events.
- [Kubernetes probes](https://kubernetes.io/docs/concepts/workloads/pods/probes/) reinforced separating startup tolerance from ongoing liveness and treating restarts as an advanced recovery action that needs conservative thresholds.
- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) provide kernel-owned process-tree cleanup and kill-on-close semantics.
- [npm script working-directory behavior](https://docs.npmjs.com/cli/using-npm/scripts/#working-directory-for-scripts) supports launching detected scripts from their package directory instead of relying on the shell's previous location.

Features that would add clutter or unsafe implicit behavior were intentionally omitted: detected commands never auto-run, configurations do not auto-start when a workspace opens, there are no concurrent instances of one saved task, and framework-default ports are not fabricated.

## Verification boundaries

Automated Rust tests cover document validation, mixed-stack detection, composite state and prevalidation, workspace-relative paths, concurrent idempotent starts, stdout and stderr retention, bounded fast output, successful and failed lifecycle transitions, crash recovery, failed-health restart limits, stale or invalid persisted state, event synchronization, shutdown during health checks, and descendant process cleanup. TypeScript tests cover control selection, completion presentation, composite output ordering, visible active and retained output, invalid-configuration recovery, repeated UI actions, prompt redaction, and the authenticated AI status bridge.

Runtime state and logs are intentionally not restored after Machdoch exits. A normal exit stops managed processes; Windows kill-on-close adds crash cleanup. A force-killed Unix desktop process cannot run its shutdown handler, so an operating-system-level orphan remains possible in that exceptional case.
