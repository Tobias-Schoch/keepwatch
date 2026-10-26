# Keepwatch for macOS

An optional desktop client for a Keepwatch server. It is a thin native shell around the real
dashboard, not a re-implementation: the app opens its own SSH tunnel to your server and shows
the dashboard and your other admin UIs (Portainer, Nginx Proxy Manager, anything you add) in
tabs. It stays locked until Touch ID confirms, and it keeps an eye on the server from the menu bar.

You do not need it. `./keepwatch tunnel` plus a browser gives you the same dashboard. The app adds:

- **One window, one tab per admin UI.** The dashboard is always first (Cmd-1), then Cmd-2 ... Cmd-9.
  Each tab has its own persistent WKWebView, so logins and page state survive.
- **Automatic SSH tunnel** with fail2ban-friendly reconnects (see below), optionally over Tailscale.
- **Touch ID lock** on launch and after 15 minutes of inactivity.
- **Touch ID for dangerous dashboard actions** (a Secure Enclave key, since WebAuthn does not work in a WKWebView).
- **Menu bar watcher:** a colored dot for the server's state, a notification only when it goes down and comes back.
- **Pull backup:** your own restic copy of the server backup on your Mac, on request only.
- **Widgets:** status, attacks, services, backup and maintenance.

## Requirements

- macOS 15 (Sequoia) or newer, Apple silicon or Intel.
- Xcode or just the Command Line Tools (`xcode-select --install`), Swift 6 toolchain. No Xcode project.
- An SSH key that already works for your server (`ssh root@your-server` in Terminal), and the
  server's host key in `~/.ssh/known_hosts`.
- Optional: Tailscale, if your server's SSH is only reachable through it.
- Optional, for "Pull Backup": `brew install restic jq`.

## Install

From your keepwatch folder:

```sh
./keepwatch desktop        # writes the app's config from keepwatch.conf
desktop/build.sh           # builds desktop/build/Keepwatch.app
desktop/build.sh --install # ... and installs it to /Applications and launches it
```

`build.sh` signs with the first "Developer ID Application" identity in your keychain
(or `KEEPWATCH_SIGN_IDENTITY`), otherwise ad hoc. Ad hoc works for everything except the
widgets' data (see Widgets). A locally built app is not quarantined, so it needs no notarization;
if you distribute it, store a notarytool profile named `keepwatch-notary` (or set
`KEEPWATCH_NOTARY_PROFILE`) and `build.sh` notarizes and staples it.

Without a config file the app shows a first-run screen that explains `./keepwatch desktop`, and
picks the file up by itself once it appears. You can also enter host and user by hand
(Keepwatch > Settings).

## Configuration

`~/Library/Application Support/Keepwatch/config.json`, written by `./keepwatch desktop`:

```json
{
  "host": "203.0.113.10",
  "user": "root",
  "sshPort": 22,
  "requireTailscale": true,
  "uis": [
    {"name": "Dashboard", "port": 9004},
    {"name": "Portainer", "port": 9002},
    {"name": "Proxy Manager", "port": 9001},
    {"name": "Grafana", "port": 3000, "path": "/login"}
  ]
}
```

| Key | Meaning |
|---|---|
| `host` | IP or DNS name of the server (with Tailscale: its MagicDNS name). From `KW_HOST`. Required. IPv6 works with or without brackets (`2001:db8::1` or `[2001:db8::1]`): ssh gets it bare, restic's sftp URL gets `user@[2001:db8::1]`. |
| `user`, `sshPort` | SSH login. From `KW_SSH_USER`, `KW_SSH_PORT`. Default `root`, `22`. |
| `requireTailscale` | `true` when the `tailscale` module is enabled: the app checks Tailscale on this Mac, starts it if needed, and does not try SSH while it is off. `false`: plain SSH, no Tailscale checks at all. |
| `uis` | Admin UIs on the server's 127.0.0.1, one tab each. **The first entry is the dashboard** (`KW_DASHBOARD_PORT`). Then Portainer (`KW_PORTAINER_PORT`) and Proxy Manager (`KW_PROXY_ADMIN_PORT`) if those modules are enabled, then `KW_EXTRA_UIS` ("Name=port ..."). `path` is an optional start page. |
| `backupRepo` | Optional: restic repository on the server for "Pull Backup". Default `/var/backups/keepwatch/restic`. |

Unknown keys are ignored, missing ones get their defaults. `host` and `user` are validated
(plain names only) because they end up in ssh arguments and in a Terminal command.
After editing the file by hand: Server > Reload Configuration.

## SSH tunnel

The admin UIs only listen on the server's 127.0.0.1, so the only way in is SSH with your key.
The app starts:

