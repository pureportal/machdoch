# Application keyboard shortcuts and command palette

Status: implemented contract<br>
Scope: the main Machdoch application window<br>
Implementation status: completed 2026-08-05<br>
Repository and source review: 2026-08-05 (rechecked immediately before implementation)

## 1. Purpose

This specification defines one application command system with two presentations:

1. Direct keyboard shortcuts for commands that merit fast access.
2. A context-aware command palette opened with Command+K on macOS and Ctrl+K on Windows or Linux.

The system must be fast, deterministic, accessible, and easy for a view to extend. It must replace overlapping application-level key listeners rather than add another unrelated listener. The command palette is a power-user feature: do not add a permanent launcher, promotional copy, onboarding notice, or status badge.

This document records the contract used by the implementation. It distinguishes inspected code, researched facts, and implementation decisions; the final implementation record and verification results are in section 18.

### 1.1 Normative language

MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY describe implementation requirements.

The evidence in this document is deliberately separated:

- **Codebase observation** describes the repository as inspected on 2026-08-05.
- **Screenshot observation** describes the four supplied Linear reference images. It is not a claim about Linear's internal implementation.
- **Researched fact** is supported by a linked primary or official source.
- **Recommendation** is the proposed Machdoch behavior.

### 1.2 Goals

- One definition of a command drives palette results, direct shortcuts, nested selectors, contextual menus, and displayed shortcut hints.
- Global, view, entity or selection, focused-component, and overlay commands coexist without registration-order races.
- The active view, selection, overlay stack, focus target, platform, and current availability determine the winning command.
- A view can register commands without importing or knowing about the palette UI.
- Plain-letter shortcuts never fire while a user is typing unless the focused component explicitly owns that key.
- Existing confirmations, unsaved-change guards, and domain actions remain the source of truth.
- Compact selectors and the large palette use the same command-page model and interaction rules.
- New conflicts are detected during development and fail safely in production.

### 1.3 Non-goals for the first release

- User-defined arbitrary shortcut remapping.
- Multi-stroke sequences such as G then R.
- An operating-system-wide command palette.
- A permanent shortcut reference or Command+K button.
- Replacing text-editor, terminal, ARIA composite-widget, or browser-native key handling.
- Inventing commands for views that do not already expose the corresponding action.
- Making the tray, assistant popup, assistant bubble, or quick-voice window use the main-window palette.

## 2. Executive decisions

The implementation follows these resolved defaults:

1. Add the repository-local Radix variant of the shadcn Command component and cmdk 1.1.x. Use cmdk for the combobox/list presentation, not as the command registry or shortcut dispatcher.
2. Mount one application command provider in the main chat-session shell.
3. Keep one document-level bubble-phase keydown listener in that provider. Component handlers run first and can claim an event with preventDefault.
4. Use semantic KeyboardEvent.key matching by default. KeyboardEvent.code is opt-in only for a command that intentionally describes a physical key position.
5. Canonical Mod means Meta on macOS and Control on Windows/Linux. It is a strict platform mapping.
6. Use this precedence: top overlay, focused component, entity or selection, active view, global. Scope precedence cannot be bypassed with an arbitrary numeric priority.
7. A collision in the same winning scope disables the binding rather than selecting the last registered command.
8. Command+K replaces an open non-modal popover or menu, but does not open over a modal dialog. Within the palette, Command+K toggles it closed.
9. Escape closes the root palette; in a nested page it returns to the parent. Backspace returns only when a nested page's query is empty.
10. Direct single-character shortcuts are off in text-entry contexts and while a modal or keyboard-owning component is active. This release ships no application-level character-only binding, so it does not add an otherwise inert setting. The resolver defaults character-only commands off until a future feature adds the WCAG-required setting in the same change.
11. Explicit number selection is allowed only on small, stable selector pages. Numbers never mean the current visual row index.
12. Move Media Flow's current Command/Ctrl+K “Add node” behavior into the shared system. Application Command+K owns the root palette; “Add node” becomes a Media-context child page shared by the root palette and its visible button.
13. Preserve the existing native Quick Voice shortcut as a separate operating-system-global facility, include it in conflict diagnostics, and reject a configured native chord that collides with a shipped application chord.
14. Expose the already-existing Settings, Mission Control, and Smart Scheduler actions in the root palette. Do not add new shell actions or visible launcher copy.

## 3. Codebase findings

### 3.1 Frontend and desktop stack

**Codebase observation**

- The desktop application uses Tauri 2, React 19, TypeScript, Vite, and Tailwind CSS.
- shadcn is configured in <code>components.json</code> with the New York style and Radix variant. Existing primitives live in <code>src/tauri/ui/components/ui</code>.
- The repository already depends on the <code>radix-ui</code> umbrella package. Dialog, Popover, Dropdown Menu, Sheet, and Tooltip wrappers are present.
- At the pre-implementation inspection point there was no shadcn Command wrapper and no direct dependency on cmdk, kbar, react-hotkeys-hook, or another application hotkey registry. This implementation adds the repository-local Command wrapper and cmdk 1.1.x; it does not add a hotkey library.
- CodeMirror and xterm are embedded and already have their own keyboard behavior.
- State is predominantly React state and hooks, with Tauri Store or localStorage persistence in focused modules. There is no general client-state library or router that should be introduced just for commands.
- <code>vite.ui.config.ts</code> currently transpiles Windows builds to Chrome 105, macOS builds to Safari 13, and other builds to ES2022. Those are build targets, not a statement of the installed WebView version. Tauri uses evergreen WebView2 on Windows, the OS-provided WKWebView on macOS, and distro-provided WebKitGTK on Linux. New event/focus code must meet the configured build floors and receive real-platform smoke coverage because the actual WebKit version varies by supported OS or distribution.

Relevant locations:

- <code>package.json</code>
- <code>components.json</code>
- <code>src/tauri/ui/components/ui/dialog.tsx</code>
- <code>src/tauri/ui/components/ui/popover.tsx</code>
- <code>src/tauri/ui/components/ui/dropdown-menu.tsx</code>
- <code>src/tauri/ui/components/ui/sheet.tsx</code>
- <code>src/tauri/ui/styles.css</code>

### 3.2 Main window and view model

**Codebase observation**

<code>src/tauri/ui/preview/app.tsx</code> selects a React application by Tauri window label. The default/main window renders the chat-session application. Assistant Bubble, Assistant Popup, Quick Voice, and Tray Menu are separate roots.

The main application does not use URL routing. <code>src/tauri/ui/chat-session-shell.tsx</code> owns a local shell state and conditionally renders the active application. Its current main app identifiers are:

- <code>chat</code>
- <code>ralph</code>
- <code>media</code>
- <code>marketplace</code>
- <code>instructions</code>
- <code>workspaces</code>

The same order is visible in <code>src/tauri/ui/app-shell/app-rail.tsx</code>. Shell state is persisted through <code>src/tauri/ui/lib/shell-store.ts</code>.

The existing <code>selectApp</code> path contains unsaved-change guards for Instructions and Workspaces. Global navigation commands MUST invoke that path and MUST NOT mutate <code>activeApp</code> directly. During implementation, adapt <code>selectApp</code> to report completed versus cancelled so palette closing can follow the actual result.

Settings, Mission Control, and Smart Scheduler already have shell-level opening actions. Global commands should call those existing actions.

### 3.3 View and overlay boundaries

**Codebase observation**

The application contains both Radix-managed overlays and manual overlays:

- Settings, Mission Control, Smart Scheduler, attachment image preview, file preview, and chat workflow dialogs use or wrap Dialog.
- Menus and property-like controls use Popover or Dropdown Menu in many places.
- Onboarding, voice input, some context menus, and some temporary panels use custom positioning and document listeners.
- Settings has custom Escape and unsaved-navigation behavior, makes inactive content inert, and restores focus.
- Several context menus listen for document Escape or outside pointer events themselves.

Radix Dialog is already the correct focus-trap and restoration foundation. The missing application concept is an overlay stack visible to shortcut arbitration. The shared Dialog, Popover, and Dropdown Menu roots are the reliable integration point because each root sees controlled and uncontrolled open-state changes. Manual blocking surfaces and context menus register explicitly.

### 3.4 Existing keyboard behavior and conflicts

**Codebase observation**

The following inventory is implementation input, not a request to remove component-native keyboard behavior indiscriminately.

| Location | Current behavior | Conflict or migration requirement |
| --- | --- | --- |
| <code>components/ui/sidebar-provider.tsx</code> | Generated window-level Mod+B toggles a shadcn sidebar | The provider is not mounted anywhere in the inspected application. This listener is dead code and is not an application shortcut to migrate. Remove it from the unused primitive so it cannot become an unreviewed second dispatcher if the primitive is mounted later. |
| <code>ralph/ralph-flow-editor.tsx</code> | Escape closes local menus; Mod+S saves; Mod+Z and Mod+Shift+Z or Mod+Y undo/redo; Mod+D duplicates; Mod+L lays out; Mod+Enter runs; Delete or Backspace removes a selected edge/block | This is the most complete existing view shortcut set. Register semantic actions and retain local canvas navigation. The current Mod+S check occurs before its editable-target gate; preserve or deliberately change that behavior through an explicit focus policy. |
| <code>media/components/media-flow-view.tsx</code> | Mod+K opens a Media “Node palette”; Escape closes Media panels; undo, redo, copy, and paste use window-level listeners | Mod+K directly conflicts with the application palette. Migrate “Add node” into the shared palette and shared command-page surface. Remove the old listener and hard-coded Ctrl+K button title when migration lands. |
| File preview dialog | Mod+F focuses its own search | This is a valid top-overlay command. It must outrank application and view commands while that dialog is topmost. |
| Agent composer and prompt history | Enter submits, Shift+Enter inserts a line, Escape can cancel, Arrow Up/Down navigates history; IME checks include <code>isComposing</code> and keyCode 229 | These are focused-component interactions and should stay local. Mark the component as a keyboard owner; do not turn submit or history into global commands. |
| Settings navigation, workspace tree, media library, tab lists | Arrow, Home, End, Space, or Enter implement composite-widget navigation | Keep local and standards-aligned. The central listener must honor preventDefault and focus ownership. |
| CodeMirror | Editor keymap owns editing chords | Treat the editor as an editable command boundary. |
| xterm | Terminal handles keys and explicitly customizes Ctrl+Shift+C/V; screen-reader mode is enabled | Treat the terminal as a strong keyboard boundary. In particular, Ctrl+K can be terminal input on Windows/Linux and must not be stolen. |
| Sessions and conversation context menus | Local Escape and pointer-outside behavior; menu roles are present | Preserve local dismissal until the menu is registered in the overlay stack. Add robust Radix/roving navigation when touched. |
| Media library preview | Arrow Left/Right and Space control the open gallery preview | This is focused overlay/component navigation, not an application command. Keep it local and register the preview as an overlay if it becomes modal. |
| Tray menu | Escape hides the separate tray window | It is outside the main-window provider and remains local. |

