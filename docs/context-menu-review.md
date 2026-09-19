# Context menus and copying

Reviewed the desktop client’s chat, session history, workspace files, Git, run output, terminal, settings, Media Studio, and flow editor. Also checked the shared web UI: it does not use the desktop client’s global selection restriction.

## Implemented

`apps/client/src/tauri/ui/components/ui/menu.css` now owns menu backgrounds, borders, shadows, spacing, typography, icons, separators, hover/focus states, disabled states, and destructive actions. Dropdowns, their submenus, message and session menus, flow menus, and the new copy menus use it. Flow canvas and node menus also share their controls instead of maintaining duplicates.

| Surface                  | Copy actions                                                                    |
| ------------------------ | ------------------------------------------------------------------------------- |
| Workspace header         | Workspace path                                                                  |
| File tree                | Relative path, full path, filename; works without opening or selecting the file |
| Git changes              | Relative path and original path for renamed files                               |
| Git diff                 | Displayed patch or selected text                                                |
| Git branches and remotes | Branch name, commit, fetch URL, push URL                                        |
| Workspace run output     | Displayed output, respecting the selected task filter, or selected text         |
| Workspace run URLs       | URL without opening the browser                                                 |
| Terminal                 | xterm selection captured when the menu opens; Paste through xterm               |
| Session history          | Full title and session ID; shared keyboard navigation and focus restoration     |
| Assets                   | Name and asset ID from the existing action menu                                 |
| Attachments              | Name, full path or URL; media attachments expose their asset ID                 |
| Chat messages            | Selected text in addition to the existing export actions                        |
| Notifications            | String titles and messages                                                      |
| Media errors             | Diagnostic with its error code and displayed operation/run/node identifiers     |
| Media run details        | Prompt and provider job ID                                                      |
| MCP settings             | Discovery output and selected server JSON                                       |

Copy menus support right-click, Shift+F10, the menu key, keyboard navigation, Escape, viewport collision handling, and focus restoration. A failed clipboard write shows an error and allows retry. Copying does not activate the underlying file or URL. Complete values are used even when their labels are visually truncated.

Readable code, preformatted output, alerts, notification details, and empty-state descriptions can be selected. New copy targets are selectable unless they are navigation controls or terminal surfaces. Native menus remain available for inputs, editors, and selected text. Navigation chrome keeps its existing selection behavior.

## Further opportunities

1. **File operations:** add Open, Reveal, Rename, and Delete to the file tree’s menu using the existing operation lock, unsaved-change handling, and confirmation. These operations currently live in the toolbar. They should target the right-clicked entry rather than silently operate on the selected entry.
2. **Flow menus:** replace the existing hover/focus submenus with a menu primitive that handles keyboard navigation and viewport collisions at every nesting level. Their styling is unified, but their positioning and interaction model remains separate.

Prefer explicit values and existing action menus over a global “copy whatever is under the pointer” handler. That avoids copying unrelated controls, hidden content, or incomplete labels. Keep existing visible copy buttons in code blocks, flow output, and transfer codes; they provide a discoverable route alongside right-click.

## Verification

- Focused DOM and regression tests cover copy values, selection boundaries, keyboard opening, dismissal, retry, native-menu exceptions, notifications, sessions, assets, terminal state, workspace runs, Git models, and path formatting.
- `node scripts/verify-context-menus.mjs` builds an isolated browser fixture without starting a server. It checks light/dark opacity, submenus, selection, keyboard focus, dialog interaction, outside-click focus, and 320px viewport bounds. Screenshots are written to `apps/client/.cache/context-menu-review`.
- Production UI build, UI typecheck, lint, and formatting were checked.

The browser checks use a clipboard test double. Native Tauri menus, OS clipboard integration, and complete backend-driven workflows were not exercised.

## Whole-software iteration: 2026-09-19

Repeated the interaction review across chat, session history, attachments, workspace files, Git, run output, terminals, settings, Media Studio, flow menus, shared web views, Fleet Manager, and the landing site. This was a source and automated-test review, supplemented by isolated Chrome menu checks; it was not a full interactive end-to-end pass through every backend workflow.

### Changes

- Copy, session, asset, and terminal menus now share `ContextActionMenu` for keyboard opening/navigation, viewport placement, dismissal, focus restoration, and action failure reporting. Removed the session menu's separate positioning and dismissal implementation.
- Added session title/ID, asset name/ID, and attachment name/path/URL copy actions. Asset records do not contain a source filesystem path, so no path is fabricated.
- Editable descendants retain native context menus. Nested copy targets receive their own keyboard menu rather than their parent's menu.
- Terminal Paste uses xterm's paste handling. Clipboard shortcut failures are visible without marking a running terminal unavailable. Clipboard reads that resolve after a terminal restart or disposal are discarded; Ctrl+C still reaches the process.
- Corrected three failing web-dialog tests: the RALPH fixture now mounts inside the product container, and the session-memory fixture supplies jsdom's missing native dialog methods. Production dialog behavior was unchanged.

### Verification

- Repository-wide lint and TypeScript checks passed, with UI/test typechecks repeated after the changes.
- Full client run: 448 test files; 3,638 passed, 3 skipped, and 3 failures in the two dialog fixtures above. After correcting those fixtures, all 61 focused tests across 8 files passed, including the new interaction regressions.
- Shared product UI: 132 tests passed. Fleet Manager: 79 tests passed. Fleet protocol: 280 tests passed.
- Native Rust library: 799 tests passed, 9 ignored. The first attempt encountered a missing module while Rust sources were changing in the workspace; a retry compiled and passed after that module appeared. This iteration did not modify those Rust sources.
- Client core, desktop UI, and Fleet Manager production builds passed. The landing site built in development mode; its production build requires the unset `MACHDOCH_LANDING_URL` deployment value.
- Chrome checks passed for light/dark opacity, nested dropdowns, copy selection, keyboard opening, focus restoration, outside clicks, dialogs, and a 320px viewport. Screenshots were visually inspected. No development servers were started.

OS clipboard integration and native desktop appearance remain unverified. File operation menus and full flow-submenu keyboard/collision behavior remain the follow-up work described above.
