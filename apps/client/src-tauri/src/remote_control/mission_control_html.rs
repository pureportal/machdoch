use super::mission_control_script_events::mission_control_script_events;
use super::mission_control_script_render::mission_control_script_render;

pub(super) fn mission_control_html() -> String {
    let mut html = r##"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Machdoch Mission Control</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #020817; color: #e5edf7; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #020817; }
    button, input, select, textarea { font: inherit; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: 19rem minmax(0, 1fr) 25rem; grid-template-rows: auto minmax(0, 1fr); }
    .topbar { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .85rem 1rem; border-bottom: 1px solid #142033; background: #07111f; }
    .brand { display: grid; gap: .15rem; }
    h1, h2, h3 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 1.1rem; }
    h2 { font-size: .92rem; color: #f8fafc; }
    h3 { font-size: .78rem; color: #cbd5e1; text-transform: uppercase; }
    .status { display: inline-flex; align-items: center; gap: .5rem; color: #9fb0c4; font-size: .78rem; }
    .dot { width: .55rem; height: .55rem; border-radius: 999px; background: #22c55e; box-shadow: 0 0 0 4px rgba(34, 197, 94, .12); }
    .sidebar, .monitor { min-height: 0; overflow: auto; border-right: 1px solid #101827; background: #050d19; }
    .monitor { border-left: 1px solid #101827; border-right: 0; }
    .main { min-width: 0; min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; background: #020817; }
    .section { padding: .85rem; display: grid; gap: .7rem; border-bottom: 1px solid #101827; }
    .panel, .item, .message, .task { border: 1px solid #17263a; background: #07111f; border-radius: .5rem; }
    .panel { padding: .8rem; display: grid; gap: .65rem; }
    .item { width: 100%; padding: .65rem; color: inherit; text-align: left; cursor: pointer; }
    .item.active { border-color: #38bdf8; background: #0c1b2d; }
    .item strong, .message strong, .task strong { color: #f8fafc; }
    .conversation { min-height: 0; overflow: auto; padding: 1rem; display: grid; align-content: start; gap: .75rem; }
    .message { padding: .8rem; display: grid; gap: .55rem; line-height: 1.5; overflow-wrap: anywhere; }
    .message.user { border-color: #1f3b56; background: #081827; }
    .message.agent { border-color: #243044; background: #080f1c; }
    .content { white-space: pre-wrap; }
    .composer { border-top: 1px solid #101827; background: #050d19; padding: .85rem; display: grid; gap: .65rem; }
    .row, .actions, .meta { display: flex; flex-wrap: wrap; align-items: center; gap: .45rem; }
    .meta { color: #8fa4bb; font-size: .74rem; }
    .pill { border: 1px solid #25405e; background: #0d2138; border-radius: 999px; padding: .15rem .45rem; color: #b7c8dc; }
    .pill.good { border-color: #14532d; background: #052e1c; color: #bbf7d0; }
    .pill.bad { border-color: #7f1d1d; background: #361313; color: #fecaca; }
    button, .button { border: 1px solid #2c4663; background: #10243a; color: #f8fbff; min-height: 2rem; border-radius: .4rem; padding: .35rem .58rem; text-decoration: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: .35rem; }
    button.secondary { background: #07111f; color: #cbd8e7; }
    button.danger { border-color: #7f1d1d; background: #451a1a; color: #fecaca; }
    button:disabled { opacity: .45; cursor: not-allowed; }
    input, select, textarea { width: 100%; border: 1px solid #25405e; background: #020817; color: #f8fafc; border-radius: .4rem; padding: .55rem; }
    select, input { min-height: 2.2rem; }
    textarea { min-height: 5.5rem; resize: vertical; }
    .field-grid { display: grid; gap: .55rem; grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .stack { display: grid; gap: .55rem; }
    .scroll-list { display: grid; gap: .5rem; max-height: 19rem; overflow: auto; padding-right: .15rem; }
    .trace, .log, .event, .command { border: 1px solid #16283f; background: #020817; border-radius: .4rem; padding: .55rem; color: #cbd8e7; font-size: .78rem; line-height: 1.42; white-space: pre-wrap; overflow-wrap: anywhere; }
    .empty { color: #8194aa; font-size: .86rem; margin: 0; }
    .toast { min-height: 1.4rem; color: #a7f3d0; font-size: .82rem; }
    @media (max-width: 1180px) { .shell { grid-template-columns: 17rem minmax(0, 1fr); } .monitor { grid-column: 1 / -1; border-left: 0; border-top: 1px solid #101827; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr)); align-content: start; } }
    @media (max-width: 760px) { .shell { display: block; } .topbar { position: sticky; top: 0; z-index: 2; } .sidebar, .monitor, .conversation { max-height: none; overflow: visible; } .field-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <h1>Machdoch Mission Control</h1>
        <div class="status"><span class="dot"></span><span id="connection">Connecting</span></div>
      </div>
    </header>
    <aside class="sidebar">
      <section class="section">
        <div class="row">
          <h2>Sessions</h2>
          <button class="secondary" id="createSession" type="button">New</button>
        </div>
        <div class="scroll-list" id="shellSessions"><p class="empty">Waiting for desktop shell state.</p></div>
      </section>
      <section class="section">
        <h2>Runtime</h2>
        <div id="runtimePanel"><p class="empty">No runtime snapshot yet.</p></div>
      </section>
    </aside>
    <main class="main">
      <section class="section" id="sessionHeader"></section>
      <section class="conversation" id="conversation"><p class="empty">No conversation messages yet.</p></section>
      <section class="composer">
        <form class="stack" id="remotePromptForm">
          <textarea id="remotePrompt" name="prompt" placeholder="Prompt the selected session"></textarea>
          <div class="field-grid">
            <select id="providerSelect" aria-label="Provider"></select>
            <input id="modelInput" aria-label="Model" placeholder="Model">
            <select id="modeSelect" aria-label="Mode">
              <option value="ask">Ask</option>
              <option value="machdoch">Machdoch</option>
            </select>
            <select id="reasoningSelect" aria-label="Reasoning">
              <option value="default">Default</option>
              <option value="none">None</option>
              <option value="minimal">Minimal</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">Extra High</option>
              <option value="max">Max</option>
            </select>
          </div>
          <div class="actions">
            <button type="submit">Run Prompt</button>
            <button class="secondary" id="saveDraft" type="button">Save Draft</button>
            <button class="secondary" data-toggle="session-memory" type="button">Session Memory</button>
            <button class="secondary" data-toggle="global-memory" type="button">Global Memory</button>
            <button class="secondary" data-toggle="ui-control" type="button">UI Control</button>
            <button class="danger" id="cancelActiveTask" type="button">Cancel</button>
          </div>
        </form>
        <div class="meta" id="composerMeta"></div>
        <div class="toast" id="toast"></div>
      </section>
    </main>
    <aside class="monitor">
      <section class="section">
        <h2>Tasks</h2>
        <div class="scroll-list" id="tasks"><p class="empty">No task progress has streamed yet.</p></div>
      </section>
      <section class="section">
        <h2>Scheduler</h2>
        <div class="scroll-list" id="schedulerPanel"><p class="empty">No scheduler state yet.</p></div>
      </section>
      <section class="section">
        <h2>Context Packs</h2>
        <div class="scroll-list" id="contextPacks"><p class="empty">No context packs for this workspace.</p></div>
      </section>
      <section class="section">
        <h2>Commands</h2>
        <div class="scroll-list" id="commands"><p class="empty">No remote commands yet.</p></div>
      </section>
    </aside>
  </div>
  <script>
"##
    .to_string();
    html.push_str(mission_control_script_render());
    html.push_str(mission_control_script_events());
    html.push_str(
        r##"  </script>
</body>
</html>"##,
    );
    html
}
