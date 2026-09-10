# Session memory modal focus verification

## Frozen plan (before production edits)

Baseline: engine snapshot at `f4b3cf6`, captured 2026-09-09T22:34:27.484Z. The memory dialog and its CSS have no baseline edits. Preserve all supplied unrelated working-tree changes.

Exact focused command, from `packages/product-ui`: `pnpm test:dom src/memory-management.dom.spec.tsx`.

Harness: installed headless Chrome driven by Puppeteer, with the actual React component bundled by Vite into an in-memory page. No server or mocked focus movement. `CHROME_PATH` can select a browser executable; the default is the installed Windows Chrome.

Freeze these cases for both baseline and candidate: initial close-button focus; complete forward and reverse Tab order and boundary wrapping; programmatic background focus rejection; pointer isolation; navigation after controls become disabled (including the focused control); no enabled controls; Escape and close-button restoration; callback replacement without focus reset; repeated opening; unmount cleanup; removal of the opener. Assertions inspect the browser's active element after actual keyboard input. A harness sanity case verifies ordinary background Tab movement without a modal.

Required candidate checks: the focused command above, `pnpm typecheck`, `pnpm lint`, and `git diff --check`. Record baseline failures and candidate results below. Screen-reader and other browser-engine checks must be reported separately.

## Baseline observations

The first browser run executed all 16 cases: 8 passed and 8 failed. Failures covered both wrap directions, background focus, both disabled-control directions, all buttons disabled, callback replacement, and repeated opening. Browser shutdown additionally exceeded the default 10-second hook timeout. Before production edits, the harness shutdown allowance was raised to 60 seconds and focus assertions gained the actual focused element as diagnostic output; case inputs and expectations were unchanged.

The unchanged production files had SHA-256 hashes `4d2028e42fbd92cfca76e4ec46e2fd33fdc6b3db57bbef9aa669c7f2df840b77` (`src/memory-management.tsx`) and `26c89690d4983da5bc5ffbd56b8c27294c7b83514b10ae00635c5ff5dda3f2f7` (`src/primitives.css`).

The next run timed out launching Chrome before executing cases (16 skipped). The launch allowance was raised to 60 seconds and setup to 120 seconds. Test-only typing fixes add a CSS module declaration and narrow Vite asset output before reading it. These changes do not alter the focus cases.

A further baseline rerun encountered repeated page-setup timeouts; its executed assertions independently showed reverse Tab reaching the opener and callback replacement resetting focus to Close. This incomplete rerun is not counted as a completed baseline suite.

## Implementation and verification

The overlay is a native `dialog` opened with `showModal()`. The browser makes the rest of the document inert. A scoped Tab handler wraps enabled visible buttons and focuses the dialog when none remain. Native cancellation preserves Escape dismissal. Open/close lifecycle cleanup removes the handler, closes the native dialog, and restores a still-mounted opener. Callback changes do not restart that lifecycle. CSS resets the native dialog box while retaining the existing overlay layout.

The first candidate run passed 14 cases; two timed out in page setup rather than assertions. To avoid repeated browser tab startup, the final harness reuses one tab and navigates to a fresh document between cases, with 60-second setup and 30-second test allowances. The original 16 case inputs and expectations remain unchanged.

The final focused command passed all 16 tests (exit 0; 110.99 seconds). This includes actual forward/reverse wrapping, initial focus, disabled controls, background focus/pointer isolation, Escape, restoration, repeated opening, callback updates, opener removal, and unmount cleanup. The baseline's eight behavioral failures are resolved in these unchanged cases.

Final `pnpm typecheck`, `pnpm lint`, and `git diff --check -- src/memory-management.tsx src/primitives.css` all passed (exit 0). Oxfmt formatted the new TypeScript harness and changed component. Git emitted only its existing LF/CRLF conversion notices.

All 14 unrelated files in the supplied engine baseline still match their recorded SHA-256 hashes. No package dependencies, public component APIs, task lifecycle fields, or shell files were changed. No servers were started.

Limits: automated native modal behavior is exercised in installed Chrome. Screen-reader behavior and Firefox/WebKit or embedded desktop browser behavior have not been checked. Other machines must provide Chrome at the default Windows location or set `CHROME_PATH`.
