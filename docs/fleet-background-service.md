# Fleet hosts in the background

Use the desktop tray on Windows and systemd on Linux. The Linux headless package runs the Node CLI directly, without Tauri, GTK, WebKit, an X server, or a logged-in desktop. It supports the CLI Fleet product runtime: persistent chat sessions, remote project creation/cloning, and task execution across a managed project library. See [projects on a Fleet host](fleet-projects.md) for the workspace root, private Git credentials, and the browser workflow. Desktop capture, desktop windows, and other desktop-only commands remain unavailable. Fleet Manager is a separate application; these services run enrolled **hosts**.

## Windows

Enroll the desktop app from **Fleet Manager** and enable launch on sign-in and startup in the tray in **Settings → Desktop & startup**. Leave the application running in the tray. This runs in the user's login session; it does not run before sign-in. Do not register the desktop executable directly with `sc.exe`: it does not implement the Windows Service Control Manager protocol.

For a supervised terminal session, `machdoch fleet service run --cwd C:\Work\Project` still works. Use either the desktop gateway or the CLI gateway for a given enrollment. Closing/quitting the desktop app stops its gateway.

## Linux package

Install Node.js **22.13 or later** and the command-line tools your tasks need (for example Git and your chosen provider CLI). Download `machdoch-headless.tar.gz` from the release, or build it with `pnpm install --frozen-lockfile && pnpm build:headless`. The build writes `apps/client/dist/machdoch-headless.tar.gz`. The same archive supports Linux x64 and arm64 with the matching Node runtime installed. It includes `playwright-core`; browser binaries and their OS dependencies are optional and must be installed separately when browser tools are needed.

For a personal installation, extract it to a stable directory:

```sh
mkdir -p "$HOME/.local/opt"
tar -xzf machdoch-headless.tar.gz -C "$HOME/.local/opt"
"$HOME/.local/opt/machdoch/machdoch" --help
```

Use that absolute launcher path below, or add it to your `PATH`. Configure providers and enroll **as the account that will run the service**, with the same `HOME` and `MACHDOCH_USER_CONFIG_DIR`. Enrollment keys are one-time credentials; avoid retaining them in shell history.

```sh
machdoch fleet enroll --manager-url https://fleet.example.com --enrollment-key '<one-time-key>' --display-name 'Linux build host'
machdoch fleet enable
machdoch fleet service run --cwd /absolute/path/to/workspace
```

The last command is a foreground smoke check; Ctrl+C stops it. Fleet uses an outbound authenticated WebSocket over HTTPS. The host needs no inbound listening port. The selected workspace must already exist and be writable by the service account.

## Linux user service

Run these commands as a regular Linux user, not through `sudo`:

```sh
machdoch fleet service unit --cwd /absolute/path/to/workspace   # preview
machdoch fleet service install --cwd /absolute/path/to/workspace
machdoch fleet service status
journalctl --user -u machdoch-fleet.service -f
```

Installation writes `machdoch-fleet.service` under `$XDG_CONFIG_HOME/systemd/user` (default `~/.config/systemd/user`), reloads systemd, enables the unit and starts/restarts it. Paths and command arguments are escaped for systemd, and launch paths are absolute. Re-run install after moving/upgrading Node, changing the installation location, or changing the workspace. A custom unit with the same name is never overwritten. Inspect the emitted status and journal to confirm successful enrollment and connection.

To run at boot and survive logout, an administrator may need to enable lingering for the account:

```sh
sudo loginctl enable-linger "$USER"
```