```
/usr/bin/ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3
  -o BatchMode=yes -o PreferredAuthentications=publickey -o IdentitiesOnly=no
  -o ConnectTimeout=15 -o StrictHostKeyChecking=yes -o ControlMaster=no -o ControlPath=none
  -o Tag=keepwatch-desktop-tunnel
  -L 19004:127.0.0.1:9004 -L 19002:127.0.0.1:9002 -L 19001:127.0.0.1:9001 ...
  [-p <sshPort>] -- <user>@<host>
```

- **Keys:** whatever ssh uses anyway: `~/.ssh`, the ssh-agent / macOS keychain, an `IdentityAgent`
  such as 1Password. Your `~/.ssh/config` applies. The app has no keys of its own and never asks for a
  passphrase: a key with a passphrase must be in the agent (`ssh-add --apple-use-keychain ~/.ssh/<key>`).
- **Ports:** local port = 10000 + remote port (9004 -> 19004; remote ports above 54635 map to
  remote - 10000). If any of them is busy (another service, a second copy of the app), all of them
  move by 100 (19104, 19102 ...), then 200, up to 900. Free means nobody accepts connections there
  and binding 127.0.0.1 and ::1 works. The tunnel only listens locally.
- **Ready** as soon as ssh accepts on the dashboard's local port - it only does after a successful
  login. The watcher then asks `/api/overview` through the tunnel.
- **Reconnect:** if ssh drops after the tunnel was up (sleep, network change, server reboot), the app
  reconnects after 1 s. If a request fails through a tunnel that looks up, it checks with `HEAD /`
  and reconnects at most every 2 minutes. Network errors before the login are retried after
  3, 5, 10, 20, 30, 60 s (with `requireTailscale`, only while Tailscale is running).
