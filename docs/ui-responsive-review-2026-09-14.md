# Client responsive review — 14 September 2026

The existing client at `http://127.0.0.1:4173` returned HTTP 200 and was used throughout. No development server was started or restarted. This endpoint serves the client’s browser preview with sample runtime data. The supplied chat screenshot was the starting reference; the review also covered every entry in the application navigation.

## Changes

- Replaced the desktop rail with an app menu below 768px and moved sessions into a drawer. Session selection, search, filters, and nested action menus remain accessible.
- Fixed the shared Radix scroll viewport’s intrinsic width, which let long Markdown content expand beyond the conversation. Code and tables retain their own scrolling.
- Used dynamic viewport height, kept the composer in view, made its toolbar scroll horizontally, and reduced its height in short windows. Long titles and session actions no longer force extra columns or overlap. Quick Chat’s model selector gets enough space on narrow screens.
- Stacked workspace and instruction management panes on smaller screens. The workspace file tree and editor stack on phones; terminal headers and Git controls wrap.
- Made Media Studio and Ralph side panels fit small screens. The runtime plan now has a close button inside the panel. Media toolbar groups wrap without covering their neighbors. Small flow canvases use horizontal zoom controls and hide the minimap so nodes remain selectable.
- Fixed interview dialog footers, the expanded Ralph text editor, shortcut popover positioning, and import/category dialog sizing.
- Increased touch targets and form text size for coarse pointers. Kept desktop sidebars and editor columns at wider sizes.

## Viewports and method

Chrome through Playwright, with isolated browser contexts:

| Viewport  | Coverage                                                            |
| --------- | ------------------------------------------------------------------- |
| 320×568   | Narrow phone, touch                                                 |
| 390×844   | Phone portrait, touch                                               |
| 844×390   | Phone landscape, touch                                              |
| 768×1024  | Tablet portrait, touch                                              |
| 1024×768  | Tablet landscape / small desktop                                    |
| 1440×900  | Desktop                                                             |
| 1280×1393 | Additional chat check against the supplied screenshot’s proportions |

Checks combined screenshots, document and dialog bounds, scroll-region measurements, and actual clicks, text entry, selection, opening, and dismissal. Long titles, paths, unbroken links, code blocks, Markdown tables, and populated forms were included. Chat was also checked in compact density. A separate resize check retained the same draft through 390×844 → 844×390 → 1440×900 → 320×568.

All six primary sizes were used for the navigation and component checks below, except where a narrower scope is explicitly stated. “Fixture” means the real client component was mounted with controlled sample props through the existing Vite instance, without performing its native or external operation.

## Surface inventory and coverage

| Area                 | Exercised surfaces and states                                                                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App shell            | Desktop rail, mobile app menu, all eight navigation entries, title bar, command palette, orientation changes                                                                                                                                    |
| Chat                 | Long conversation content, code, tables, draft entry, message editing and cancellation, empty session after deleting a sample session, message navigation controls                                                                              |
| Sessions             | Desktop list, mobile drawer, search and empty search, scope/status menus, session actions, rename, compact density                                                                                                                              |
| Composer             | Model and reasoning pickers, execution mode, enhancement menu, context attachments menu, context packs and pack editor/overrides, session memory editor, compact and short-window layouts                                                       |
| Settings             | Providers, Agent limits, Global memory, Web search, Voice, MCP servers, Appearance, Desktop & chats, Run timeouts, Settings transfer, settings search, custom and preset MCP dialogs                                                            |
| Onboarding           | First-start setup’s Start section in a fixture; it reuses the settings dialog and sections checked above                                                                                                                                        |
| Workspace Management | Output, Files, Configuration, Git, Memory, Settings; Git status, branches, remotes, pull requests; file preview; terminal menu; workspace MCP dialogs                                                                                           |
| File editing         | README Markdown preview across six sizes; editor/search/replace additionally opened at 320×568 without saving changes                                                                                                                           |
| Instructions         | File list, new instruction editor, scrolling between the list and editor in short windows                                                                                                                                                       |
| Ralph overview       | Browser’s unavailable-workspace state; populated overview with flows, tasks, and run data in a fixture                                                                                                                                          |
| Ralph editor         | Blank flow, library, starter flows, Design/Generate/Run/Review modes, block settings, keyboard shortcuts, integration menu; Prompt, Validate, Decision, Pack, Ask User, Interview, Utility, Note, Group, End blocks                             |
| Ralph dialogs        | Generation interview and expanded text editor with variables, long content, and visible footer controls in fixtures                                                                                                                             |
| Media Basic          | Image, Video, SVG, model picker, advanced options                                                                                                                                                                                               |
| Media Advanced       | Canvas, templates, variables/presets, Add node menu, organization, selection, source/task/output inspectors, diagnostics, runtime plan; saved workflow picker, import review’s browser state, image-node inspector and empty image-asset picker |
| Media Assets         | GPT Image 2 details, category picker and manager; Models, LoRAs, Embeddings, Images, Videos, SVGs filters; empty filtered results                                                                                                               |
| Media Activity       | Activity view with the preview’s available state                                                                                                                                                                                                |
| Media dialogs        | Category manager with an unusually long category name; image mask editor in fixtures. Import dialog additionally rendered at 320×568, 844×390, and 1440×900 with only its native drag/drop subscription stubbed                                 |
| Smart Scheduler      | Jobs, Runs, cron/interval/delay/event forms, Prompt/RALPH target forms, webhook and polling trigger controls                                                                                                                                    |
| Fleet Manager        | Client connection dialog                                                                                                                                                                                                                        |
| Shared dialogs       | Input-needed text/options, chat interview, image preview and error, file preview and error, run-workspace dialog, timeout popover and validation state                                                                                          |
| Voice                | Recording, transcription, and error overlays in fixtures                                                                                                                                                                                        |
| Auxiliary windows    | Assistant bubble, Quick Chat popup/composer, tray-menu browser renderings; Quick Voice attempted but blocked as described below                                                                                                                 |