There is also an operating-system-global Quick Voice/Quick Chat shortcut implemented through <code>tauri-plugin-global-shortcut</code> in <code>src-tauri/src/desktop_shell/shortcut.rs</code>. Its current default is <code>CommandOrControl+Alt+V</code>, and Settings accepts a configurable native shortcut string. The installed native parser accepts <code>CommandOrControl</code>, <code>CommandOrCtrl</code>, <code>CmdOrControl</code>, and <code>CmdOrCtrl</code> as platform Mod aliases, <code>Command</code>/<code>Cmd</code>/<code>Super</code> as the system modifier, and physical <code>Key…</code>/<code>Digit…</code> primary-key spellings. This facility fires outside the application and is not a DOM shortcut. It MUST remain separate, but its configured chord should appear in shortcut diagnostics so the application does not advertise a conflicting in-window command.

### 3.5 Test baseline

**Codebase observation**

- Vitest runs TypeScript tests in a Node environment. Per-file DOM environments can be added without changing the business-logic suite.
- Before this feature there was no configured React DOM test environment, React Testing Library, axe integration, or application Playwright test suite. Existing <code>.spec.tsx</code> files are type-checked but are not selected by the current Vitest include pattern.
- <code>playwright-core</code> is used by runtime functionality; it is not the Playwright test runner.
- The normal repository verification command includes linting, type checking, and Vitest.

The pure registry, parser, matcher, resolver, and ranking logic can and should use the existing Node Vitest setup. DOM integration, accessibility automation, and end-to-end coverage require deliberately adding test infrastructure; using a production runtime dependency as a test runner is not sufficient.

## 4. Research findings

### 4.1 shadcn Command and cmdk

**Researched fact**

