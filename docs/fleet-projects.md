# Projects on a Fleet host

A headless Fleet host can keep a library of projects and run agent tasks in them through Fleet Manager. This works with `machdoch fleet service` on Linux and Windows. Update Fleet Manager and the host together when enabling this feature. Fleet Manager handles the browser and authenticated routing; Git, files, credentials, and agent execution stay on the selected host.

Open an instance in Fleet Manager to see **Projects**:

- **Clone repository** accepts an HTTPS or SSH Git URL. Choose a folder name, optionally a branch/tag, and optionally a shallow clone for a smaller initial download. Full history is the default.
- **Empty project** creates a folder and optionally initializes Git with a `main` branch.
- **Import folder** registers an existing folder directly inside the workspace root. It does not change that folder's contents.
- **New task** opens a new chat in the selected project. Choose a configured model and send the agent its task. **Resume** opens the latest unarchived chat for that project.
- **Services & previews** manages project servers and private website/API previews. See [remote services and previews](fleet-previews.md) for setup, supported protocols and isolation boundaries.
- **Cancel setup** stops a clone and its child processes. **Retry setup** retries a failed or cancelled operation when its destination is free. **Remove entry** removes an unused library entry and preserves its files. Delete its saved sessions first if they still reference the project.

Project creation and cloning continue after a browser disconnect. The page shows setup status and Git progress. Two setup operations can run at once, with a 30-minute deadline per operation. The library supports 100 projects and the host supports 80 saved sessions. Different projects can run agent tasks concurrently; a second task in the same workspace is rejected until the first finishes, to reduce conflicting edits.

## Workspace root

By default, projects are created under `projects` inside the directory passed to `fleet service run --cwd`. The host creates this root if needed. Existing sessions in the startup directory remain available through Chat.

To choose a root before the first run:

```sh
MACHDOCH_WORKSPACE_ROOT=/srv/machdoch/projects machdoch fleet service run --cwd /srv/machdoch
```

For a systemd installation, set the value in the service's private `fleet-service.env` file under `MACHDOCH_USER_CONFIG_DIR` and restart the unit:

```ini
MACHDOCH_WORKSPACE_ROOT=/srv/machdoch/projects
```

The service account needs write access to the root and its Machdoch config directory. The generated user unit and packaged system unit already read `fleet-service.env`. Environment variables from the shell that installs a service are not copied into the unit automatically.

The configured root is shown in the browser and is controlled locally on the host. It must be an absolute path. Project names are single folder names using letters, numbers, dots, underscores, or dashes. Traversal, absolute project paths, reserved Windows names, and linked/junction project folders are rejected. Existing directories are never overwritten by clone/create; use Import instead.

The library is saved as `fleet-projects-<workspace-hash>.json` alongside the host's configuration, separately from chat state. Back up both files and the project folders. Keep the same `--cwd` and root when restarting. A changed root fails closed instead of silently attaching saved chats to a different project tree. To relocate a populated installation, stop the host and migrate the library, chat paths, and project directories together before restarting.

## Git authentication and recovery

Install Git on the host. Configure private repository credentials for the same account that runs Machdoch: use its Git credential helper for HTTPS or its SSH keys and `known_hosts` for SSH. Background clones never open password or trust prompts. SSH uses batch mode and requires an already trusted host key. URLs containing passwords, HTTPS usernames, query parameters, or fragments are rejected; credentials must not be pasted into Fleet Manager.

Clones use an argument array with no command shell, permit only HTTPS/SSH transports, suppress hooks/templates, and skip automatic submodule and Git LFS downloads. These choices keep project setup bounded and avoid running repository setup code implicitly. Ask the agent to fetch LFS content or initialize submodules when the task needs them. Git options follow the official [clone documentation](https://git-scm.com/docs/git-clone.html), [configuration documentation](https://git-scm.com/docs/git-config), and [noninteractive environment controls](https://git-scm.com/docs/git).

A normal failure or cancellation cleans up only the directory reserved by that setup operation. A host crash marks interrupted setup as failed on restart and preserves any surviving files. If the folder is complete, remove the failed entry and import the folder; otherwise inspect the files on the host or use a different folder name. Raw Git diagnostics and credential-helper output are not relayed to the browser.

The workspace root constrains these project-management actions; it is not an operating-system sandbox for agent tools. Run the service as a dedicated, unprivileged account with access to the repositories and credentials it needs. See [background hosts](fleet-background-service.md) for systemd installation, shutdown, and resource limits.

The desktop tray gateway continues to expose its existing desktop workspace controls. The project library is advertised by headless Fleet hosts; older or desktop hosts do not show unsupported project actions.

## Verification

`pnpm verify:fleet-projects` uses Puppeteer against an isolated seeded Fleet Manager, connects a real CLI Fleet runtime, and checks creation, a real Git clone, browser reload, import, task routing, removal with file preservation, and responsive forms. Model execution is replaced with a deterministic file-writing fixture, so no provider request is made. It clones `https://github.com/octocat/Hello-World.git` by default; set `MACHDOCH_FLEET_TEST_REPOSITORY` to another reachable HTTPS/SSH test repository if needed.

Set `MACHDOCH_FLEET_UI_USERNAME`, `MACHDOCH_FLEET_UI_PASSWORD`, `MACHDOCH_FLEET_UI_FIXTURE=true`, and optionally `MACHDOCH_FLEET_UI_URL` (default `http://127.0.0.1:43188`). The check enrolls and revokes its own host and removes only its temporary host data. Screenshots are written to `apps/fleet-manager/.cache/projects-results`; `CHROME_PATH` and `MACHDOCH_PROJECTS_OUTPUT` override the browser and output directory.