## Verification results

- The final full sweep attempted 818 checkpoints with no geometry or interaction assertion failures and no unexpected page errors. It recorded 18 native API exceptions from Quick Voice and the initial import fixture; those failed renderings are excluded from successful coverage.
- The additional Media Studio detail pass completed 24 checkpoints across all six sizes without failures. The final fixture pass completed 120 checkpoints at 320×568, 844×390, and 1440×900 without failures or page errors, including the importer with its native subscription stubbed.
- `pnpm typecheck:ui` passed.
- `pnpm check:client` passed.
- `pnpm build:ui` passed.
- Relevant component suites passed for navigation, session list/composers, command handling, file previews, workspace navigation/tools/MCP, Ralph app/overview, media import/generation/activity, and flow theme behavior.
- Two assertions failed in the unchanged `ralph-product-ui.dom.spec.ts`: “validates typed variables before dispatching a run” and “handles variable names inherited by ordinary objects.” These shared Fleet UI tests render without the `.machdoch-product` ancestor required by `ProductModal`, so the expected modal fields are absent. Neither the shared component nor that test was modified.

The geometry scan flags the MCP toolbar’s intentional negative margin as an overflow candidate. It fits inside the ancestor’s padding; it was inspected and is not document overflow. Canvas panning, code/editor scrolling, and horizontal toolbars are intentional scroll regions.

## Limits and remaining risks

- The native Tauri bridge on port 9223 permitted limited read access but was incompatible with the available automation driver for reliable window operations. Native window resizing and the complete desktop runtime could not be exercised through it.
- Quick Voice’s browser entry fails at `getCurrentWindow()` because native window metadata is absent. Its standalone window is **not verified**. The shared voice overlay was exercised separately.
- The import dialog has the same native drag/drop dependency. Its initial unmodified browser fixture failed to render; the final isolated fixture stubs that subscription to inspect layout. Actual drag/drop, OS file selection, imported-resource review data, and completed imports are not verified.
- The preview has no installed add-ons or generated image/video library. Populated add-on browsing, asset deletion confirmation, paid remote-edit confirmation, imported model/LoRA review, and live media run/review/history states were not exercised end to end.
- Native folder selection, provider authentication, microphone capture/transcription, external editors, real terminal/process execution, scheduler runs, and a connected Fleet session were not exercised. Forms, menus, and relevant populated component fixtures do not verify those operations.
- Only Chromium was used. Physical mobile devices, Safari, mobile browser chrome, and the on-screen keyboard were not available. Dynamic viewport sizing and browser orientation changes were tested, but do not replace device testing.
- Unrelated work was already present and continued in the shared workspace. Those changes were preserved. This review changes client layout and interaction presentation, not runtime behavior.

## Reproduce and inspect evidence

Run from the repository root with the existing client still running and Chrome installed:

```powershell
node scripts/verify-client-responsive.mjs
```

Optional environment variables: `MACHDOCH_CLIENT_UI_URL`, `MACHDOCH_BROWSER_CHANNEL`, `MACHDOCH_CLIENT_VIEWPORTS` (JSON pairs), `MACHDOCH_CLIENT_SURFACES` (comma-separated groups), and `MACHDOCH_CLIENT_REPORT` (JSON filename).

The script checks reachability and never starts a server. It seeds conversation data only in its isolated browser storage. Dialog fixtures live in `apps/client/src/tauri/ui/__test__/responsive-surfaces.tsx`; their route is supplied by Playwright, not added to application navigation or the production bundle.

Screenshots and JSON results are under `apps/client/.cache/responsive-review/`. Final runs are `verified-final.json`, `media-details-final.json`, and `fixtures-native-boundary.json`. Earlier reports document the findings and intermediate failures; screenshots with matching names contain the latest capture. `ui-build.log` contains the final build output. Quick Voice captures are failed rendering attempts, not evidence of successful coverage.