The current official [shadcn Command documentation for the Radix variant](https://ui.shadcn.com/docs/components/radix/command) describes Command as a search and quick-action surface built on [cmdk](https://github.com/dip/cmdk). Its standard exports include Command, CommandDialog, CommandInput, CommandList, CommandGroup, CommandItem, CommandEmpty, CommandSeparator, and CommandShortcut. shadcn now documents multiple primitive variants; this repository is already on its unified Radix package and should not mix in Base UI for this feature.

cmdk is an unstyled, composable command-menu primitive. Its dialog composes Radix Dialog; it supports groups, disabled items, custom filtering, externally filtered lists, asynchronous loading, and nested “pages.” Its documented nested-page example uses Escape or Backspace with an empty query to go back. cmdk does **not** install Command+K for the application; the host controls open state and key handling. It also does not supply application command scopes or collision arbitration. The current published source manifest is version 1.1.1 and declares React and React DOM 18 or 19 peer support.

**Recommendation**

Use cmdk through a repository-local shadcn Command wrapper. Set <code>shouldFilter={false}</code> and feed cmdk the already eligible, deterministically ranked results from a pure application search function. This keeps shortcut eligibility and palette search testable from the same context snapshot. Do not use cmdk's internal item order as shortcut precedence.

### 4.2 Accessible comboboxes, lists, and dialogs

**Researched fact**

The W3C [combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/) describes an editable combobox whose DOM focus may remain on the input while <code>aria-activedescendant</code> identifies the active option. Arrow keys move through suggestions, Enter accepts, and Escape dismisses. It explicitly warns implementations not to interfere with browser-provided text-editing keys.

The W3C [listbox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/) distinguishes focus from selection and defines Arrow, Home, End, and type-ahead expectations. The W3C [modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) requires focus to enter a modal, Tab and Shift+Tab to stay within it, Escape to close it, an accessible name, and logical focus restoration. The W3C [keyboard interface guidance](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/) requires operability and visible focus independent of pointer use.

The official [Radix Dialog documentation](https://www.radix-ui.com/primitives/docs/components/dialog) documents modal focus trapping, Escape dismissal, focus return to the trigger, and the accessible Title/Description composition used by the repository wrappers. The command provider must complement those behaviors rather than install a competing focus trap.

**Recommendation**

Keep the cmdk input focused while navigating results, use Radix Dialog for the large surface, and let the primitive manage the combobox/listbox ARIA relationship. Retain an accessible dialog title even when the visible UI does not need a heading. Test the rendered behavior with assistive technology; library choice does not replace verification.

### 4.3 Character-key shortcut accessibility

**Researched fact**

[WCAG 2.2 Success Criterion 2.1.4](https://www.w3.org/WAI/WCAG22/Understanding/character-key-shortcuts.html) requires a shortcut made only from printable characters to be turn-off-able, remappable to include a non-character key, or active only while the relevant component has focus. This applies because voice input can accidentally trigger single-key shortcuts.

The [aria-keyshortcuts reference](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-keyshortcuts) states that the attribute only exposes a shortcut; JavaScript still implements it. It also recommends making shortcuts discoverable and avoiding operating-system, browser, and assistive-technology conflicts.

**Recommendation**

Ship a Settings switch named “Single-key shortcuts” in the same change as the first application-level P-like shortcut. Until then, default character-only commands off in the resolver and omit an inert setting. A focused selector may still own numeric keys because the shortcut is active only in that component. Add <code>aria-keyshortcuts</code> to visible controls or items that actually offer a shortcut; do not use HTML <code>accesskey</code>.

### 4.4 Keyboard event and layout behavior

**Researched fact**

[KeyboardEvent.key](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/key) reports the semantic key value after keyboard layout and modifier state are considered. [KeyboardEvent.code](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code) reports a physical key position and deliberately ignores layout. [KeyboardEvent.isComposing](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/isComposing) identifies events occurring during IME composition. [KeyboardEvent.repeat](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/repeat) identifies keydown events generated by holding a key.

[Event.composedPath()](https://developer.mozilla.org/en-US/docs/Web/API/Event/composedPath) exposes the propagation path across ordinary and open shadow-tree boundaries, which is why ownership classification inspects the path rather than only the nested target. [KeyboardEvent.getModifierState()](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/getModifierState) provides the AltGraph check used before matching Ctrl+Alt-like chords.

The official [Tauri WebView version reference](https://v2.tauri.app/reference/webview-versions/) states that Windows uses self-updating Chromium-based WebView2, while macOS uses the OS WKWebView and Linux uses WebKitGTK. The actual WebKit floor therefore varies by supported OS and distribution; a Chromium preview alone does not verify desktop keyboard behavior.

**Recommendation**

Match semantic commands with <code>event.key</code>. A P shortcut should follow the character P on QWERTY, AZERTY, QWERTZ, or Dvorak rather than a US physical position. Reserve <code>event.code</code> for a future command that is explicitly spatial. Ignore composing, dead, process, unidentified, and AltGraph events. Commands do not repeat unless their metadata opts in; list navigation remains free to repeat inside cmdk or the owning component.

### 4.5 Linear interaction references

**Screenshot observation**

The supplied images show:

- A compact assignee selector with a search field, grouped results, one highlighted row, a current-value checkmark, and explicit number hints on some rows.
- A compact priority selector opened by P with a small, fixed option set and stable 0–4 hints.
- The same priority selection presented as a wide nested page inside a larger command surface, including entity context.
- A root command palette with contextual commands, a highlighted result, and trailing key hints such as A, I, S, P, Shift+P, and L.

The visual evidence supports one command-page model rendered in a compact anchored popover or a larger dialog. It does not establish Linear's internal architecture. The number labels appear intentionally assigned to canonical values, not generated from arbitrary search-result order.

**Researched fact**

Linear's official [issue selection documentation](https://linear.app/docs/select-issues) describes keyboard navigation, selection, command-menu actions, and P for priority. Its [board-layout documentation](https://linear.app/docs/board-layout) describes command and context menus as view-aware ways to perform actions. Its [search documentation](https://linear.app/docs/search) distinguishes a global search shortcut from a current-view find shortcut. Linear has also publicly documented [international keyboard shortcut improvements](https://linear.app/changelog/2019-06-20-international-keyboard-shortcut-improvements) and [menus that expose shortcuts in context](https://linear.app/changelog/2020-08-26-better-menus-and-view-options/).

**Recommendation**

Adopt the interaction principles, not Linear-specific product commands or copy:

- one model, two surface sizes;
- contextual grouping;
- keyboard and pointer parity;
- stable explicit numeric options only where appropriate;
- key hints at the point of use;
- no permanent Command+K advertising.

### 4.6 Native global shortcuts

**Researched fact**

Tauri's official [global shortcut plugin documentation](https://v2.tauri.app/plugin/global-shortcut/) describes registering shortcuts that remain available while the application is not focused. That is a different event source and lifecycle from DOM <code>keydown</code>.

**Recommendation**

Keep the existing Quick Voice registration in the native layer. Share only normalized display and diagnostic information with the application registry; do not try to make cmdk or the DOM listener own an operating-system-global binding.

## 5. Product interaction contract

### 5.1 Opening and closing

The canonical shortcut is <code>Mod+K</code>:

- macOS: Command+K
- Windows: Ctrl+K
- Linux: Ctrl+K

The platform adapter MUST map Mod strictly. Ctrl+K on macOS is not an alias for Command+K, and Meta+K on Windows/Linux is not an alias for Ctrl+K.

Opening rules:

1. In the main application window, an eligible Mod+K opens the root palette and focuses its search input.
2. If the root palette is open, Mod+K closes it.
3. If a nested palette page is open, Mod+K closes the entire palette rather than returning one level.
4. If a non-modal menu or popover is open, the command provider asks that overlay to dismiss, then opens the palette after dismissal completes.
5. If a modal dialog, onboarding gate, blocking voice overlay, or another focus-trapped surface is topmost, Mod+K does nothing unless that overlay explicitly allows replacement. Do not stack the palette over it.
6. If the focused editor or terminal has claimed Mod+K or Ctrl+K, the component wins and the palette does not open.
7. A normal text input does not claim Mod+K merely because it is editable, so the palette may open from ordinary search or form fields.

Closing rules:

- Escape on the root page closes the palette.
- Pointer activation of the backdrop closes it only if the existing Dialog convention permits outside dismissal for this non-destructive surface.
- Selecting a normal synchronous command closes on successful execution unless its metadata says to stay open or push a child page.
- A view switch closes only after the existing view-switch guard succeeds.
- Focus returns to the invoking element if it is still connected, visible, and not inert. Otherwise focus the active view's registered focus fallback.

No visible button, rail item, global hint, or onboarding copy is added for Command+K.

### 5.2 Root palette

On open:

- Clear the root query.
- Build one context snapshot.
- Show enabled and deliberately discoverable disabled commands for the active context.
- Select the highest-ranked enabled result. If all visible results are disabled, no result is executable.
- Prefer context and active-view groups before global navigation when the query is empty.

Search:

- Match the command title and explicit keywords.
- Normalize case, Unicode normalization, whitespace, and diacritics.
- Rank exact title, title prefix, word prefix, token coverage, then substring. Preserve group/order metadata as a final stable tie-break.
- Do not search descriptions; commands should not need decorative descriptions.
- Do not include hidden commands.
- Search should remain local and synchronous for registered commands. Dynamic entity options load only after entering the relevant child page.

Navigation:

- Arrow Down and Arrow Up move the highlight and may wrap when the command list is non-empty.
- While the editable search input has DOM focus, Home, End, and standard platform text-editing chords retain their text-editing meaning. If a future non-editable list presentation moves DOM focus into the list, Home and End follow the listbox pattern and move to the first and last enabled result.
- Enter executes the highlighted enabled result.
- Tab and Shift+Tab retain normal focus traversal within the modal. Do not assign Tab a command meaning in the root palette.
- Pointer hover updates the same highlight used by keyboard navigation.
- Pointer click executes the same path as Enter.
- Touch activation must not rely on hover.

Cancellation and empty state:

- Escape follows the page rules above.
- A root query with no results shows “No commands found.”
- A selector query with no options shows “No matches.”
- Do not add an explanatory paragraph or footer legend.

Grouping:

- Omit empty groups and redundant headings.
- Recommended root order with an empty query is Context, the active view, and Navigation. Settings may be part of Navigation or a concise Application group.
- With a non-empty query, rank across groups but retain a group label where it helps distinguish similarly named commands.

### 5.3 Command availability

Availability is not a command scope. Every command evaluates to exactly one state:

- **enabled**: visible if configured for the palette and eligible for direct execution;
- **disabled**: visible only when recognizing the action is useful, with a short recovery reason;
- **hidden**: irrelevant, unsafe to disclose, or not useful in the current context.

Examples:

- A session-specific Archive action is hidden if there is no session context.
- Save may be disabled with “No changes to save” if users reasonably expect to find it.
- A command blocked by an active operation may be disabled with “Wait for the current action to finish.”

Disabled commands:

- are not highlighted if an enabled alternative exists;
- cannot execute by pointer, Enter, number, or direct shortcut;
- do not cause the global listener to call preventDefault;
- expose the disabled state and concise reason to assistive technology.

The provider MUST re-evaluate availability when context changes and immediately before execution. If the highlighted command becomes hidden, highlight the next enabled result. If it becomes disabled, retain it only when that avoids disruptive movement, but Enter must not run it.

### 5.4 Nested and contextual command pages

A command can return or declare a child page. Priority, project, status, assignee, and Media node selection are interaction patterns; only register one where Machdoch has the corresponding real action.

Each page frame stores:

- page ID and parent command ID;
- concise title or search placeholder;
- optional material context, such as the selected entity;
- current query;
- highlighted option ID;
- scroll position;
- an AbortController and request revision for asynchronous options.

Entering a child page:

1. Push a frame onto the palette stack.
2. Clear the child query.
3. Focus the same search input.
4. Load dynamic options lazily if needed.
5. Highlight the current value when it is enabled; otherwise highlight the first enabled option.

Returning:

- Escape on a child page pops one frame.
- The child-page Escape handler must prevent the Radix Dialog's default root dismissal before popping. On the root page, allow the normal Dialog close path.
- Backspace pops one frame only when the query is empty, no text is selected, and composition is not active.
- A visible back button is provided on compact/touch presentations. It has an accessible name and follows the same pop operation.
- Returning restores the parent's query, highlight, and scroll position.
- Mod+K closes the entire dialog at any depth.

Selecting an option:

- The current value is indicated separately from keyboard highlight.
- Enter or click invokes the option's command.
- A successful single-value change closes the surface by default.
- A multi-select or explicitly iterative page may remain open.
- Destructive options use an existing confirmation flow when one exists. If the existing controller action has no confirmation, the command adds a point-of-action confirmation before calling that action.

Asynchronous pages:

- Show a compact loading row or skeleton in the list, not a permanent explanation.
- Abort the prior request when query, entity, page, or active view changes.
- Ignore stale responses by request revision even if an abort is not honored.
- Preserve an inline retry action after a load failure.

### 5.5 Compact selectors and shared surfaces

The same page model has two shells:

| Presentation | Use | Behavior |
| --- | --- | --- |
| Compact Popover | Invoked from a visible property/control and the list fits an anchored surface | Approximately 18–22rem wide, collision-aware positioning, trigger-based focus restoration |
| Palette Dialog | Invoked from Command+K, from a direct key with no suitable anchor, or for a larger/nested flow | Centered near the upper viewport, wider result area, focus trapped |
| Mobile Dialog | Narrow or touch viewport where a popover would be cramped | Near-full-width dialog with safe viewport height and visible back control |

Do not maintain separate option arrays or keyboard handlers for compact and dialog presentations. A property button, a direct P-like command, and a root palette result all request the same command page with a different presentation hint.

If a compact popover cannot remain visible around its anchor, Radix collision handling may flip it. If the available area is still insufficient, use the dialog presentation rather than shrinking rows below an accessible target size.

### 5.6 Direct letter shortcuts

P and Shift+P are the required interaction model, not assignments to a currently unsupported Machdoch property.

When a view later registers real commands such as <code>entity.priority.open</code> and <code>entity.project.open</code>:

- P is a plain semantic character shortcut.
- Shift+P is a distinct chord and does not also trigger P.
- They are eligible only in the owning view or entity scope.
- They do not run in text entry, an editor, a terminal, an interactive control that owns printable keys, during composition, or while a modal is open.
- They respect the Single-key shortcuts setting.
- They invoke the same page used by the visible property control and palette result.

No direct key should be assigned merely because it is free. Every default shortcut requires a frequent action, a memorable mapping, and collision review.

### 5.7 Numeric selection

Numeric selection is opt-in page metadata, never generic list behavior.

A page may use numbers only when all of the following are true:

- it has no more than ten number-mapped canonical options; additional unnumbered searchable options are allowed when the mappings remain stable;
- options have stable semantic identities and explicit numeric keys;
- the number does not change when results reorder or filter;
- the page is already focused and visibly displays the mapping;
- choosing an option is safe or still goes through its normal confirmation.

Rules:

- Use explicit metadata such as 0 for “none” and 1–4 for fixed levels. Never map 1 to “first currently visible result.”
- Root palette results, session search results, assignees, projects, and other dynamic lists do not get automatic number shortcuts.
- A number selects only when the child query is empty, the input has no selected text, composition is inactive, and the exact option is enabled.
- With a non-empty query, digits are entered into the query.
- Numeric capture is local to the open selector. A normal form input elsewhere always receives the digit.
- Match the semantic <code>event.key</code>. If a layout needs Shift to produce a digit, permit that layout-required Shift only when the resulting key is the requested digit and Control, Meta, Alt, and AltGraph are absent.
- A current-value checkmark may replace the visible number in the tightest compact layout, but the option keeps its accessible shortcut metadata. Prefer showing both when space permits.

### 5.8 Shortcut hints and discoverability

Shortcut hints may appear only where they help at the moment of use:

- trailing keycaps in the command palette;
- trailing keycaps in a compact selector;
- an existing control's tooltip;
- an existing context or overflow menu item;
- the Single-key shortcuts control in Settings.

The renderer formats one canonical shortcut per platform:

- macOS uses familiar glyphs, for example ⌘K and ⇧P.
- Windows and Linux use labels, for example Ctrl+K and Shift+P.
- The accessible value uses ARIA token names such as Meta+K or Control+K.

Do not add a permanent keyboard legend, “power user” badge, Command+K prompt, or empty-state advertisement.

### 5.9 Execution, cancellation, and failures

Every command declares a close policy:

- <code>on-success</code>: default; keep the current surface until the action succeeds;
- <code>on-start</code>: only for safe navigation or actions whose destination owns error feedback;
- <code>stay-open</code>: selectors or iterative actions;
- <code>push-page</code>: enter a child page.

Execution rules:

1. Resolve the command by ID again against a fresh context snapshot.
2. If it is missing or not enabled, do not execute.
3. Mark the command invocation in flight.
4. Call the existing domain action with an AbortSignal where cancellation is meaningful.
5. Apply the returned close/stay/push result.

The default concurrency policy is “drop duplicate”: a second activation of the same in-flight command is ignored. Held-key repeats are also ignored. The palette may block other commands while a state-changing invocation is pending; do not permit actions to race merely to feel responsive.

On failure:

- keep or restore the current page and query;
- clear the pending state;
- show one concise inline error tied to the action and expose it through an assertive or polite live region as appropriate;
- allow retry when safe;
- do not replace a useful error with a generic toast alone.

Closing a palette aborts option loading and explicitly cancelable work. It does not claim to cancel an irreversible backend operation that has already started.

## 6. Focus, keyboard ownership, and browser conflict policy

### 6.1 Event pipeline

Install one <code>keydown</code> listener on <code>document</code> in the bubble phase. Do not use capture for the application dispatcher. The high-level pipeline is:

~~~ts
function onKeyDown(event: KeyboardEvent) {
  if (event.defaultPrevented) return
  if (isCompositionOrDeadKey(event)) return
  if (isModifierOnlyOrAltGraph(event)) return

  const context = snapshotContext(event)
  const chord = normalizeEvent(event, context.platform)
  const candidates = registry.lookup(chord)
  const resolution = resolve(candidates, context)

  if (resolution.kind !== "winner") return
  if (event.repeat && !resolution.command.allowRepeat) return

  event.preventDefault()
  execute(resolution.command.id, freshContext())
}
~~~

Calling preventDefault only after one enabled winner is found is mandatory. A disabled, ambiguous, stale, or ineligible binding must not swallow browser or component behavior.

### 6.2 Focus classification

Build focus classification from <code>event.composedPath()</code>, not only <code>event.target</code>, so nested elements and future shadow roots are handled.

The provider classifies focus as:

| Focus kind | Examples | Plain characters | Modified application commands |
| --- | --- | --- | --- |
| document | body, passive canvas background | Allowed when enabled and no overlay blocks | Allowed |
| text-entry | text/search/email/url/tel/password/number inputs, textarea, select | Blocked | Allowed only when command metadata permits; Mod+K normally permits |
| editor | contenteditable, CodeMirror content | Blocked | Component keymap wins first; otherwise only commands explicitly allowed in editors |
| terminal | xterm root/helper textarea | Blocked | Terminal owns input by default; application command needs an explicit terminal-safe exception |
| interactive-control | button, link, slider, checkbox, focused menu item | Blocked unless the component registers/owns it | Global modified commands may run only if the control did not handle them |
| command-surface | cmdk input and results | Owned by the top command page | Only palette-defined global handling, such as Mod+K toggle |

Provide explicit DOM markers:

- <code>data-command-focus="editor"</code>, <code>data-command-focus="terminal"</code>, or <code>data-command-focus="command-surface"</code>
- <code>data-command-boundary="editor"</code> and <code>data-command-boundary="terminal"</code> remain accepted aliases
- <code>data-command-owner="component-id"</code>

The shared focus utility also recognizes native editable elements, <code>contenteditable</code>, CodeMirror classes, and xterm classes so correctness does not depend only on new attributes.

### 6.3 Component versus application keys

Component interaction keys stay in the component when they control a focused widget:

- text insertion and deletion;
- composer Enter and history arrows;
- listbox, tabs, grid, tree, slider, and menu navigation;
- CodeMirror keymaps;
- xterm input;
- a dialog's local Mod+F;
- Escape for a top local overlay.

Those handlers should call preventDefault only when they actually handle the event. The application listener observes that and stops. Component-level semantic actions that should also appear in the palette may register a command in addition to retaining their local navigation handler.

### 6.4 IME, dead keys, and composition

The provider tracks <code>compositionstart</code> and <code>compositionend</code> and also checks <code>event.isComposing</code>. While composing:

- no application shortcut runs;
- Enter, Escape, Backspace, digits, and arrows stay with the input method or focused component;
- the nested Backspace-to-parent behavior is disabled.

Ignore <code>event.key</code> values Dead, Process, and Unidentified. The deprecated keyCode 229 may remain only as a narrowly documented WebView compatibility fallback if an automated or manual platform test proves it is still needed. New command logic MUST NOT otherwise depend on keyCode.

### 6.5 Repeat and modifier rules

- <code>allowRepeat</code> defaults to false.
- List navigation inside the focused command surface may repeat.
- A repeated direct action, destructive action, navigation command, or async command is ignored.
- Modifier-only keydowns never match.
- AltGraph events never match Ctrl+Alt shortcuts. Check <code>getModifierState("AltGraph")</code> before normalization.
- Caps Lock does not count as Shift. Normalize alphabetic <code>event.key</code> to lower case while preserving the actual Shift flag.
- A shortcut matches an exact modifier set unless its metadata explicitly defines the numeric layout exception above.

### 6.6 Browser, OS, and assistive-technology reservations

Maintain a reviewed reservation table in the shortcut module. It is diagnostic policy, not a promise that JavaScript can intercept every system shortcut.

Do not assign:

- operating-system task switching, lock, quit, force-quit, screenshot, or accessibility shortcuts;
- browser close/reload/location/new-tab chords such as Mod+W, Mod+R, Mod+L, Mod+T, or Mod+N without an explicit Tauri-only exception;
- Alt+F4 or the platform's application quit chord;
- screen-reader command chords identified during manual verification.

Expected application conventions such as Mod+S for save, Mod+F for find within a focused overlay, Mod+, for Settings, and Mod+Z for undo are allowed when their scope and focus policy are explicit.

The current RALPH Mod+L command is a Tauri-only exception because it conflicts with browser location semantics in a normal browser. Keep it only in the desktop shell, report it in diagnostics, and disable it in a browser-hosted preview unless product decides on a replacement.

The existing OS-global Quick Voice shortcut is registered before DOM events and may preempt the application. Validate its configurable value against the known application shortcut table when Settings saves it. Syntax validation remains the native shortcut service's responsibility.

### 6.7 Platform and layout

- Derive the platform once from the Tauri/runtime boundary. Use a web-preview fallback only for tests and preview mode.
- Store shortcuts in platform-independent form using Mod.
- Format displayed hints at render time.
- Use <code>event.key</code> for letters, digits, punctuation, Enter, Escape, arrows, Delete, Backspace, Home, and End.
- Use <code>event.code</code> only when a command metadata field explicitly requests physical matching.
- Test German QWERTZ, French AZERTY, and one Dvorak layout in addition to US QWERTY.
- Do not infer layout from key positions or translate P into a hard-coded <code>KeyP</code>.

## 7. Command scopes, precedence, and collisions

### 7.1 Scope types

| Scope | Meaning | Activation |
| --- | --- | --- |
| overlay | Commands owned by the top open dialog, popover, menu, or palette page | Overlay is registered and topmost |
| component | Commands owned by the focused component or deepest registered command boundary | Owner appears in the composed focus path |
| entity | Commands for the current selected or active entity/selection | Entity context exists and owner view is active |
| view | Commands contributed by the active main application | <code>activeApp</code> matches |
| global | Main-shell navigation and application actions | Main window provider is mounted |

Conditional availability is orthogonal. For example, RALPH “Duplicate selection” has view scope plus a selection-dependent availability predicate.

The native Quick Voice shortcut has a separate <code>systemGlobal</code> diagnostic category. It is not an application command scope.

### 7.2 Precedence

After focus, overlay, platform, and availability filtering, shortcut precedence is:

1. A component handler that already called preventDefault.
2. Commands from the top overlay. A modal blocks all lower scopes unless it explicitly allows a named global command.
3. Commands from the deepest focused component boundary.
4. Entity or selection commands.
5. Active-view commands.
6. Global commands.

For nested component owners, deepest in <code>composedPath()</code> wins. For overlays, the most recently opened still-active overlay is topmost. Scope rank is fixed; an arbitrary <code>priority: 999</code> field must not let a global command jump over a modal.

The Mod+K palette opener has a narrow <code>replaceNonModal</code> overlay policy. That policy dismisses a non-modal overlay before opening the palette; it does not bypass a modal or a keyboard-owning terminal.

### 7.3 Exact resolution algorithm

For a normalized chord:

1. Look up candidates from the registry's chord index.
2. Reject commands for another platform or window.
3. Reject inactive scope owners.
4. Apply overlay and focus policies.
5. Evaluate <code>when</code> and availability against one immutable context snapshot.
6. Reject commands disabled by the Single-key shortcuts setting.
7. Reject repeated invocation unless allowed.
8. Retain candidates at the highest remaining scope tier.
9. Apply an explicit, valid override relation within that tier.
10. Execute if exactly one enabled command remains.
11. Otherwise report an ambiguity and execute none.

Registration time and array order are never winner criteria.

### 7.4 Duplicate IDs and intentional overrides

- Command IDs are stable, namespaced strings such as <code>app.settings.open</code> or <code>ralph.flow.save</code>.
- A second live registration of the same ID from a different registration token is an error.
- React Strict Mode mount, cleanup, and remount must not create a false duplicate; cleanup is token-based and idempotent.
- Two active commands at the same scope with the same chord are an error even if their palette order differs.
- Mutually exclusive conditions may share a binding, but if both become true at runtime the binding is suppressed and diagnosed.
- An intentional override declares <code>overrideOf</code> with the target command ID and a short source-code rationale. It may target only the same or a broader scope and is valid only while both registrations are active.
- Override chains and cycles are rejected. A view does not need <code>overrideOf</code> merely to beat a global command; normal scope precedence already handles that.

Development diagnostics MUST include:

- normalized and displayed chord;
- platform;
- active scope stack;
- command IDs, owners, and registration source;
- availability and focus policy;
- whether the conflict is static, contextual, or with the native global shortcut.

Expose a pure <code>getCommandDiagnostics()</code> result for tests. Log a structured error in development. In production, suppress ambiguous execution without showing internal details to users.

### 7.5 Registration lifecycle and view changes

<code>registerCommands(owner, definitions)</code> returns an idempotent cleanup function. The React hook:

- registers after commit;
- updates the existing token without creating a transient duplicate;
- keeps execution callbacks current without re-registering every render;
- unregisters on unmount or owner change.

When the active view changes:

- the old view's registrations become inactive immediately, even before React cleanup completes;
- the palette closes and its stack/query are discarded;
- option loads and cancelable executions owned by the old view receive abort;
- the new view's registrations become eligible after commit;
- focus moves through the shell's normal behavior or the new view's fallback target.

If the palette itself invokes a view switch, keep it open until the existing unsaved-change guard reports success. Close and restore/fallback focus only after success; retain the palette if the user cancels.

## 8. Implemented architecture

### 8.1 Module layout

Add a focused command subsystem rather than a general state framework:

~~~text
src/tauri/ui/commands/
  command-types.ts
  command-defaults.ts
  command-registry.ts
  command-overlay-store.ts
  use-command-overlay.ts
  focus.ts
  shortcut.ts
  shortcut-resolver.ts
  command-search.ts
  command-context.tsx
  command-palette.tsx

src/tauri/ui/components/ui/
  command.tsx
~~~

Registry, shortcut, focus, search, and resolution logic remain independent from React and cmdk so they run in focused Vitest suites. React owns registration lifecycle and presentation; cmdk owns only the combobox/list interaction.

### 8.2 Command metadata

The following conceptual shape is normative; exact TypeScript names may vary:

~~~ts
type CommandScope =
  | { kind: "global"; ownerId: "app" }
  | { kind: "view"; ownerId: MainAppId }
  | { kind: "entity"; ownerId: string; viewId?: MainAppId }
  | { kind: "component"; ownerId: string; viewId?: MainAppId }
  | { kind: "overlay"; ownerId: string; viewId?: MainAppId }

type ShortcutSpec = {
  chord: string                 // for example "Mod+K", "Shift+P", "Delete"
  platforms?: Platform[]
  runtimes?: ("tauri" | "browser")[]
  match?: "key" | "code"        // default "key"
  allowRepeat?: boolean         // default false
  allowIn?: FocusKind[]
}

type CommandAvailability =
  | { state: "enabled" }
  | { state: "disabled"; reason: string }
  | { state: "hidden" }

type CommandResult =
  | { type: "close" }
  | { type: "stay-open" }
  | { type: "push-page"; page: CommandPage }
  | { type: "cancelled" }

type CommandDefinition = {
  id: string
  title: string
  group: string
  keywords?: string[]
  scope: CommandScope
  shortcuts?: ShortcutSpec[]
  palette?: "visible" | "hidden"
  order?: number
  when?: (context: CommandContextSnapshot) => boolean
  current?: (context: CommandContextSnapshot) => boolean
  availability?: (context: CommandContextSnapshot) => CommandAvailability
  overlayPolicy?: "blocked" | "replace-non-modal"
  overrideOf?: string
  children?: (context: CommandContextSnapshot, signal: AbortSignal) =>
    CommandPage | Promise<CommandPage>
  execute?: (
    context: CommandExecutionContext,
    signal: AbortSignal
  ) => CommandResult | void | Promise<CommandResult | void>
}

type CommandPage = {
  id: string
  title: string
  searchPlaceholder: string
  contextLabel?: string
  groups: readonly CommandPageGroup[]
  numericSelection?: boolean
}

type CommandPageGroup = {
  id: string
  label?: string
  items: readonly CommandPageItem[]
}

type CommandPageItem = {
  id: string
  title: string
  keywords?: readonly string[]
  current?: boolean
  numericKey?: "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
  availability?: CommandAvailability
  execute: NonNullable<CommandDefinition["execute"]>
}
~~~

Do not add descriptions, badges, or helper strings to the base type. A disabled reason and an execution error are point-of-need recovery content, not decorative metadata.

A definition must provide an executable action or a child-page factory. A child page's dynamic options are page-local command instances with stable, namespaced IDs and the same availability/execution result semantics; they are not inserted into the root registry or shortcut index. This keeps thousands of sessions, files, or entities out of the application registry while preserving one execution path for pointer, Enter, and explicit numeric selection.

### 8.3 Context snapshot

The provider builds an immutable context for each resolve/render revision:

~~~ts
type CommandContextSnapshot = {
  windowKind: "main" | "assistant" | "quick-voice" | "tray"
  platform: "macos" | "windows" | "linux"
  runtime: "tauri" | "browser"
  activeView: MainAppId | null
  focus: {
    kind: FocusKind
    ownerPath: readonly string[]
  }
  overlays: readonly OverlaySnapshot[]
  singleKeyShortcutsEnabled: boolean
  busyCommands: ReadonlySet<string>
}
~~~

Avoid a monolithic union containing every RALPH and Chat field. Views register strongly typed closures around their existing controller actions and publish only generic focus ownership required for arbitration. Opening the palette captures the invoking focus kind and owner path before cmdk moves DOM focus; palette filtering and command revalidation retain that ownership while refreshing the active view, overlays, availability closures, and busy state. Page-item actions receive the current command-surface focus and capture their material entity through the page factory.

### 8.4 Registry

Implement the registry as a small external store:

- Map command ID to registration records. Resolve the modest command set from the immutable snapshot rather than maintaining a second chord index that can drift.
- Track a monotonically increasing revision.
- Return immutable snapshots through <code>useSyncExternalStore</code>.
- Keep development source metadata out of production rendering.
- Atomically replace a mounted registration batch in a layout effect so current callbacks and availability closures do not create a missing-command snapshot.

The registry does not import React views, shell controllers, or cmdk. It knows definitions, owners, and registrations only.

Static validation runs when a definition registers and invalid definitions are omitted from the executable snapshot:

- non-empty ID, title, group, and scope owner; namespacing remains a repository convention;
- parsable shortcuts;
- no duplicate modifier or multiple primary keys;
- no modifier-only shortcut;
- known semantic key or explicitly valid physical <code>code</code>;
- no self-override.

### 8.5 Shortcut parser and formatter

Version one supports a single chord only. Parse canonical strings into:

~~~ts
type NormalizedChord = {
  key: string
  mod: boolean
  control: boolean
  alt: boolean
  shift: boolean
  match: "key" | "code"
}
~~~

Parser rules:

- accept aliases at definition time only if needed for migration; store one canonical form;
- normalize alphabetic primary keys to lower case;
- normalize Escape, Enter, Space, ArrowUp, ArrowDown, Home, End, Backspace, Delete, and punctuation;
- reject unknown tokens and repeated modifiers;
- expand Mod only at match or display time for the current platform;
- never treat Ctrl+Alt as AltGraph;
- keep display formatting separate from matching;
- generate an ARIA shortcut token separately from visual keycaps.

Do not implement sequences in version one. Reserve the metadata version so sequences can be added without changing command IDs if a later product requirement justifies the timeout, cancellation, collision, and WCAG complexity.

Expose a small read API such as <code>useCommandShortcut(commandId)</code> plus one <code>ShortcutHint</code> renderer. Existing buttons, tooltips, menus, and palette rows use that API instead of embedding “Ctrl+K” or platform checks. Expose a corresponding <code>openCommandPage(commandId, presentation, anchor?)</code> API so visible controls and direct shortcuts enter the same child-page factory.

### 8.6 Command provider and shell integration

Mount <code>CommandProvider</code> once inside the main <code>ChatSession</code> shell, after the persisted shell state is available and alongside the existing TooltipProvider. It owns:

- the document listener;
- registry subscription;
- platform adapter;
- focus classifier;
- overlay stack;
- current command page stack;
- palette open state;
- invocation locks and abort controllers;
- the single-key setting;
- development diagnostics.

Register global definitions adjacent to shell actions, not inside the visual palette:

- view-switch commands call <code>selectApp</code>;
- Settings calls the existing Settings opener;
- Mission Control and Scheduler may be registered only if product chooses to expose those existing actions;
- Command+K is a palette-control binding and is not listed as a result inside itself.

Only mount the provider in the main window in phase one. Shared modules may remain window-agnostic so another root can opt in later.

Do not persist or render <code>singleKeyShortcutsEnabled</code> in this release because no application-level character-only command is being enabled. The provider still carries a capability flag and defaults it to false, so an accidentally registered P-like binding cannot execute. When a real character-only command ships, add the preference to <code>UserDesktopSettings</code>, regenerate the TypeScript and Rust contracts, and expose the switch in <code>DesktopSettingsPanel</code> in that same change. Do not put the preference in <code>AppShellState</code>.

### 8.7 View integration

A view uses a hook such as:

~~~ts
useRegisterCommands({
  owner: { kind: "view", id: "ralph", active: activeApp === "ralph" },
  commands: ralphCommands
})
~~~

The hook does not import the palette. Commands call existing controller actions and selectors. A view may also register an entity scope while a selection exists.

Keep focused ARIA navigation local. For example, RALPH canvas arrow behavior or a session menu's roving focus does not need a palette command. Semantic actions such as Save, Duplicate selection, or Archive session do.

### 8.8 Overlay stack

Create one lightweight overlay registry. Each open surface registers:

~~~ts
type OverlaySnapshot = {
  id: string
  kind: "modal" | "non-modal"
  openedAt: number
  dismiss?: () => void | Promise<void>
  allowGlobalCommands?: readonly string[]
}
~~~

Integrate the controlled/uncontrolled open state in the shared Radix Dialog, Popover, and Dropdown Menu root wrappers. This is more accurate than registering from content components, which may remain mounted while a controlled primitive is closed. The command palette uses those same roots. Onboarding, voice input, the transient file-preview fallback, RALPH shortcut help, and manual context menus register explicitly. An overlay unregisters on close/unmount. The stack determines:

- topmost owner and modal blocking;
- which Escape behavior is eligible;
- whether Command+K may replace it;
- the focus restoration boundary.

Do not rely on z-index inspection. Opening order plus active registration is the source of truth.

### 8.9 Search and result materialization

Search is a pure pipeline:

1. Take a registry and context revision.
2. Materialize palette-visible commands.
3. Evaluate hidden/disabled/enabled state.
4. Normalize query and command search fields.
5. Rank deterministically.
6. Group and return stable item IDs.

Use command ID as cmdk's value and React key. Never use the title because titles can repeat or change.

For the expected command count, an O(n) local ranker is sufficient. Lazy-load child entities rather than putting every session/file/node into the root registry. Add virtualization only after measurement shows a real page needs it; cmdk itself documents support for lists in the low thousands but does not provide automatic virtualization.

### 8.10 Shared command surface

<code>CommandSurface</code> renders a page model into either:

- shadcn Command inside Radix Popover;
- shadcn Command inside Radix Dialog.

It is responsible for:

- input and list;
- groups and separators;
- highlight/current/disabled/pending visual states;
- keyboard hints;
- loading, empty, and error rows;
- pointer activation;
- accessible labels and live feedback.

It is not responsible for command registration, shortcut resolution, or domain mutations.

## 9. Library decision

| Option | Strengths | Costs for this repository | Decision |
| --- | --- | --- | --- |
| shadcn Command + cmdk | Fits existing shadcn/Radix stack; accessible combobox composition; Dialog and Popover integration; nested page pattern; unstyled | Still requires the registry, shortcut resolver, context, diagnostics, and app-specific ranking | **Use** |
| kbar | Includes provider/actions, search UI, nested actions, shortcuts, and result utilities | Introduces a second provider/portal model and overlaps with the exact registry/arbitration behavior Machdoch needs to control; less aligned with existing shadcn primitives | Do not add initially |
| react-hotkeys-hook | Convenient per-component hooks and scopes | Per-hook dispatch does not by itself provide one deterministic cross-view winner, overlay stack, command search model, or conflict report; risks recreating distributed listeners | Do not add initially |
| Fully custom combobox/dialog | Total control | Reimplements mature focus, listbox, dialog, and screen-reader behavior | Do not use |
| Small custom registry/resolver plus cmdk UI | Exact context/precedence model while reusing accessible UI primitives | A modest amount of pure application code to own and test | **Recommended architecture** |

Official references:

- [shadcn Command, Radix variant](https://ui.shadcn.com/docs/components/radix/command)
- [cmdk repository and API](https://github.com/dip/cmdk)
- [kbar repository](https://github.com/timc1/kbar)
- [react-hotkeys-hook documentation](https://react-hotkeys-hook.vercel.app/)

Add only cmdk for the first implementation. Reconsider a hotkey library if the product later accepts multi-stroke sequences or full user recording/remapping and a candidate demonstrably fits the fixed precedence contract.

## 10. Implemented command matrix

This matrix uses only actions already present in the inspected application. The defaults below were validated during implementation.

### 10.1 Global and shell commands

| Command ID | Existing action | Scope | Proposed default | Palette | Availability and notes |
| --- | --- | --- | --- | --- | --- |
| <code>app.palette.toggle</code> | Open/close shared palette | global control | Mod+K | hidden from itself | Main window; blocked by modal/terminal ownership; replaces non-modal overlay |
| <code>app.settings.open</code> | Open Settings | global | Mod+, | visible | Disabled while a blocking modal owns focus; call existing opener |
| <code>app.view.chat</code> | Select Chat Sessions | global | Mod+1 | visible | Tauri desktop only; call guarded <code>selectApp("chat")</code> |
| <code>app.view.ralph</code> | Select RALPH | global | Mod+2 | visible | Tauri desktop only |
| <code>app.view.media</code> | Select Media Studio | global | Mod+3 | visible | Tauri desktop only |
| <code>app.view.marketplace</code> | Select Marketplace | global | Mod+4 | visible | Tauri desktop only |
| <code>app.view.instructions</code> | Select Instructions | global | Mod+5 | visible | Preserve unsaved-change guard |
| <code>app.view.workspaces</code> | Select Workspace Management | global | Mod+6 | visible | Preserve unsaved-change guard |
| <code>app.scheduler.open</code> | Open Smart Scheduler | global | none | visible | Call the existing shell action |
| <code>app.mission-control.open</code> | Open Mission Control | global | none | visible | Call the existing shell action |
| <code>system.quickVoice</code> | Open Quick Voice/Chat from the OS | systemGlobal diagnostic | CommandOrControl+Alt+V by default | not an application result | Existing configurable native shortcut; validate for conflicts separately |

Mod+1 through Mod+6 conflict with browser tab selection in a normal browser. Enable these defaults only in the Tauri main shell. Browser preview mode should leave them unbound or require an explicit test flag.

### 10.2 RALPH

| Command ID | Existing action | Scope | Current/default shortcut | Availability |
| --- | --- | --- | --- | --- |
| <code>ralph.flow.save</code> | Save flow | view | Mod+S | Active RALPH flow; disabled when nothing can be saved |
| <code>ralph.flow.undo</code> | Undo | view | Mod+Z | Active RALPH flow and undo available; editor/component ownership wins |
| <code>ralph.flow.redo</code> | Redo | view | Mod+Shift+Z and Mod+Y | Active RALPH flow and redo available |
| <code>ralph.selection.duplicate</code> | Duplicate selected block | view/active selection | Mod+D | Exactly the supported RALPH selection context; fresh availability closure |
| <code>ralph.flow.cleanLayout</code> | Clean layout | view | Mod+L | Tauri-only reviewed exception; disabled in browser preview |
| <code>ralph.flow.run</code> | Run flow | view | Mod+Enter | Flow is runnable and not blocked by current execution |
| <code>ralph.selection.delete</code> | Delete selected edge/block | view/active selection | Delete and Backspace | Canvas/document focus only; never while editing text; fresh availability closure; preserve any confirmation policy |

Local Escape for RALPH menus remains with the top local overlay. Copy no shortcut text from the old listener into multiple UI components; all displayed hints come from the registered definition.

### 10.3 Chat Sessions

The inspected Chat Sessions UI already exposes these actions. The first palette release should register them without inventing direct shortcuts.

| Command ID | Existing action | Scope | Default shortcut | Availability |
| --- | --- | --- | --- | --- |
| <code>chat.session.new</code> | Create a session | view | none | Chat active and session creation allowed |
| <code>chat.sessions.search</code> | Focus/open the existing session search affordance | view/component | none | Chat active; if implemented, invoke the existing search UI rather than duplicate it |
| <code>chat.session.pin</code> / <code>chat.session.unpin</code> | Pin or unpin active session | view/active session | none | Active session supports pinning |
| <code>chat.session.duplicate</code> | Duplicate session | view/active session | none | Active session supports duplicate |
| <code>chat.session.archive</code> | Archive session | view/active session | none | Active session supports archive |
| <code>chat.session.rename</code> | Invoke existing rename flow | view/active session | none | Active session supports rename |
| <code>chat.session.delete</code> | Invoke existing delete flow | view/active session | none | Active session supports deletion; command confirms before calling the controller action |

The first implementation targets the active conversation. The sidebar has context-menu targeting but no persistent focused-row selection model, and opening the palette moves focus away from the row. The active-session commands therefore use view scope plus fresh availability checks rather than pretending that transient DOM focus is an entity selection. The inspected delete controller action does not contain a confirmation, so only the palette command adds a point-of-action confirmation before calling it. A future focused-row feature may publish an explicit session selection into command context and then adopt row-first targeting.

### 10.4 Media migration

Media is not part of the requested example matrix, but it is the blocking Command+K conflict:

- Register the existing Add/find node action as <code>media.flow.node.add</code> in Media view scope.
- Make it visible in the root palette when Media Flow is active.
- Selecting it pushes node categories/search as a command page. The visible Add node button requests the same page in a compact anchored presentation; its existing side panel remains only as a no-provider fallback for isolated component rendering.
- Remove Media's window-level Mod+K handler when the shared provider lands.
- Replace the hard-coded “Ctrl+K” title with a registry-rendered hint only if Add node receives a distinct direct shortcut. Recommended first-release default: no separate direct shortcut.
- Migrate Media undo/redo/copy/paste into view or selection commands only where they do not override focused text/editor clipboard behavior.

### 10.5 P and Shift+P pattern

Do not add priority or project concepts to Machdoch solely to match the screenshots. The registry supports this future pattern:

| Pattern command | Scope | Shortcut | Result |
| --- | --- | --- | --- |
| <code>&lt;view&gt;.&lt;entity&gt;.priority.open</code> | entity | P | Open the shared priority page |
| <code>&lt;view&gt;.&lt;entity&gt;.project.open</code> | entity | Shift+P | Open the shared project page |

Only a real view capability may register those definitions.

## 11. Visual and accessibility specification

### 11.1 Large palette

- Use the existing application surface, border, text, muted text, focus, and shadow tokens.
- Place the dialog near the upper center, not the exact screen center.
- Recommended width: <code>min(48rem, calc(100vw - 2rem))</code>.
- Recommended maximum list/dialog height: the lesser of roughly 34rem and the safe dynamic viewport minus 4rem.
- On narrow screens, use <code>calc(100vw - 1rem)</code>, reduce outer radius only as existing dialogs do, and keep the list within <code>100dvh</code>.
- Use a visually hidden Dialog title “Command palette.”
- Root input placeholder: “Type a command or search…”
- Nested placeholders name the task, for example “Change priority…” or “Search sessions.”
- Show an entity context chip only when it changes what commands act on.
- Rows should use the existing compact menu density, a clear highlighted surface, a leading icon only when useful, and a trailing shortcut.
- Show current value with a checkmark distinct from the highlighted row.
- Avoid descriptions, badges, notices, footer legends, and shortcut marketing.

### 11.2 Compact selectors

- Reuse existing Popover collision/portal behavior.
- Keep the search input and options in the same order/semantics as the dialog page.
- Use one-line group headings only when groups are necessary.
- Keep hit targets comfortable for mouse and touch; do not shrink text to fit shortcut hints.
- A direct keyboard open with a logical visible control should restore focus to that control. Without an anchor, use the dialog shell.

### 11.3 Focus and screen readers

- Opening a dialog focuses the command input.
- Keep DOM focus on the input while cmdk manages active option semantics.
- Trap Tab within the large palette through Radix Dialog.
- Restore focus as defined in section 5.1.
- Give icon-only Back, Close, Clear, and Retry controls accessible names.
- Expose result disabled/current/selected states without relying on color.
- Announce child-page changes, async failures, and successful actions when the visible focus/state change is not sufficient.
- Avoid announcing a result-count update on every keystroke if the combobox already conveys it; verify with NVDA and VoiceOver.
- Add <code>aria-keyshortcuts</code> only to the currently applicable visible control/item.

### 11.4 Motion, contrast, and zoom

- Respect <code>prefers-reduced-motion</code>. Remove scale and list-height transitions when reduction is requested; a simple opacity change is sufficient.
- Use existing focus rings and retain them in high-contrast modes.
- Text and meaningful icons must meet the application's WCAG contrast target; disabled text must remain legible.
- Verify at 200% browser/WebView zoom and at Windows text scaling.
- Keep highlighted, selected/current, disabled, and pending states distinguishable without motion.

### 11.5 Pointer and keyboard parity

Every visible row:

- is reachable by the documented keyboard path;
- can be activated by click/tap;
- shares one execute function;
- updates highlight on pointer movement without stealing DOM focus from the input;
- preserves a keyboard highlight after pointer leaves;
- has the same disabled and confirmation behavior for all input modes.

## 12. Edge-case catalogue

The implementation is incomplete until these cases have an explicit result:

| Case | Required result |
| --- | --- |
| User types P in input, textarea, search, contenteditable, or CodeMirror | Text is entered; no application P command |
| User presses P on a focused button/select/menu item | Component behavior wins; no unrelated application command |
| User presses Ctrl+K in xterm | Terminal owns it unless an explicit terminal-safe policy is accepted |
| User presses Mod+K in a normal text field | Palette opens if no top modal or component claim |
| User presses Mod+K with a non-modal popover open | Popover dismisses, then palette opens |
| User presses Mod+K with Settings or another modal open | Nothing opens; modal retains focus |
| User presses Escape in nested page with query | Return to parent immediately; Escape does not merely clear query |
| User presses Backspace in nested page with query | Delete query text |
| User presses Backspace in empty nested page | Return to parent |
| IME composition emits Enter/Escape/Backspace/229 | Application dispatcher does nothing |
| Dead key or AltGraph is used | No application command |
| Key is held | Direct command executes once; list arrows may repeat |
| French layout produces “1” using Shift | Explicit numeric option 1 may activate because semantic key is 1 |
| US layout produces “!” using Shift+1 | Numeric option 1 does not activate |
| Dvorak user presses the key producing P | Semantic P command activates outside an editable context |
| Active result becomes disabled while palette is open | It cannot execute; UI updates with concise reason if still relevant |
| Selected entity is deleted remotely/elsewhere | Entity commands disappear or disable; Enter revalidates |
| Async option request A resolves after request B | A is ignored by revision |
| Async command is triggered twice | Second invocation is dropped |
| Async command fails | Surface remains/reopens at same state with retryable error |
| View registration unmounts during open palette | Palette closes; stale callbacks do not execute |
| View switch unsaved guard is cancelled | Current view and palette remain |
| Strict Mode mounts effects twice | No duplicate live registration after cleanup |
| Two same-scope commands claim the same chord | Neither runs; development diagnostic identifies both |
| View and global command share a chord | Eligible view command wins; no conflict needed |
| Native Quick Voice is rebound to an app chord | Settings reports a conflict before accepting or asks for a different chord |
| Browser preview receives Mod+1 | Browser retains tab shortcut; Tauri-only view binding is inactive |
| Palette opens from an element removed while open | Close focuses active-view fallback |
| Current option is filtered out | It remains selected in domain state but not rendered; first enabled match is highlighted |
| No result is enabled | No row executes; Enter does nothing |
| Screen reader virtual cursor or speech input sends a character | Single-key setting can turn application character shortcuts off |
| 200% zoom or small viewport | Dialog/popover remains fully operable and scrolls internally |

## 13. Verification strategy

### 13.1 Pure unit tests in existing Vitest

Add Node-environment tests for:

- parser acceptance/rejection and canonicalization;
- Mod expansion on macOS, Windows, and Linux;
- exact modifier matching, Caps Lock, AltGraph, and layout-required Shift;
- semantic <code>key</code> versus explicit physical <code>code</code>;
- IME/dead/process/unidentified/repeat rejection;
- focus classification from synthetic composed paths;
- scope precedence and modal blocking;
- non-modal replacement policy;
- disabled/hidden/enabled handling;
- duplicate ID and chord diagnostics;
- valid/invalid override relations and cycles;
- registration update/cleanup and Strict Mode-like register-dispose-register;
- deterministic search normalization/ranking;
- stable explicit numeric selection;
- fresh availability revalidation before execute;
- async duplicate locks, abort, and stale request revisions.

These tests should not import React, cmdk, or a DOM.

### 13.2 React integration tests

Add a DOM-capable Vitest project or environment plus React Testing Library, user-event, and axe integration. Cover:

- provider mounts one listener and unregisters it;
- view registrations become active/inactive on shell changes;
- input typing does not invoke plain shortcuts;
- ordinary input allows Mod+K;
- component preventDefault wins;
- Dialog focus trap and restoration;
- fallback focus when invoker unmounts;
- Popover versus Dialog rendering of the same page;
- Arrow/Enter result navigation, Home/End text-editing preservation, and pointer parity;
- root Escape, nested Escape, and empty-query Backspace;
- query and highlight restoration when returning;
- number capture rules;
- disabled/current/highlight semantics;
- async loading, failure, retry, and stale result handling;
- no obvious axe violations in root and nested surfaces.

If jsdom cannot faithfully exercise Radix focus behavior, run those cases in a real browser rather than weakening the assertion.

### 13.3 End-to-end follow-up

Do not pretend the existing <code>playwright-core</code> runtime dependency is an application test runner. This repository has no current desktop/browser E2E lifecycle, seeded state contract, or CI browser installation. The implementation adds DOM integration coverage now; a subsequent test-infrastructure change should add <code>@playwright/test</code>, an explicit configuration, deterministic preview fixtures, and CI browser installation together.

That browser-preview E2E suite should cover:

- open, search, execute, cancel, and focus restore;
- global Settings and view commands using test-safe bindings;
- RALPH command availability and execution;
- Chat session command context;
- Media Command+K migration;
- modal blocking and non-modal replacement;
- nested selector and numeric behavior;
- no plain-key interference in every editable class.

The browser layer will not prove Tauri WebView or native shortcut behavior. Add platform smoke/manual coverage for:

- Windows WebView2;
- macOS WKWebView;
- Linux WebKitGTK;
- native Quick Voice registration and collision validation.

### 13.4 Accessibility verification

Automated:

- axe on root, nested, disabled, loading, error, and empty states;
- assertions for accessible dialog name, combobox/listbox relationship, active descendant, disabled/current state, and aria-keyshortcuts.

Manual:

- keyboard only;
- NVDA on Windows;
- VoiceOver on macOS;
- Orca on Linux where supported;
- speech input with Single-key shortcuts on and off;
- reduced motion;
- forced colors/high contrast;
- 200% zoom and large text.

### 13.5 Manual acceptance matrix

Run at least these scenarios before release:

1. From each of Chat, RALPH, Media, Marketplace, Instructions, and Workspaces, open Mod+K, search Settings, execute it, close Settings, and verify focus.
2. Switch between each view through the palette and its proposed Mod+number binding in Tauri. Verify cancelled unsaved guards.
3. In RALPH, test every migrated shortcut with no selection, valid selection, during edit, during run, in an input, and with a local menu open.
4. In Chat, test session commands against the active conversation, including the command-specific deletion confirmation. Do not test focused-row targeting until the sidebar publishes a persistent selection.
5. In Media Flow, verify Mod+K opens the application palette and Add node remains reachable through its contextual command.
6. In input, textarea, contenteditable, CodeMirror, xterm, search, select, button, and menu focus, verify ownership rules.
7. With each Dialog, Popover, Dropdown Menu, onboarding overlay, and voice overlay type open, verify modal block or non-modal replacement.
8. Navigate root and nested pages entirely with Arrow, Enter, Escape, Backspace, Tab, and Shift+Tab; verify Home, End, and platform text-editing chords still edit the search input.
9. Test numeric selection with empty query, non-empty query, selected text, disabled option, held key, and composition.
10. Repeat on macOS, Windows, and Linux using the displayed platform hints.
11. Repeat letter and digit tests with US QWERTY, German QWERTZ, French AZERTY, and Dvorak.
12. Reconfigure native Quick Voice to a known application chord and verify conflict recovery.

## 14. Phased implementation plan

### Phase 0: Freeze the contract and inventory

- Confirm proposed global defaults and open decisions below.
- Add a source-controlled command ID/default binding table.
- Verify whether SidebarProvider is mounted.
- Inventory all remaining document/window keydown listeners and manual overlays.
- Define platform detection and the Tauri-versus-browser-preview switch.

Exit criterion: every existing application-level listener has a migration disposition; no code behavior changes.

### Phase 1: Core registry and arbitration

- Implement pure types, parser, formatter, registry, resolver, diagnostics, search ranker, and tests.
- Implement provider, focus classifier, platform adapter, and overlay registry.
- Keep character-only commands disabled; add the persisted setting only when a real plain application shortcut is introduced.
- Mount the provider in the main shell with no large palette UI yet.
- Migrate one low-risk command and prove registration/cleanup and conflict diagnostics.

Exit criterion: deterministic shortcuts work without scattered new listeners; pure unit suite is complete.

### Phase 2: Root command palette

- Add cmdk and the shadcn Command wrapper.
- Implement CommandSurface, Dialog presentation, result search/grouping, async execution state, focus restoration, and accessibility tests.
- Register Settings and main-view navigation.
- Migrate Media Flow's Mod+K collision and make Add node contextual.
- Integrate the most common Radix overlays with the overlay stack.

Exit criterion: Mod+K has exactly one main-window owner and works across all views without opening over modals.

### Phase 3: View and entity commands

- Migrate RALPH semantic shortcuts and delete its overlapping window-level dispatcher paths.
- Register supported Chat Sessions actions with explicit target rules.
- Migrate Media undo/redo/copy/paste where appropriate.
- Add compact Popover rendering and reusable nested page stack.
- Add the first real property selector only when a view has the capability; do not add placeholder priority/project domain UI.

Exit criterion: Global, RALPH, Chat, entity, component, and overlay precedence are demonstrated by tests.

### Phase 4: Hardening and cleanup

- Register or convert remaining manual overlays.
- Remove duplicate editable-target helpers and use the central utility.
- Remove obsolete hard-coded shortcut titles.
- Add browser E2E, platform smoke coverage, axe, and assistive-technology verification.
- Test international layouts, reduced motion, scaling, and native global conflicts.
- Inspect production diagnostics and performance with real command counts.

Exit criterion: acceptance matrix passes and no active application-level shortcut bypasses the registry without a documented component-native reason.

## 15. Migration guidance for future commands

When adding a command:

1. Reuse a real domain action; do not place business logic in the command definition.
2. Choose a stable namespaced ID.
3. Choose the narrowest accurate scope.
4. Define when it is enabled, disabled with a useful reason, or hidden.
5. Add palette title, group, and only useful search keywords.
6. Add a direct shortcut only after platform, focus, native-global, and same-scope collision checks.
7. Register through the view/component hook and rely on cleanup.
8. Render hints from registry metadata; do not hard-code labels in tooltips.
9. Add parser/resolver and integration tests.
10. For destructive actions, call the existing confirmation path or add a point-of-action confirmation when the controller action has none.

Local keyboard interaction that exists only to operate a focused composite widget stays local. It should prevent default when handled and register its overlay/component ownership; it does not need to become a palette command.

## 16. Risks and recommended mitigations

| Risk | Mitigation |
| --- | --- |
| cmdk is mistaken for a full command architecture | Keep registry, resolver, context, and diagnostics independent; cmdk is a rendering primitive |
| React effects leave stale or duplicate view commands | Tokenized idempotent cleanup, active-view gating, Strict Mode tests |
| Global shortcuts steal editor or terminal input | Bubble listener, preventDefault ownership, composed-path focus classifier, strong terminal boundary |
| Same chord behaves according to mount order | Fixed scope precedence; ambiguous same-tier bindings execute none |
| Browser preview conflicts with desktop view keys | Tauri-only Mod+number and Mod+L defaults |
| Non-US layouts break letters or numeric selection | Semantic <code>event.key</code>, AltGraph rejection, layout-required digit Shift rule, manual layout matrix |
| Single-key shortcuts fail WCAG or speech input | Ship Settings toggle in the same phase; focused selector ownership only |
| Overlay focus leaks or stacked dialogs | Overlay registry, Radix Dialog/Popover, one palette dialog with internal pages |
| Command acts on stale selection | Live context revision and immediate pre-execution revalidation |
| Async results reorder or mutate the wrong view | Abort signals, request revisions, owner/view revision checks |
| A destructive controller action has no confirmation | The command confirms at the point of action, then calls the existing controller mutation |
| Too many root results degrade search | Register actions, not arbitrary entities; load entity options in child pages |
| Shortcut copy drifts | One formatter and metadata source for UI and aria-keyshortcuts |
| Native Quick Voice captures a conflicting chord | Cross-check configured native chord in Settings and diagnostics |
| Accessibility differs across WebViews | Automated semantics plus real AT/platform smoke testing |

## 17. Resolved decisions and remaining assumptions

Implementation proceeds with these resolved decisions:

1. **Global view shortcuts:** Mod+1 through Mod+6 follow App Rail order and are Tauri-only. Browser preview retains browser tab-selection behavior.
2. **Character-only shortcuts:** none ship in this release. The resolver supports them but defaults them off; the WCAG switch ships with the first real character-only command instead of appearing now without an effect.
3. **Command+K over a non-modal surface:** dismiss the top Popover/Menu, then open the palette. A modal blocks it.
4. **Terminal and editor behavior:** xterm owns all keyboard input, including Ctrl/Command+K. CodeMirror owns editor chords. Ordinary inputs permit Mod+K when their component has not prevented it.
5. **Disabled result policy:** show a disabled action only when it is recognizable and has a useful recovery reason; hide irrelevant actions.
6. **Media Add node:** no second direct shortcut. The root command and visible button open one shared node page in dialog and compact presentations respectively.
7. **Custom remapping and sequences:** defer. Stable IDs, canonical chords, and diagnostics preserve a migration path.
8. **Shortcut help:** do not ship a permanent help surface or launcher.
9. **Mission Control and Scheduler:** include both existing shell actions as searchable root commands without direct shortcuts.
10. **Chat target:** active conversation only. Focused-row targeting remains unresolved until the sidebar has an explicit, persistent row-selection contract.
11. **Native Quick Voice conflicts:** block saving a native shortcut that exactly matches a shipped application chord; native syntax validation remains authoritative in Rust.

Remaining verification assumptions:

- WebView2, WKWebView, WebKitGTK, NVDA, VoiceOver, Orca, international layouts, forced colors, and OS-level shortcut preemption require platform/manual smoke tests outside the browser-unit environment.
- The repository still has no established end-to-end desktop harness. Browser DOM integration tests cover the central interaction contract; adding a Playwright/Tauri harness remains follow-up infrastructure rather than an unverified test suite added nominally.

## 18. Implementation and verification record

### 18.1 Implemented

**Code-derived implementation record**

- Added a main-window command provider, atomic registration lifecycle, strict shortcut parser and formatter, composed-path focus classifier, invocation-focus capture preserved through nested page actions, overlay stack, Unicode-aware deterministic search, scope resolver, invalid/duplicate/collision fail-closed behavior, async command locks, cancellation handling, abort handling, and stale-surface revision checks.
- Added a cmdk-backed Radix dialog palette and compact anchored Popover presentation with nested pages, per-page query/highlight/scroll restoration, query filtering, current and disabled states, explicit numeric selection, error announcements, and invoker/fallback focus restoration.
- Integrated global Settings and guarded App Rail navigation, Mission Control, Smart Scheduler, active Chat session actions, RALPH editing actions, and Media undo/redo/copy/paste.
- Replaced Media Flow's competing Mod+K behavior with <code>media.flow.node.add</code>. The root palette and visible Add node button use one node-page definition; the old side panel remains only for isolated rendering without a provider.
- Removed the unused generated SidebarProvider Mod+B listener. Remaining document/window listeners are component-native Escape, gallery, file-search, or separate-window behavior documented in section 3.4.
- Registered shared Dialog, Sheet, Popover, and Dropdown Menu roots in the overlay stack and registered onboarding, voice input, the transient file-preview fallback, session/conversation menus, and RALPH manual surfaces explicitly.
- Added exact native Quick Voice collision validation, including the native parser's Mod/system-modifier and <code>Key…</code>/<code>Digit…</code> aliases, while leaving native accelerator grammar validation in Rust.
- Added CodeMirror and xterm focus boundaries and registry-rendered platform shortcut labels and <code>aria-keyshortcuts</code> on applicable visible controls.

### 18.2 Automated verification

**Verified result on 2026-08-05**

- <code>pnpm check</code>: passed.
- <code>pnpm typecheck</code>: passed for core, UI, and both test configurations.
- Full Vitest suite: 266 files passed; 2,319 tests passed and 1 skipped. On this Windows machine the inherited <code>TEMP</code> used an 8.3 path while Git returned the same path in long form, so the passing run normalized <code>TEMP</code>/<code>TMP</code> to its long form for that process only. The two affected pre-existing RALPH path tests also passed independently under that environment.
- Feature suites: 44 shortcut, registry, resolver, focus, search, palette, accessibility, async, nested-context, and Media page tests passed. The palette dialog has no axe-core violations under the automated jsdom rule set; color contrast remains a rendered-platform check.
- <code>pnpm build</code> and <code>pnpm build:ui</code>: passed; the UI production build transformed 2,735 modules.
- New command and Media page files pass <code>oxfmt --check</code>.

### 18.3 Remaining assumptions and risks

**Implementation judgment and unverified platform work**

- No development server was started. Interaction coverage used jsdom plus the production UI build; the repository has no established browser or Tauri E2E harness.
- Real WebView2, WKWebView, WebKitGTK, NVDA, VoiceOver, Orca, international layout, forced-colors, 200% zoom, and operating-system shortcut-preemption checks remain manual platform smoke work.
- No character-only application command ships, so no inert Settings switch was added. The resolver keeps such commands disabled until a future command ships with the WCAG-required control.
- Chat active-session and RALPH selection-sensitive commands use view scope with fresh availability closures because those views do not publish a stable entity-selection channel to the provider. Entity/component precedence is implemented and unit-tested; future persistent selection models can adopt it without changing the dispatcher.
- Native Quick Voice collisions are exact normalized chord comparisons against shipped defaults, including the aliases accepted by the installed Tauri shortcut parser. Rust remains authoritative for accepting or rejecting the broader native accelerator syntax.