Without lingering, the user service normally depends on an active login session. Installation reports this requirement; `fleet service status` reports `Linger` as `linger`. Minimal containers without a user systemd manager should supervise the foreground command instead. See [systemd's lingering documentation](https://www.freedesktop.org/software/systemd/man/252/loginctl.html#enable-linger%20%5BUSER%E2%80%A6%5D).

```sh
machdoch fleet service stop
machdoch fleet service start
machdoch fleet service restart
machdoch fleet service uninstall
```

Uninstall stops and disables only Machdoch's owned user unit. Enrollment, provider credentials, sessions, and workspace files are preserved. It does not disable lingering because other user services may rely on it.

## Linux system service for a dedicated server

This option starts before anyone signs in and does not require lingering. The administrator installs the archive and unit, while Machdoch runs as an unprivileged account. The following example uses Debian/Ubuntu account-management commands:

```sh
sudo useradd --system --user-group --create-home --home-dir /var/lib/machdoch --shell /usr/sbin/nologin machdoch
sudo install -d -m 0755 /opt/machdoch
sudo tar -xzf machdoch-headless.tar.gz -C /opt/machdoch --strip-components=1
sudo chown -R root:root /opt/machdoch
sudo install -d -o machdoch -g machdoch -m 0700 /var/lib/machdoch/config /var/lib/machdoch/workspace
sudo -u machdoch env HOME=/var/lib/machdoch MACHDOCH_USER_CONFIG_DIR=/var/lib/machdoch/config /opt/machdoch/machdoch fleet enroll --manager-url https://fleet.example.com --enrollment-key '<one-time-key>' --display-name 'Linux server'
sudo -u machdoch env HOME=/var/lib/machdoch MACHDOCH_USER_CONFIG_DIR=/var/lib/machdoch/config /opt/machdoch/machdoch fleet enable
sudo install -m 0644 /opt/machdoch/machdoch-fleet.service /etc/systemd/system/machdoch-fleet.service
sudo systemctl daemon-reload
sudo systemctl enable --now machdoch-fleet.service
sudo systemctl status machdoch-fleet.service
sudo journalctl -u machdoch-fleet.service -f
```

Configure the provider under this same account before submitting tasks. Node must be accessible via `/usr/local/bin:/usr/bin:/bin`; adjust the unit with `systemctl edit machdoch-fleet.service` if using another location. The shipped template is also in `packaging/systemd/machdoch-fleet.service` in the repository. To change workspace, override **both** `WorkingDirectory` and `ExecStart` (clear `ExecStart=` first before replacing it). Use `sudo systemctl start|stop|restart machdoch-fleet.service` for this system unit; the CLI management commands deliberately target user units only.

For removal, stop and disable the system unit, remove `/etc/systemd/system/machdoch-fleet.service`, then run `sudo systemctl daemon-reload`. Keep `/var/lib/machdoch` if you need its enrollment or sessions. Stop the service before replacing package files during upgrades; restart afterwards. Keep the installation directory owned by the administrator so agent tasks cannot modify the executable.

## Credentials, recovery, and resource control

Units capture `HOME`, the Machdoch config location, and tool `PATH`, never the launching shell's API keys. If a provider needs environment credentials, create `<MACHDOCH_USER_CONFIG_DIR>/fleet-service.env` owned by the service account with mode `0600`. Use systemd environment-file syntax (`NAME=value`, no `export`); it is not a shell script. Restart after editing. Configure provider CLI credentials and MCP tools under the same account; an SSH shell's environment and interactive login profiles are not inherited by the service.

Both units set a restrictive file mask, prevent privilege escalation through setuid executables, restart after transient process failures, and send logs to the journal. This is not a sandbox for arbitrary agent commands: grant the account access only to the repositories and credentials it needs. If using environment-file credentials, child tools inherit them; use provider-specific credential storage where appropriate.

Network failures and duplicate-connection conflicts retry with bounded backoff and jitter. Authentication/protocol rejection or invalid startup configuration exits with code **78** to prevent a supervisor restart loop. Correct the configuration or re-enroll, then restart the service. After repeatedly failing starts, `systemctl [--user] reset-failed machdoch-fleet.service` clears systemd's start limit. Disabling Fleet or resetting enrollment stops a running CLI host normally; enabling Fleet later requires starting the service again.

SIGINT/SIGTERM disconnect the gateway, reject new commands, cancel active work, persist task results, then release the service lock. The CLI allows 30 seconds for shutdown; systemd uses a 35-second deadline and control-group cleanup for surviving child processes. See [systemd service supervision](https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.service.xml) and [KillMode behavior](https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.kill.xml).

For stricter resource budgets, add `MemoryMax=`, `CPUQuota=`, or `TasksMax=` through a systemd drop-in sized for your models, builds, and subprocesses. These limits apply to the whole service, including agent tools. No restrictive default is imposed because local models and build tools have very different requirements.