- **fail2ban:** a Keepwatch server bans an address after very few failed SSH logins (by default for a
  week). sshd also logs "Connection closed by authenticating user ... [preauth]" when a BatchMode client
  simply has no usable key, and the aggressive sshd jail counts that too. So:
  - The app checks **locally**, without contacting the server, that a usable key exists (a key in the
    agent, or a key file without passphrase - a passphrase-protected key that is not in the agent is
    reported as "Your SSH key isn't available to the app. Run `ssh-add --apple-use-keychain ~/.ssh/<key>`
    (or add it to your agent) and retry.") and that the server is in `known_hosts` (also as
    `[host]:port`, `HostName` or `HostKeyAlias` from your ssh config).
  - Only clearly recognized network errors before authentication ("Connection refused", "Could not
    resolve hostname", timeouts, ...) are retried automatically. **Any other failure** - "Permission
    denied", "Too many authentication failures", "no such identity", passphrase or agent errors, a changed
    or unknown host key, any unexplained exit 255 before the forward came up, and a login that hangs for
    60 s (e.g. an agent waiting for approval) - stops automatic connecting **for good**: the block is
    stored in UserDefaults (`tunnelAuthBlock`) and survives sleep, relaunch, crash restarts and login.
    Only "Try Again" (one attempt per click, ignored while an attempt is running, because killing ssh
    mid-login would itself be logged) or a configuration change lifts it; a successful login clears it.
    So without user action the app produces at most one failed authentication, ever.
  - The state screen says what to do, with "Try Again" and "Open Terminal".
- **Quit:** SIGTERM to ssh, wait briefly. After a crash ssh would stay orphaned (parent launchd): the
  next launch kills such processes (`pgrep -f Tag=keepwatch-desktop-tunnel`, PPID 1).
- Links inside a UI that point at `http://localhost:<remote port>` or `http(s)://<host>:<remote port>`
  of a configured UI are rewritten to the tunnel. Links to other hosts and `target=_blank` open in your
  default browser. "Open in Browser" (Shift-Cmd-O) opens `http://localhost:<local port>`, which works
  while the app (and its tunnel) runs.
- Check by hand: `lsof -nP -iTCP -sTCP:LISTEN | grep 1900`,
  `curl -s -o /dev/null -w '%{http_code}' -H 'X-Dashboard: 1' http://localhost:19004/api/overview`.

## Lock

At launch and after **15 minutes** without input in the app's windows (keys, clicks, mouse, scrolling)
the content is covered: a lock screen instead of the pages, the web views are hidden (also from window
previews) and typing does not reach them. Unlock with Touch ID or this Mac's password
(`LAContext`, `.deviceOwnerAuthentication`): the button, Return/Space, or automatically when the window
comes to the front (but not right after you cancelled). Sleep counts as inactivity.

- The **menu bar icon** keeps showing the status. Every action - window content, tabs, pull backup,
  Terminal, copy SSH command, open in browser, widget click, notification - asks for Touch ID first and
  then runs. Lock now: Cmd-L.
- The dashboard's Touch ID bridge does not answer while the app is locked.
- Shorter timeout for testing: `defaults write io.github.keepwatch.desktop lockAfterSeconds -int 20`
  (at least 5); back: `defaults delete io.github.keepwatch.desktop lockAfterSeconds`.

## Menu bar

A dot from `/api/overview` (through the tunnel), every 60 s (30 s while the menu is open):
green = reachable, yellow = the dashboard reports a problem, red = unreachable, gray = not checked
because of this Mac (Tailscale off, no key, host key, ports - no server alarm), ring = checking.
Red only after 2 failures in a row (after the first one it checks again after 15 s). Notifications
only on the change to red and back; the problems themselves are in the dashboard.

Without a window the app lives in the menu bar only; clicking the app icon brings the window back.
"Open at Login" writes `~/Library/LaunchAgents/io.github.keepwatch.desktop.login.plist`, which starts
the installed app with `--hidden` (no window) and `KeepAlive` / `SuccessfulExit = false`: launchd
restarts it after a crash, not after "Quit". The installed copy in /Applications turns this on once by
default; a copy started from `build/` never touches it.

## Pull backup

Your own copy of the server's restic backup on this Mac - **only on request**, never by itself.
Button "Pull Backup" in the title bar (a sand-colored dot = not pulled today), in the menu bar menu
and under Server > Pull Backup (Shift-Cmd-S). The panel shows:

- **Last pulled** (time, snapshots, size) and the **folder** (default `~/Keepwatch Backups`, "Change ...").
  The folder must be empty or already a copy; an unplugged drive is detected.
- **Missing requirements** with a command to copy or run in Terminal: restic, jq, the keychain item
  `Keepwatch backup` holding the repository password
  (`security add-generic-password -s "Keepwatch backup" -a restic -w`; the password is on the server in
  `/etc/keepwatch/backup/restic.pass`), Tailscale, the folder.
- **Run:** the bundled `backup-pull.sh` (= `lib/backup-pull.sh`, same as `./keepwatch backup pull`) with
  `KW_APP=1`, `KW_HOST`, `KW_SSH_USER`, `KW_SSH_PORT`: read the server's snapshots without a lock ->
  `restic copy` over SFTP from `/var/backups/keepwatch/restic` -> `restic check` ("verify all data" =
  `--read-data`) -> confirm the server's newest snapshot is in the copy. Nothing is ever deleted on the Mac.
- **Cancel** sends SIGINT to the whole process group; restic removes its lock on the server itself
  (SIGTERM after 15 s, SIGKILL after 30 s). Quitting the app during a run asks first.

## Widgets

Four widgets: **Status** (small: one sentence about the server), **Attacks** (small: SSH attempts today,
7 days), **Services** (medium: one line per service, only deviations colored), **Backup & Maintenance**
(medium: last backup, copy on this Mac, updates, certificates). Light, dark and tinted.

- **Add them once:** right-click the desktop > Edit Widgets > Keepwatch.
- **Data:** widgets cannot open an SSH tunnel and have no network (sandbox without `network.client`).
  The **app** GETs the dashboard API through its tunnel (`overview`, `stacks`, `docker`, `sites`,
  `uptime`, `updates`, `backups`, `security/history`), condenses it (`Widgets/Model.swift`, compiled into
  app and extension) and writes `server-snapshot.json` into the app group - at most every 5 minutes,
  immediately when reachability changes. Older than 20 minutes -> the last snapshot with the reason
  ("App not running", "Tailscale off", "unreachable") and its time.
- **Click** opens the app on the matching dashboard page: `keepwatch://open/<overview|security|services|backups>`.
- **App group** `<TEAM ID>.io.github.keepwatch.desktop` (macOS form, no provisioning profile needed as
  long as app and extension are signed with the same team's Developer ID; `build.sh` derives the team ID
  from the signing identity). Signed ad hoc, the container stays closed and the widgets show sample data.
- If the widgets do not show up: `pluginkit -m -p com.apple.widgetkit-extension -v | grep keepwatch`
  must list `/Applications/Keepwatch.app/.../KeepwatchWidgets.appex`; otherwise launch the app once or
  `pluginkit -a /Applications/Keepwatch.app/Contents/PlugIns/KeepwatchWidgets.appex`, then `killall chronod`.

## Touch ID for dangerous actions

The dashboard asks for a WebAuthn assertion before dangerous actions. WebAuthn does not work in a
WKWebView without Associated Domains, so the app provides a native bridge (`Sources/TouchID.swift`):

- `window.webkit.messageHandlers.keepwatchTouchID` (also registered as `serverTouchID`), only in the
  dashboard's web view, only in the main frame of `http://localhost:<dashboard's local port>` (RP ID
  `localhost`), and not while the app is locked.
- `register`: new P-256 key in the Secure Enclave (`.privateKeyUsage + .biometryCurrentSet`), Touch ID,
  signature over `authenticatorData || SHA-256(clientDataJSON)` ->
  `{id, publicKey, clientDataJSON, authenticatorData, signature}`.
- `sign`: only if the app's own key id is in `allow` (otherwise `{error: "unknown"}`), otherwise as above
  with `webauthn.get`.
- Only the Secure Enclave blob is stored, in `~/Library/Application Support/Keepwatch/touchid-key.json`
  (worthless without this Mac) - no keychain item, no extra entitlements. Enrolling new fingerprints
  invalidates it: pair again in the dashboard and remove the old device there.
- The key only works for the RP ID it was created for (`localhost`), so it keeps working when the
  tunnel's local ports move.

## Security notes

- The app never stores SSH keys or passwords. SSH runs with `BatchMode=yes` and
  `StrictHostKeyChecking=yes`: it never asks for a password and never accepts an unknown host key.
  Confirm the fingerprint yourself once in Terminal.
- The tunnel and all pages are bound to 127.0.0.1 / localhost on your Mac. Anything else running as
  your user on this Mac can reach the forwarded ports while the app runs - the UIs' own logins still apply.
- The restic password is read by the script from the keychain at run time and only passed in that
  process's environment.
- The widget extension is sandboxed and has no network access. The app group contains only the
  condensed status, no secrets.

## Development

Three separately compiled parts: `Sources/` + `Shared/` + `Widgets/Model.swift` -> the app,
`Widgets/` + `Shared/` -> `KeepwatchWidgets.appex` (`-application-extension`, entry point
`_NSExtensionMain` like Xcode), `Tools/` -> helpers (icon, widget renderer). Because they are separate
modules, an editor that treats all files as one target shows bogus errors ("'main' attribute cannot be
used ..."); `build.sh` compiles cleanly.

Test hooks, all only for a copy started from `build/`, never the one in /Applications:

- `KEEPWATCH_SNAPSHOT=/tmp/snap build/Keepwatch.app/Contents/MacOS/Keepwatch` writes `window.png`,
  `statusicon.png`, `hittest.txt` (tunnel, ports, lock, phase), `lock.txt` and, if the pages throw,
  `console.log` after a few seconds. Add `KEEPWATCH_SNAPSHOT_DELAY`, `KEEPWATCH_SNAPSHOT_TAB=<index>`.
- `KEEPWATCH_SNAPSHOT_NOPROMPT=1`: locked without asking (lock screen);
  `KEEPWATCH_SNAPSHOT_UNLOCKED=1` (+ `-lockAfterSeconds 8`): starts unlocked, timeout lock applies;
  `KEEPWATCH_NOLOCK=1`: no lock at all.
- `KEEPWATCH_SNAPSHOT_CLICK=1` (with `NOPROMPT`): checks that clicks and keys reach the page after
  unlocking -> `click.txt` (expected `{"c":1,"d":1,"k":1}` twice).
- `KEEPWATCH_SNAPSHOT_TOUCHID=1`: asks the bridge with requests that are rejected without Touch ID -> `touchid.txt`.
- `KEEPWATCH_SNAPSHOT_BACKUP=panel|start|cancel` (+ `_EVERY`, `_COUNT`, `_CANCEL`): image series of the
  backup panel and `backup.txt`; `KEEPWATCH_SNAPSHOT_MISSING=restic,jq,tailscale` pretends those are missing.
  **Never test against a real server** (a real `restic copy` takes a lock there) - use a local repository:
  ```sh
  export RESTIC_PASSWORD=test; restic init -r /tmp/t/server; restic -r /tmp/t/server backup <folder>
  security add-generic-password -s "Keepwatch test" -a restic -w test
  KW_BACKUP_SOURCE=/tmp/t/server KW_BACKUP_KEYCHAIN="Keepwatch test" KEEPWATCH_SNAPSHOT=/tmp/snap \
    KEEPWATCH_SNAPSHOT_BACKUP=start build/Keepwatch.app/Contents/MacOS/Keepwatch -backupFolder /tmp/t/mac
  ```
  `-backupFolder` only applies to that launch.
- Widgets as images (live data through the running app's tunnel, sample, problem, offline; light and dark):
  `swiftc -parse-as-library -o build/tmp/RenderWidgets Tools/RenderWidgets.swift Widgets/Model.swift Widgets/Views.swift Shared/Shared.swift && build/tmp/RenderWidgets /tmp/w`
