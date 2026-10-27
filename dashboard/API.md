# Keepwatch dashboard – API

Backend: `server/dashboard.py` (Python standard library, runs as root on the server,
listens on `127.0.0.1:$KW_DASHBOARD_PORT` only, default 9004). Frontend: `web/` (Vite +
React + Tailwind), built to `web/dist` and served by the backend under `/`.

Access only through an SSH tunnel (with the tailscale module: Tailscale **and** an SSH key).
The macOS app builds the tunnel itself; otherwise `./keepwatch tunnel`, or by hand:

```sh
ssh -L 9004:127.0.0.1:9004 root@<server>
# then http://localhost:9004
```

## Rules

- All responses are JSON. Times are Unix seconds (`number`), sizes in bytes, rates in
  bytes/second, percentages `0–100`.
- Write calls are `POST`/`PUT`/`DELETE` and need the header `X-Dashboard: 1` (CSRF
  protection). `Host` must be `localhost`, `127.0.0.1` or `[::1]` with any port
  (protection against DNS rebinding); an `Origin`, if sent, must be `http://` on one of those.
- Errors: HTTP 4xx/5xx with `{ "error": "An English sentence" }`. 400 = invalid request or body
  (bodies must be a JSON object), 403 = Host/Origin/`X-Dashboard` check failed, 404 = unknown endpoint or module
  off, 409 = conflicts with the current state. 502 = a system command failed (`systemctl`, `fail2ban-client`, …),
  503 = something the endpoint needs is missing or not running (tool not installed, Proxy Manager database not
  there yet, a database that cannot be opened), 504 = a system command timed out. 500 only for real bugs.
- Dangerous calls (list `DANGER` in `server/touchid.py`) need a passkey once a device is
  registered (and `KW_DASHBOARD_PASSKEY="yes"`): first `428` with a challenge, then the same
  request with `X-Touch-ID` (section "Passkey").
- Every response carries `X-Dashboard-Build: <id>` (id of the served UI). When it changes, a
  new version was deployed → reload the page.
- Fields that cannot be determined right now are `null`, never left out.

### Modules

Everything except `base` is optional (`KW_MODULES` in `keepwatch.conf`, see `GET /api/config`).
While a module is off:

- its endpoints answer **404** with `{ error: "The <name> module is not enabled (KW_MODULES in
  keepwatch.conf).", module: "<id>", enabled: false }` – read endpoints of whole sections may instead
  answer `{ enabled: false }` (noted per endpoint);
- sections of other responses that belong to it are `{ enabled: false }` (objects) or empty (lists);
- it never raises a problem in `/api/overview` `health`, and its background work pauses.

Configuration: `/etc/keepwatch/keepwatch.conf` (env `KW_CONF` overrides), defaults from
`keepwatch.conf.example` in the repository root. Dashboard secrets live in
`/etc/keepwatch/dashboard/`, its state in `/var/lib/keepwatch/dashboard/`.

## GET /api/config  (once at start)

```ts
{
  hostname: string;                    // KW_HOSTNAME, else the system hostname
  modules: Record<ModuleId, boolean>;  // every known module: base debloat auto-updates ssh-hardening
                                       // kernel-hardening auditd fail2ban ban-history tailscale docker firewall
                                       // log-archive backup image-scan lynis proxy portainer dashboard
  localTz: string;                     // KW_LOCAL_TZ ("Etc/UTC"): schedules and day boundaries
  ports: { dashboard: number; proxyAdmin: number; portainer: number };   // all on 127.0.0.1
  extraUis: { name: string; port: number }[];   // KW_EXTRA_UIS="Name=port Other_name=port" (_ → space)
  passkey: boolean;                    // KW_DASHBOARD_PASSKEY
  version: string;                     // VERSION file in the repository root, else the deployed commit from
                                       // VERSION.json ("abc1234", "+dirty" for uncommitted changes), else "dev"
  selfUpdate: boolean;                 // updates from the dashboard are on (KW_SELF_UPDATE_REPO is set)
}
```

`base` and `dashboard` are always `true`.

## GET /api/overview  (poll every 5 s)

```ts
{
  host: { hostname: string; ip: string; os: string; kernel: string;
          uptimeSec: number; bootTime: number; cpus: number; memTotal: number };
  now: {
    cpu: number;                       // %
    load: [number, number, number];
    mem: { total: number; used: number; available: number };
    swap: { total: number; used: number };
    disks: { mount: string; total: number; used: number }[];
    net: { rxBps: number; txBps: number };
    procs: number;
  };
  // 1 point per minute, up to 24 h back (collected since the backend started)
  history: { t: number[]; cpu: number[]; mem: number[]; rx: number[]; tx: number[]; load1: number[] };
  // 1 point every 5 s, last 15 min
  live: { t: number[]; cpu: number[]; mem: number[]; rx: number[]; tx: number[] };
  updates: { pending: number; security: number; rebootRequired: boolean;
             lastUpgrade: number | null; release: string; newRelease: string | null };
  health: Problem[];                   // everything that is red or yellow, crit first
}
type Problem = {
  level: "crit" | "warn";
  area: "security" | "docker" | "sites" | "backups" | "system" | "stacks";
  title: string; detail: string;       // English, for display only - do not match on them
  key: string;                         // stable id, e.g. "backup.remote-missing" (table below)
  target?: string;                     // settings row that fixes it: "settings/<row>"
};
```

`target` rows: `remote-access` (Tailscale / SSH), `passkey`, `fail2ban`, `backup-schedule`,
`backup-remote`, `backup-password`, `updates`, `log-archive`, `portainer`, `proxy`. Without
`target` the UI links to the page of `area`.

| key | level | area | target | module |
|---|---|---|---|---|
| `disk.full` / `disk.filling` | crit / warn | system | | |
| `memory.low` | warn | system | | |
| `system.reboot` | warn | system | | |
| `system.security-updates` | warn | system | `settings/updates` (with auto-updates) | |
| `fail2ban.ssh-jail` | crit | security | | fail2ban |
| `firewall.docker-user` | crit | security | | firewall + docker |
| `ssh.foreign-login` | crit | security | | firewall + tailscale, port 22 closed |
| `ssh.fallback-opened` | crit | security | `settings/remote-access` | firewall + tailscale |
| `ssh.unconfirmed` | warn | security | `settings/remote-access` | firewall + tailscale |
| `tailscale.key-expiry` | crit (< 30 days) / warn | security | `settings/remote-access` | tailscale |
| `container.down` / `container.unhealthy` / `container.restarting` | crit / crit / warn | docker | | docker |
| `cert.expiring` / `cert.expiring-soon` | crit / warn | sites | | proxy |
| `site.down` | crit | sites | | proxy |
| `backup.none` / `backup.stale` / `backup.failed` / `backup.verify-failed` | crit | backups | | backup |
| `backup.remote-missing` | warn | backups | `settings/backup-remote` | backup |
| `backup.remote-stale` | crit | backups | `settings/backup-remote` | backup |
| `portainer.disconnected` | warn | stacks | `settings/portainer` | portainer |
| `image.security-patch` | warn | docker | | docker + image-scan |
| `logarchive.stopped` / `logarchive.limit` | warn | docker | – / `settings/log-archive` | log-archive |
| `ctwatch.foreign-cert` | warn | security | | proxy |
| `secrets.findings` | warn | security | | portainer |
| `lynis.warning` / `lynis.index-dropped` / `lynis.failed` / `lynis.stale` | warn | security | | lynis |

## GET /api/security  (every 30 s)

```ts
{
  jails: { name: string; currentlyFailed: number; totalFailed: number;
           currentlyBanned: number; totalBanned: number }[];          // [] without fail2ban
  bans: { ip: string; jail: string; bannedAt: number | null; expiresAt: number | null; banCount: number;
          active: boolean; country: Country }[];                      // last 7 days, newest first; [] without fail2ban
  pastAttackers: BanHistoryStatus | null | { enabled: false };        // ban-history module (null: status unreadable)
  sshAttempts: { t: number[]; count: number[]; total24h: number; uniqueIps24h: number };  // 24 hourly bars
  banHistory: { t: number[]; count: number[];                         // 24 hourly bars
                byKind: { ssh: number[]; web: number[]; repeat: number[] } } | { enabled: false };  // fail2ban
  topIps: { ip: string; count: number; lastSeen: number; banned: boolean; country: Country }[];  // top 10, 24 h
  logins: { user: string; ip: string; at: number; method: string; country: Country }[];          // last 10 successful
  countries24h: { cc: string | null; name: string; attempts: number; ips: number }[];
  ports: { proto: "tcp"|"udp"; addr: string; port: number; process: string; exposure: "public"|"local"|"internal" }[];
  firewall: { enabled: true; allowedTcp: number[]; dockerUserActive: boolean | null } | { enabled: false };
  audit: { enabled: true; total24h: number; byKey: { key: string; count: number }[];
           recent: { at: number; key: string; exe: string | null; path: string | null }[] } | { enabled: false };  // auditd
}
// `keepwatch-ban-history status`, passed through. List: /var/lib/keepwatch/ban-history.json, nft table inet keepwatch_ban_history
type BanHistoryStatus = {
  active: boolean;                 // nft table in place
  banned: number;                  // addresses banned right now
  until: number | null;            // when the last of them expires
  builtAt: number | null;          // when the list was built
  dropped: number;                 // packets dropped by the table since boot
  // only once a list exists:
  days?: number;                   // each address stays banned this long after its last attempt
  source?: unknown;                // what the list was built from
  skipped?: { spared: number; ownLogins: number; networks: number; private: number; invalid: number;
              expired: number; released: number };   // addresses not banned, by reason
  spareCountries?: string[]; spareBelow?: number;    // countries spared below this many attempts
  released?: number;               // addresses released by hand (POST /api/security/unban, jail "ban-history")
};
type Country = { cc: string | null; name: string };   // name: English country name | "Tailnet" | "internal" | "unknown"
```

Ban kinds: `ssh` (all SSH jails), `web` (`web-scanner`, `app-login`), `repeat` (`recidive`).
Without the firewall module every listening socket that is not loopback/private counts as `public`;
with it, TCP is `public` only for ports the firewall lets in. Rejected attempts on a closed port 22
(kernel log prefix `ssh-closed:`, firewall module) count as SSH attempts.

`GET /api/security/history?days=7|30|90|0` (0 = everything there is) → values per day in `KW_LOCAL_TZ`:

```ts
{
  firstDay: string | null;        // oldest day with data ("2026-02-01")
  building: boolean;              // history is still being built (first minutes after start)
  days: { day: string; t: number; attempts: number | null; uniqueIps: number | null;
          bans: number | null;    // null = unknown (yet); bans only from the start of the fail2ban logs
          bansByKind: { ssh?: number; web?: number; repeat?: number } | null;
          blocked: number | null  // attempts from addresses that are banned today
        }[];
  total: { attempts: number; uniqueIps: number; blocked: number; blockedIps: number; bans: number | null;
           bansByKind: { ssh: number; web: number; repeat: number } };
  topIps: { ip: string; count: number; banned: boolean; country: Country }[];   // top 10 in the period
  countries: { cc: string | null; name: string; attempts: number; ips: number }[];
}
```

Countries come from the local DB-IP database (CC BY 4.0, show the note "IP Geolocation by DB-IP");
no IP leaves the server.

`GET /api/security/logins` → every IP with a successful login since the journal began:
`{ complete: boolean, firstDay, since: number | null, ips: { ip, first, last, count, countSince: number | null, users: string[], methods: string[], country, tailnet: boolean }[] }` (newest first).
`since` = since when port 22 is closed to the internet (SSH only through Tailscale; firewall + tailscale
modules): `SSH_PUBLIC_SINCE=<unix time>` (an ISO time is accepted too) in `/etc/keepwatch/firewall.env`, without it (and `SSH_PUBLIC=no`)
the file's mtime, `null` while the port is open. `countSince` = logins of this IP since `since`
(`null` when `since` is null).

`POST /api/security/unban` with `{ jail: string, ip: string }` → `{ ok: true }`. `jail: "ban-history"`
releases the address from the ban-history list (`keepwatch-ban-history release <ip>`); 404 when the
matching module (fail2ban / ban-history) is off. (There is no manual ban – that is fail2ban's job.)

`GET /api/security/ip?ip=<ip>` (quick search Cmd+K, `server/iplookup.py`, read-only) →

```ts
{
  ip: string; country: Country; tailnet: boolean;
  attempts: { total: number; days: number; first: string | null; last: string | null;   // aborted SSH logins
              since: string | null;                // counted from (start of the history)
              last24h: number | null };            // only if the IP is in the top 10 of the last 24 h
  banned: string[];                                // jails it is banned in right now; "ban-history" = past-attacker list
  bans: { jail: string; bannedAt: number; expiresAt: number | null; banCount: number }[];  // fail2ban DB, newest first, max. 20
  logins: { count: number; first: number; last: number; users: string[]; methods: string[] } | null;
  jails: string[];
}
```

Without the fail2ban module `banned` (apart from "ban-history"), `bans` and `jails` are empty.
"ban-history" only appears with the ban-history module.

## GET /api/docker  (every 10 s, needs module docker)

```ts
{
  containers: {
    name: string; image: string; state: "running"|"exited"|"restarting"|"paused"|"created"|"dead";
    status: string;                    // English text: "running", "exited (code 1)", ...
    health: "healthy"|"unhealthy"|"starting"|null;
    startedAt: number | null; restartCount: number;
    cpuPct: number | null; memUsed: number | null; memLimit: number | null;
    netRx: number | null; netTx: number | null;
    ports: string[]; networks: string[]; project: string | null;
    readOnly: boolean; user: string | null; privileged: boolean; dockerSock: boolean;
  }[];
  disk: { images: number; containers: number; volumes: number; buildCache: number };
}
```

- `GET /api/containers/<name>/logs?tail=300&since=<unix>` →
  `{ lines: { t: number; stream: "stdout"|"stderr"; text: string }[] }`
  (older single-container call; the UI uses `/api/logs`)
- `POST /api/containers/<name>/start|stop|restart` → `{ ok: true }`

### Live logs  (`server/logs.py`, needs module docker)

`GET /api/logs?c=<name>[@<cursor>]&c=...&window=3600&level=all|problems&limit=1000`

- `c`: 1–16 containers (a service = all its containers, interleaved). Without `@cursor` you get the
  window `window` (seconds, 60 … 604800; UI: 900 / 3600 / 86400). With `@cursor` only what came
  after it – the cursor comes from the previous response.
- `level=problems`: only errors and warnings; on first load up to 10 000 lines per container are
  scanned for them.
- `limit`: at most this many lines per container (1–2000).

```ts
{
  now: number; since: number;                 // Unix, since = start of the window
  lines: { t: number; c: string; stream: "stdout" | "stderr"; text: string;
           level: "error" | "warn" | null }[];   // by time, oldest first, at most 5000
  cursor: Record<string, string>;             // per container "sec.nanosec" → next request c=name@cursor
  truncated: string[];                        // limit hit: older lines are missing (first load)
                                              // or a gap (following with more than 500 new lines)
  dropped: number;                            // left out because of the 5000 limit
  errors: Record<string, string>;             // per container, e.g. "does not exist" (the others keep going)
}
```

- **Live** = the UI polls every 2 s with the cursor, only while the window is open, visible and not
  paused, and only once the previous response is in. No SSE: that would keep a thread and a
  `docker logs -f` open per window.
- **Level** (heuristic): an explicit level near the start of the line (`ERROR`, `[warn]`, `level=error`,
  `"level":"error"`, `FATAL`, `INF` …) wins; stack trace lines and Postgres `DETAIL/STATEMENT`
  inherit the level of the line before; otherwise HTTP 5xx = error, 429 = warning, words like
  error/exception/failed (not "0 failed") or warn/timeout/denied. ANSI colours are stripped.
- **Limits**: `docker logs` always with `--tail` (reads from the end), at most 32 MB raw and
  4000 characters per line, 12 s per request (then the processes are killed), at most 3 requests
  at once – otherwise 503 "Several log requests are already running" (the UI retries on the next tick).
- Without the docker module: 404 `{ error, module: "docker", enabled: false }`.

### Log archive  (`server/logarchive.py`, needs module log-archive, written by `keepwatch-log-archive`)

Docker deletes a container's logs as soon as it is recreated. The `keepwatch-log-archive` service
follows the json logs of all containers and stores them under
`/var/log/keepwatch/containers/<stack>/<container>/YYYY-MM-DD.log[.gz]` (days in UTC, older ones compressed).
The dashboard only reads these files – also for containers that no longer exist.

`GET /api/logarchive/lines?c=<name>[@<cursor>]&c=...&window=604800&level=all|problems&q=&limit=1000[&download=1]`

Same response and cursor as `GET /api/logs` – the live logs ask here for **7 days** and **14 days**
(anything over 24 h) and follow live this way too (the archive writes with ~1 s delay).

- `c`: container name or `stack/name`; a name that appeared in two stacks reads both.
- `window`: 60 … 7 776 000 s; `q`: only lines containing the text (case-insensitive, all days);
  `level=problems`: errors and warnings (same heuristic as above, all days).
- `limit`: newest lines per container, 1–2000; with `download=1` up to 50 000 per container and
  200 000 per response (the UI builds the .log file from it).
- Additional fields:

```ts
{
  ...as /api/logs,
  lines: { ...; sep?: "created" | "restarted" | "exited" | "removed" | "limit" }[],
        // sep = separator line, text e.g. "recreated · update: new image for web"
        // "exited"/"removed" within 2 min around a "created" are one switch → only one line
  archive: true;
  gone: string[];          // requested containers that no longer exist
  running: boolean;        // keepwatch-log-archive is writing (status.json younger than 5 min)
  retentionDays: number;
}
```

Reasons for a separator (as far as known): new image (update) or a different image, compose
settings changed, same image redeployed, crashed before (code ≠ 0) or out of memory (OOM),
"while the archive was not running". Without archive data `errors` carries a note (no 404).
Limits: 400 MB uncompressed and 15 s per request, at most 2 requests at once (503).

`GET /api/logarchive` (Settings → Log archive, every 60 s)

```ts
{
  installed: boolean; running: boolean; statusAt: number | null; since: number | null; dir: string;
  settings: { days: number; maxPerContainerMb: number; maxTotalMb: number };
  bytes: number;                      // whole archive on disk
  containers: { key: string; name: string; stack: string; exists: boolean | null; bytes: number;
                days: number; from: string; to: string; lastWrite: number | null;
                dropped: number;      // dropped today (limit per container)
                trimmed: string | null; // days up to here deleted early (space limit)
                image: string | null }[];
  skipped: Record<string, string>;    // containers without the json-file driver
  notes: string[];                    // notes from status.json (limits)
}
```

`PUT /api/logarchive/settings` `{ days?: 1–90, maxPerContainerMb?: 10–50000, maxTotalMb?: 50–200000 }`
writes `/etc/keepwatch/log-archive.conf` (`DAYS`, `MAX_MB_PER_CONTAINER`, `MAX_MB_TOTAL`; total ≥ per
container); the service re-reads it within a minute. Response as `GET /api/logarchive`.
Health (area docker): "Log archive stopped" (`key: "logarchive.stopped"`, status older than 5 min) and
"Log archive at its limit" (`key: "logarchive.limit"`, `target: "settings/log-archive"`).
Without the log-archive module every endpoint answers 404 and no problems are raised.

## GET /api/stacks  (every 30 s, needs module portainer)

```ts
{
  portainer: { connected: boolean; reason: string | null };  // without a token: false + reason
  stacks: {
    id: number | null; name: string; source: "git" | "file" | "compose";
    git: { url: string; ref: string } | null;
    autoUpdate: string | null;              // e.g. "5m"
    containers: string[];
    envCount: number | null;
    updatedAt: number | null; updatedBy: string | null;
    managed: boolean;                        // false = runs outside Portainer (e.g. the proxy stack)
  }[];
}
```

- `GET /api/stacks/<id>/env` → `{ env: { name: string; value: string }[] }`
- `PUT /api/stacks/<id>/env` with `{ env: [...] }` → saves and redeploys → `{ ok: true }`
- `POST /api/stacks/<id>/redeploy` with `{ pullImage: boolean }` → `{ ok: true }`

Portainer is reached at `http://127.0.0.1:$KW_PORTAINER_PORT`, the access token lives in
`/etc/keepwatch/dashboard/portainer.token`.

## GET /api/sites  (every 60 s, needs module proxy)

```ts
{
  defaultSite: string;
  sites: {
    id: number; domains: string[]; target: string;      // "container:port"
    enabled: boolean; sslForced: boolean; hsts: boolean;
    allowlist: number;                                   // number of allow lines, 0 = open
    pathLock: string[];                                  // paths behind their own allow-list
    cert: { expiresAt: number; daysLeft: number; issuer: string } | null;
    check: { code: number; ms: number } | null;          // request from the server itself
    requests24h: number; errors4xx24h: number; errors5xx24h: number; blocked24h: number;  // from the NPM logs
  }[];
}
```

Proxy Manager data: `/srv/keepwatch/proxy/data` (database, nginx files, logs) and
`/srv/keepwatch/proxy/letsencrypt`.

### Renew certificates

- `POST /api/sites/<id>/renew` with `{ force?: boolean }` (default `true`) → renews this site's
  Let's Encrypt certificate like the Proxy Manager itself (certbot inside the container, new
  expiry date in its database, reload nginx) → `{ ok, message, renewed: boolean, expiresAt, daysLeft }`.
  With `force: false` only when it expires in < 30 days. Let's Encrypt allows 5 new certificates
  per week and domain.
- `POST /api/sites/renew-due` → every certificate that expires in < 30 days → `{ ok, renewed, message }`.

### New site  (`server/hosts.py`, needs modules proxy + docker; UI: Services → "New site")

Creates a proxy host through the **Proxy Manager's REST API** (`http://127.0.0.1:$KW_PROXY_ADMIN_PORT/api`,
`NPM_URL` overrides). The Proxy Manager writes its DB and config itself and fetches the certificate.
Login via `POST /api/tokens` with email + password from `/etc/keepwatch/dashboard/npm.json`
(600, never sent back to the UI); the token is kept in memory and renewed on 401. Accounts with
2FA do not work (create a separate user). Without the proxy or docker module all endpoints below
(including `/api/settings/npm`) answer 404.
After a job that created (or rolled back) a host, the dashboard runs `fail2ban-client reload`
(fail2ban module only): fail2ban expands the log globs of its web jails only when it loads, so a new
host's access log is watched from then on. Portainer deploy webhooks are not per host: they come
from `KW_PORTAINER_WEBHOOKS="<webhook-id>@<domain> ..."` (proxy module), the wizard does not touch them.

- `GET /api/hosts/new` → everything for the wizard:
  ```ts
  { npm: NpmStatus; serverIps: { v4: string[]; v6: string[] };
    defaults: { values: SslFlags; counts: Record<keyof SslFlags, number>; basis: number };  // majority of the active hosts
    targets: { npm: { name; networks: string[]; join: string | null };                      // join: network for the compose file (KW_PROXY_NETWORK if present)
               containers: { name; image; project; service; composeFile; networks; shared: string[]; reachable: boolean;
                             hostNetwork; listening: number[]; exposed: number[]; suggestedPort: number | null; sites: string[] }[] };
    ipLists: { name; named: boolean; entries: { value; note; addresses }[]; sites: string[] }[];  // from the allow lines of all hosts, by comment
    myIps: string[] }   // public ones only (Tailscale addresses do not help in an allow-list)
  SslFlags = { certificate, sslForced, hsts, hstsSubdomains, http2, blockExploits, caching, websockets: boolean }
  ```
  `listening` = listening TCP ports in the container's network namespace (`/proc/<pid>/net/tcp{,6}`, without loopback).
  `reachable` = shares a user-defined network with the Proxy Manager (`bridge` does not count: no name resolution there).
- `GET /api/hosts/check?domain=<d>&www=0|1` → `{ domain, domains, taken: { domain, kind, id }[], dns: { name, a, aaaa, cname, ok, problem }[], serverIps, ok }`.
  `kind`: `"proxy host" | "redirection host" | "404 host"`. DNS via `dig @1.1.1.1` (no local cache), otherwise the
  system resolver. `ok`: no host has the domain (proxy, redirection, 404) and A/AAAA point only to this server.
  400 for an invalid domain.
- `POST /api/hosts` with `{ domain, www, forwardHost, forwardPort, forwardScheme: "http"|"https", ssl: SslFlags,
  access: { mode: "open"|"list", entries: { value, note }[] } }` → `{ ok, job }`. Checks everything again
  (taken → 409, wrong DNS with certificate → 400, no shared network → 400, no credentials → 409).
  One job at a time. Allowed IPs end up like with `PUT /api/access/<id>` as `allow …; # name` + `deny all;`
  in `advanced_config`, `access_list_id` stays 0.
- `GET /api/hosts/jobs/<id>` (every second while `state = "running"`) →
  ```ts
  { id; state: "running" | "done" | "failed"; domain; domains; url: string | null; hostId: number | null; error: string | null;
    rollback: { label: string; ok: boolean }[];
    steps: { key: "host" | "cert" | "https" | "test"; label; state: "pending" | "running" | "ok" | "failed" | "warning" | "skipped" | "cancelled"; detail: string | null }[] }
  ```
  Steps: create host (without certificate) → certificate (`POST /api/nginx/certificates`, HTTP challenge) →
  force HTTPS (`PUT` on the host: certificate_id, ssl_forced, HSTS, HTTP/2) → test request (curl via 127.0.0.1;
  502/504 = `warning`, 403 with an allow-list = ok). **If one of the first three fails, everything is rolled back**:
  the host is removed with `DELETE` (a soft delete in NPM, config gone), and so is a certificate already fetched.
- `GET /api/settings/npm` → `{ configured, email, connected, reason, checkedAt, url }` (re-checks at most every 10 min).
- `PUT /api/settings/npm` with `{ email, password }` → logs in, checks admin rights, only then saves
  → `{ ok, message }`. An empty password with the same email keeps the stored one.
- `POST /api/settings/npm/test` → `{ ok, message }` (fresh login, rights, version). `DELETE /api/settings/npm` → `{ ok }`.

### Availability  (`server/uptime.py`, needs module `proxy`)

A thread fetches every enabled site once a minute (curl via 127.0.0.1 with the real name, like the check
in `/api/sites`). "Answers" means: 2xx/3xx (or 401) on `/`; containers listed in `PROBE_PATHS` (empty by default)
use their own path and codes; with an IP allow-list 403 **and** the container answers directly on its Docker IP
with < 500 (the block applies before `proxy_pass`). A failure is retried after 5 s; only then is it an outage.
Storage: `/var/lib/keepwatch/dashboard/uptime.db` - `checks` 90 days, after that only daily totals (`days`, 2 years)
and `outages`. While the proxy module is off, nothing is probed and both endpoints return 404.

- `GET /api/uptime` (every 60 s) →
  ```ts
  { interval: 60; since: number | null;
    sites: { domain; hostId; expect: string; url: string;
             last: { t; ok; ms; code; reason } | null; down: boolean; downSince: number | null; downReason: string | null;
             uptime30: number | null;    // % of the checks of the last 30 days, 6 decimals; null = not measured yet
             avgMs24h: number | null;
             days: { day: "YYYY-MM-DD"; total: number; ok: number; downSec: number }[] }[] }   // 90 days, oldest first, KW_LOCAL_TZ
  ```
- `GET /api/uptime/site?domain=<d>&range=24h|7d` → `{ domain, range, bucket, from, to,
  points: { t, ms, maxMs, fails, n }[], outages: { start, end, durationSec, reason, lastReason }[] }`
  (24h in 5-minute, 7d in hourly buckets; `ms` = mean of the successful checks; outages of the last 90 days).

`expect` and `reason` are English display texts (e.g. `"2xx/3xx on /"`, `"403 (IP allow-list) and the container
answers"`, `"502 - container unreachable"`, `"timeout"`).

### Security grade  (`server/sitegrade.py`, needs module `proxy`; UI: chip "B 84" in the site row, strip in the expanded service)

A **score of 0-100** per site from six fixed categories; the grade A-F follows from the score alone.
What a visitor sees is checked - through the **public domain**. Every 6 h, new sites within 10 min, on demand,
and right after the grading changes (`schema`). **Read-only:** TLS handshakes (also deliberately with TLS 1.0/1.1
and weak ciphers), `GET` on `/` (redirects on the same host are followed), on `http://<domain>/`, on a login page
(link containing login/signin, otherwise `/login`, `/signin`, `/auth/login`, `/admin/login` - counts only with a password
field and content other than the home page), on `/admin`, `/api/admin` and on a page that does not exist
(`/keepwatch-grade-<random>`). Never POST, never a login attempt. The server's own addresses are in fail2ban's
`ignoreip`. Result: `/var/lib/keepwatch/dashboard/sitegrade.json`. Try it on the server:
`python3 /opt/keepwatch/dashboard/server/sitegrade.py [domain ...] [--json]` (reads proxy hosts, containers and scan itself).
While the proxy module is off, nothing is checked and all endpoints return 404.

**Behind an IP allow-list** (home page 403, host with allow-list) **the app itself** is graded as well: `GET` straight to
the container on the Docker network (container IP and port as in the Proxy Manager, `Host: <domain>`, `X-Forwarded-Proto: https`
- like `uptime.py`). Headers, cookies, login search and error page then come from the app, plus HSTS and `Server` from the
Proxy Manager (it adds HSTS with `always` and hides the app's `Server`) - exactly what an allowed visitor gets.
Ciphers, certificate and redirect still from outside. `via: "app"`, UI "checked: app directly".
If the container does not answer (or answers ≥ 500), only the block page counts (`via: "lock"`): app headers are then `skip`.

- `GET /api/sitegrade` (every 60 s, every 2 s while a check runs) →
  ```ts
  { checkedAt: number | null; checking: string[]; error: string | null; every: 21600;
    npmWrite: boolean;            // Proxy Manager credentials stored → "Turn on HSTS" works directly
    schema: 2; alertBelow: 80;    // below this "Grade C · 72" shows in the header of a service
    grades: { grade; min }[];     // A 90, B 80, C 70, D 60, E 50, F 0
    categories: { id; title; max; checks: { id; title; weight }[] }[];   // the schema, see the table
    sites: { schema; id: number | null; domain; checkedAt; checking?: boolean;
             grade: "A"…"F" | null;  score: number | null;   // 0-100 after caps; null = unreachable (error)
             raw: number | null;                              // before caps
             via: "public" | "app" | "lock";
             limited: boolean; limitedNote: string | null;    // behind an IP allow-list
             status: number | null; appStatus: number | null; url; loginUrl; admin: { path; status }[];
             caps: { grade; max; reason }[];                  // caps that apply
             categories: { id: "transport"|"header"|"cookies"|"leak"|"access"|"software"; title; max; points;
                           problems: number; skipped: boolean }[];
             error: string | null;
             checks: { id; category; title; status: "ok"|"warn"|"fail"|"skip"; weight; deduction;
                       via: "public" | "app" | "scan";
                       summary: string; detail: string;
                       fix: { where; text; snippet: string | null; action: "hsts" | "force-ssl" | null } | null }[] }[] }
  ```
  Category titles: Transport, Headers, Cookies & session, Information leaks, Access protection, Software.
- `POST /api/sitegrade/check` with `{}` (all) or `{ id }` (one) → `{ ok, checking: true }`; runs in the background.
- `POST /api/sitegrade/fix` with `{ id, fix: "hsts" | "force-ssl" }` → `{ ok, message }`. Turns **on** `hsts_enabled`
  (+ `ssl_forced`) or `ssl_forced` on the proxy host - through the Proxy Manager API (`hosts.npm`: database, rewrite
  conf, `nginx -t`, reload; if nginx refuses, the old state stays). The dashboard cannot turn it off.
  Needs a certificate and credentials (Settings → Proxy Manager access), otherwise 409. A new check follows.

**Scoring:** Every check has a fixed weight. A failure costs the full weight, a warning half, ok/skip nothing.
Points of a category = maximum − deductions; **score = sum of the categories** (rounded). Caps (as with SSL Labs)
limit the score: invalid certificate / no handshake → at most 49 (F), HTTPS not enforced or outdated ciphers
→ 79 (C), TLS 1.0/1.1 or no forward secrecy → 89 (B). **Grade from the score:** A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60,
E ≥ 50, otherwise F. Every deduction names the reason, points and "How to fix".

| Category (max) | Check | Weight | Failure | Warning |
|---|---|---|---|---|
| **Transport (30)** | TLS versions | 6 | TLS 1.0/1.1 on (cap B) | TLS 1.3 missing |
| | Ciphers | 5 | 3DES/RC4/NULL/EXPORT (cap C) | without forward secrecy (cap B); CBC under TLS 1.2 |
| | Certificate | 8 | invalid, expired, chain, name (cap F); < 7 days | < 21 days |
| | HTTP → HTTPS | 5 | HTTP serves content (cap C) | redirect to another host / not to HTTPS |
| | HSTS | 6 | missing / max-age=0 | < 180 days; without includeSubDomains (the **first** header counts) |
| **Headers (25)** | Content-Security-Policy | 10 | missing (report-only does not count) | `script-src` with `'unsafe-inline'` (without nonce/hash), `'unsafe-eval'`, `*`/`https:`/`data:`; without `frame-ancestors` |
| | Framing protection | 5 | neither XFO nor frame-ancestors | XFO neither DENY nor SAMEORIGIN |
| | X-Content-Type-Options | 4 | missing | not `nosniff` |
| | Referrer-Policy | 3 | - | missing; `unsafe-url`, `no-referrer-when-downgrade` |
| | Permissions-Policy | 3 | - | missing |
| **Cookies & session (10)** | Cookies (home page + login) | 10 | a cookie without Secure | without SameSite; session cookie without HttpOnly |
| **Information leaks (5)** | Version disclosure | 3 | - | `Server` with version, `X-Powered-By`, `X-AspNet-Version`, `X-Generator` |
| | Error pages | 2 | stack trace / debug page | version in the page (e.g. `nginx/1.30.6` → `server_tokens off;`) |
| **Access protection (15)** | Login protection | 10 | login/admin found, neither fail2ban nor rate limit | only one of both |
| | Admin area | 5 | - | `/admin` & co. answer publicly with their own page (200 or 401) |
| **Software (15)** | Critical vulnerabilities | 10 | ≥ 1 CRITICAL with a fix | CRITICAL only without a fix |
| | High vulnerabilities | 5 | ≥ 10 HIGH with a fix | 1-9 HIGH with a fix |

Login protection is ok when the site is behind an IP allow-list, no login can be found, or **both** apply:
the `app-login` jail runs (module `fail2ban`, `fail2ban-client status app-login`) and covers the path (login/admin page or
the form's `action` matches the path pattern of `modules/fail2ban/files/filter-app-login.conf`), and the **rate limit**
(`limit_req zone=...` from `modules/proxy/files/server_proxy.conf`, `KW_PROXY_RATE` requests/s per IP) is included in the
proxy host's conf. 403 on an admin path counts as blocked.
Software: all containers of the same Compose project as the proxy host's target (app, database, ...), Trivy result from
`/var/lib/keepwatch/image-scan.json` (module `image-scan`, `KW_IMAGE_SCAN_TIME`), counted per CVE. Without the image-scan
module both software checks are `skip` (no deduction). No site owns the Proxy Manager itself - it is listed under Updates.

**Why these weights:** Transport is the foundation (without a secure connection everything else is worthless); the caps
catch the severe cases anyway. The headers (25) are protection in the browser, the CSP the most important of them (XSS).
Access protection and software (15 each) measure whether anyone gets to the app or to known vulnerabilities at all - that
weighs more than single headers, but not more than transport. Information leaks (5) only make searching easier, they open
nothing by themselves. Deliberately fair: vulnerabilities without a fixed version and checks that cannot be seen (`skip`)
cost nothing; a public login protected by fail2ban and the rate limit only costs half of the 5 admin-area points.

**Where the headers come from:** The Proxy Manager only sets HSTS (always `max-age=63072000; [includeSubDomains;] preload`);
everything else comes from the app. If a different HSTS header comes first, it is the app's - "How to fix" then points to the
app. `add_header` under Advanced at server level does not apply to `location /` once the host sets HSTS - so set headers in
the app. `proxy_hide_header` under Advanced works. A Proxy Manager quirk: every host conf redefines
`map $scheme $hsts_header`, nginx uses the one loaded last - "HSTS Subdomains" does not work per host.

**Timeline:** If the score drops compared to the last check (same `schema`), the module writes
"Security grade <domain>: 82 → 76" with the new deductions (`kind: "security"`, `source: "sitegrade"`,
`warn` when the grade gets worse, otherwise `info`).

## Certificate watch  (`server/ctwatch.py`, UI: `web/src/ctwatch/CtWatchCard.tsx`, needs module `proxy`)

Reports certificates for your own domains that did **not** come from this server (phishing copies,
taken-over DNS records). Every 6 hours, new base domains after 10 min at the latest, and on demand.
State: `/var/lib/keepwatch/dashboard/ctwatch.json` (survives restarts, part of the backup).
Try it without the dashboard (read only, saves nothing): `python3 /opt/keepwatch/dashboard/server/ctwatch.py` (`--json` for everything).
With `proxy` off, every endpoint answers `404 { error, module: "proxy", enabled: false }`, the watch does not run and raises no problems.

**Domains:** the base domain (last two labels, three for `co.uk` and friends) of every proxy, redirection and 404 host and
every certificate in Nginx Proxy Manager - including deleted and disabled ones. Each base domain is queried **with all
subdomains**, so new hosts are covered automatically.

**Source:** Cert Spotter (`api.certspotter.com/v1/issuances?domain=…&include_subdomains=true&expand=dns_names,issuer,cert_der`).
Fast (< 1 s), current, returns the SHA-256 fingerprint and the certificate (-> serial number), unexpired only;
resumed with `after=<last id>` (usually one request per base domain and run). Without an account 10 requests/hour;
`/etc/keepwatch/dashboard/certspotter.token` is sent as a Bearer token if present. If Cert Spotter fails,
**crt.sh** steps in (`?q=%25.<base>&output=json&exclude=expired&deduplicate=Y`) - often > 60 s or 502 and sometimes weeks
behind, so only as a fallback. Both: timeout (30/75 s), 3 retries after 5/20/60 s, `Retry-After` on 429 (over 2 min ->
give up until the next run), 8 s between requests; "Check now" queries the same base domain at most every 15 min.
Results are kept.

**"From this server"** (first matching rule; recorded when first seen, afterwards only upgraded):

| `ownBy` | Rule |
|---|---|
| `serial` | Serial number equals a certificate of the proxy (`letsencrypt/archive/*/certN.pem`, `live/*/cert.pem`, `data/custom_ssl/*/*.pem` under `/srv/keepwatch/proxy`). Own serials are remembered - cleaning up the archive changes nothing. |
| `fingerprint` | SHA-256 of the certificate equals one of these files. |
| `run` | Issuer Let's Encrypt **and** the proxy requested all names of the certificate in a renewal run **and** issuance (NotBefore + 1 h, LE backdates) lies between 10 min before and 30 min after the run started. Runs: "Requesting/Renewing … for <names>" and `--cert-name npm-N` (-> names from the proxy database) in `data/logs/letsencrypt.log*` (UTC), `created_on` of every proxy certificate, NotBefore of the stored certificates. Runs are remembered (the logs rotate). |

Deliberately **not**: "Let's Encrypt + domain managed by the proxy" alone - that is exactly what a certificate after a
DNS takeover looks like. Everything else is foreign. Once marked **known** (old server, previous host, CDN) it never
shows up again.

Only a foreign certificate that shows up **new** raises an alert - in the first run (baseline, `baselineAt`) only if it is
younger than 14 days; older ones sit quietly in the list ("mark all known"). Then one timeline event per certificate
(`kind: "security"`, `source: "ct"`, `level: "warn"`, `key: "ct:<serial>"`) and, until it is marked known, a health problem
`{ level: "warn", area: "security", key: "ctwatch.foreign-cert", title: "Foreign certificate for <name>" | "<n> foreign certificates" }`.
The first run also adds an info event "Certificate watch set up". Expired certificates are forgotten after 180 days
(except open alerts).

- `GET /api/ctwatch` (every 60 s, every 2 s during a run) ->
  ```ts
  { checkedAt: number | null; checking: boolean; error: string | null;  // error: which base domain could not be queried, and why
    every: 21600; source: "certspotter" | "crt.sh" | "mixed" | null; baselineAt: number | null;
    bases: string[]; hosts: string[];                                   // queried base domains, active hosts
    counts: { total; own; known; unknown; alerts };
    certs: { key: string;                       // serial number (hex, no leading zeros), otherwise "sha:<sha256>"
             names: string[]; issuer: string | null; issuerCn: string | null;   // "Let's Encrypt", "YE1"
             notBefore: number | null; notAfter: number | null; expired: boolean; revoked: boolean;
             firstSeen: number | null;
             own: boolean; ownBy: "serial" | "fingerprint" | "run" | null; ownNote: string | null;
             known: boolean; knownAt: number | null;
             alert: boolean;                     // new, foreign, not known -> alert
             baseline: boolean; src: "certspotter" | "crt.sh" | null;
             crtsh: string }[] }                 // https://crt.sh/?id=… | ?sha256=… | ?serial=…
  ```
- `POST /api/ctwatch/check` with `{}` -> `{ ok, checking: true }`; runs in the background.
- `POST /api/ctwatch/known` with `{ keys: string[] }` or `{ all: "baseline" }` (all quiet ones from the baseline) or
  `{ all: "all" }`; `undo: true` reverts -> `{ ok, count, message }`.

## Secrets check  (`server/secrets_check.py`, UI: `web/src/secrets/SecretsCard.tsx`, needs module `portainer`)

Checks the environment variables of the Portainer stacks (Portainer's `GET /api/stacks`, one call per run) every 15 min,
on the first request after a restart and on demand. **Values never leave the process**: not in responses, logs,
files or the timeline; findings never mention lengths. Per stack and variable only
`PBKDF2-SHA256(value, salt, 120 000 rounds)` (128 bit) and the time it was first seen are stored
(`/var/lib/keepwatch/dashboard/secrets-check.json`, 0600); the salt lives separately in `/etc/keepwatch/dashboard/secrets-check.salt`
(32 bytes, 0600, created on the first run). Try it on the server (read only, prints findings only):
`python3 /opt/keepwatch/dashboard/server/secrets_check.py --dry`.
With `portainer` off, every endpoint answers `404 { error, module: "portainer", enabled: false }` and no problems are raised.

**What counts as a secret:** every value with a known prefix (Stripe `sk_live_`/`rk_live_`/`sk_test_`/`rk_test_`/`pk_test_`/`whsec_`,
Resend `re_`, GitHub `ghp_`/`gho_`/`ghs_`/`github_pat_`, GitLab `glpat-`, OpenAI `sk-`/`sk-proj-`, Anthropic `sk-ant-`, Slack `xox?-`,
SendGrid `SG.`, Google `AIza`, npm `npm_`, PEM `-----BEGIN … PRIVATE KEY-----`, JWT `eyJ….eyJ….…`, JWK JSON with `kty` and `d`),
every URL with a password (`proto://user:pw@…` - the password is rated), otherwise by name
(`SECRET|TOKEN|PASSWORD|PASS|PWD|PRIVATE|CREDENTIAL|API_KEY|ACCESS_KEY|…_KEY|SALT|SIGNING|ENCRYPTION|DSN|WEBHOOK`, not
`PUBLIC|PUBLISHABLE|NEXT_PUBLIC_|VITE_|…_ID|…_URL|…_USER|…`). `pk_live_` is public and does not count.

**Findings** (`kind`): `test-in-prod` (Stripe test key in a production stack: `NODE_ENV`/`APP_ENV`/`ENVIRONMENT`/… =
production, or without such a variable no test/dev/staging in the stack name), `placeholder` (changeme, test, secret, `<…>`, `xxx` …),
`weak` ("too short" < 12 characters, "contains a common word", "little randomness": estimated from character pool and Shannon
entropy, passwords < 64 bit, other secrets < 96 bit; not for provider keys), `duplicate` (same hash in another stack ->
warning; only in another variable of the same stack -> hint `info`), `due` (older than the limit for its type).
**Acknowledging** applies to the current value (hash): findings become `info`, `acked: true`; a reminder comes back after another
full period from the acknowledgement. When the value changes, the acknowledgement is gone and the age starts over (timeline:
"Secret replaced: NAME", `source: "secrets"`).

**Age:** from the first sighting. Values that already exist on the very first run get the creation of the stack in Portainer
(`CreationDate`) as their start - an upper bound, `estimated: true` ("~" in the UI).

**Limits (defaults, days, 0 = no reminder):** Stripe live 365, Stripe test key 0, Stripe webhook 365, Resend 365,
GitHub 90, GitLab 90, npm 90, AWS 90, OpenAI 180, Anthropic 180, Slack 365, SendGrid 365, Google 365, JWK 365, PEM 365, JWT 365,
password 365, secret 365.

Health: one combined entry while there are open findings (`level: "warn"`):
`{ level: "warn", area: "security", key: "secrets.findings", title: "Secret: <finding>" | "Secrets: <n> with findings", detail: "<NAME> in <stack> …" }`.

- `GET /api/secrets` (every 60 s, every 2 s during a run) ->
  ```ts
  { checkedAt: number | null; checking: boolean; error: string | null; every: 900;
    portainer: boolean | null;                 // false: token missing / Portainer unreachable (error says why)
    baselineAt: number | null;
    types: { id; label; defaultDays; maxAgeDays; where: string; url: string | null; steps: string[] }[];  // "Replace" instructions
    items: { id: "<stackId>/<NAME>"; stackId: number; stack: string; name: string;
             type: string; typeLabel: string; production: boolean;   // type ids incl. "password", "secret"
             since: number; estimated: boolean; ageDays: number; maxAgeDays: number; dueAt: number | null;
             findings: { kind: "test-in-prod" | "placeholder" | "weak" | "duplicate" | "due";
                         level: "warn" | "info"; text: string; acked?: boolean }[];
             acked: boolean; ackedAt: number | null }[];
    counts: { secrets: number; withFindings: number; due: number } }
  ```
- `POST /api/secrets/check` with `{}` -> `{ ok, checking: true }`.
- `POST /api/secrets/ack` with `{ stackId, name }` (`undo: true` reverts) -> `{ ok, message }`.
- `PUT /api/secrets/settings` with `{ maxAgeDays: { [type]: 0–3650 } }` -> `{ ok }`.
- Replacing a value goes through the existing `PUT /api/stacks/{id}/env` (variables dialog, `EnvSheet` with `focus`).

## Hardening audit (Lynis)  (`server/lynis.py`, needs module `lynis`)

The run itself is done by `keepwatch-lynis` (`keepwatch-lynis.service`, timer at `KW_LYNIS_TIME`, default `Sun 00:30`,
2-3 min, nice 15). It writes `/var/lib/keepwatch/lynis.json` (last run + history of 12 runs). The backend only reads it and
judges it against `/etc/keepwatch/lynis-exceptions.conf` (repository: `modules/lynis/files/exceptions.conf`, one reason per
`TEST-ID[:sub-finding]`): a finding is **deliberate** when the whole test ID or all of its sub-findings are listed there; a new
sub-finding is open again. Exceptions take effect at once, without a new run. Short title and explanation come from `TITLES` in
`lynis.py` (if one is missing: the text from Lynis).
Try it (read only): `python3 server/lynis.py lynis.json --exceptions modules/lynis/files/exceptions.conf [--json]`.

Timeline: one event per run (`source: "lynis"`, key `lynis:<finishedAt>`), `warn` on a new warning or a dropped index.
Health (`area: "security"`, always `level: "warn"`):

| key | title |
|---|---|
| `lynis.warning` | "Lynis warning: <title>" (up to 3) |
| `lynis.index-dropped` | "Hardening index dropped" |
| `lynis.failed` | "Hardening audit failed" |
| `lynis.stale` | "Hardening audit is not running" (no run for 15 days) |

- `GET /api/lynis` (every 5 min, every 3 s during a run) → `{ enabled: false }` without the module, otherwise
  ```ts
  { enabled: true;
    installed: boolean;                       // keepwatch-lynis.service loaded
    running: boolean; lastResult: string | null; error: string | null; checkedAt: number | null;
    schedule: string;                         // KW_LYNIS_TIME, e.g. "Sun 00:30"
    timezone: string;                         // KW_LOCAL_TZ the schedule is in
    exceptionsFile: string | null; exceptions: number;
    run: { startedAt; finishedAt; index; tests; lynisVersion; vulnerablePackages } | null;   // null: never ran
    previous: { finishedAt; index } | null;
    counts: { open: number; accepted: number; warnings: number; new: number };
    findings: { id: "KRNL-6000"; kind: "warning" | "suggestion"; title: string; hint: string | null;
                text: string | null; detail: string | null; solution: string | null;
                url: "https://cisofy.com/lynis/controls/<ID>/" | null;
                open: boolean; reason: string | null;   // the reason when deliberate
                new: boolean;                           // newly open since the previous run
                items: { key: "<ID>:<sub>"; label: string; detail: string | null;   // "1 -> 0", "9.0 UNSAFE"
                         open: boolean; reason: string | null }[] }[];   // sorted: open, warning, new, ID
    history: { finishedAt; index; open: number; warnings: number }[] }
  ```
- `POST /api/lynis/run` with `{}` → `{ ok, running: true }` (one already running: the same); 409 when the unit is missing,
  404 without the module.

## Updates & rollback  (`server/updates.py`, needs module `docker`)

Checked in the background every 6 h and on demand. Images from a registry: local RepoDigest against the digest of the tag
(Docker Hub via hub.docker.com including the version tag for the digest, ghcr.io with an anonymous token - private ⇒
`unknown`). Locally built images (Compose label on the image) are listed with their Git stack and the deployed commit
(Portainer `GitConfig.ConfigHash`, only with module `portainer`); the dashboard cannot see the state of the repository
(private repos) - that is what "Redeploy" is for.

### GET /api/updates  (every 60 s, every 3 s while a job runs)

Without module `docker`: `{ enabled: false }`.

```ts
{
  enabled: true;
  checkedAt: number | null; checking: boolean; error: string | null;
  available: number; major: number;          // count of "update" and "major"
  images: {
    key: string; ref: string;                // "postgres:16-alpine"
    containers: string[]; services: string[]; name: string | null;   // "Proxy Manager" ...
    project: string | null; via: "portainer" | "compose" | null;     // how it is recreated
    status: "current" | "update" | "major" | "unknown";
    kind: "major" | "minor" | "patch" | "build" | null;  // build = same version, new build
    security: boolean;                       // Postgres patch/build ⇒ security patch (dock dot)
    reason: string | null;                   // why unknown
    local: { digest: string | null; version: string | null; created: number | null };
    remote: { digest: string | null; version: string | null; updated: number | null } | null;
    notesUrl: string | null;
    previous: { ref: string; id: string; created: number | null; version: string | null; savedAt: number | null } | null; // <repo>:keepwatch-previous
  }[];
  stacks: { name: string; id: number; commit: string | null; branch: string; deployedAt: number | null;
            autoUpdate: string | null; built: string[] }[];   // empty without module portainer
  jobs: Record<string, { key: string; action: "update" | "rollback"; state: "running" | "ok" | "rolledBack" | "error";
                         step: string | null; startedAt: number; finishedAt: number | null; message: string | null }>;
  scan: Scan;                                // see below
}
```

- `POST /api/updates/check` → `{ ok, checking: true }` (the check runs in the background)
- `POST /api/updates/apply` with `{ key }` → `{ ok, job }`. In the background: tag the running image as
  `<repo>:keepwatch-previous`, for Postgres `pg_dumpall` to `/var/backups/keepwatch/pre-update/` (3 per container), then pull
  and recreate (Portainer stack: redeploy with pull - redeploys the whole stack; other Compose projects:
  `docker compose pull/up -d --no-deps <service>`), wait up to 2 min for "healthy", otherwise roll back to
  `:keepwatch-previous` automatically. `major` ⇒ 409 (display only).
- `POST /api/updates/rollback` with `{ key }` → `{ ok, job }` (`:keepwatch-previous` back onto the tag, recreate without pull)
- One job at a time (cleanup included), otherwise 409. All POSTs here: 404 without module `docker`.
- Open security patches show up in `health` (`area: "docker"`, `key: "image.security-patch"`,
  title "Security patch for <ref>").

**Security scan (Trivy, needs module `image-scan`):** `keepwatch-image-scan.service` (timer at `KW_IMAGE_SCAN_TIME`,
default `Sun 01:30`) scans the images of all running containers with Trivy for HIGH/CRITICAL and writes
`/var/lib/keepwatch/image-scan.json` (progress during a run: `image-scan.progress.json` next to it).
`GET /api/updates` carries it as `scan` (`{ enabled: false }` without the module):

```ts
type Scan = { enabled: false } | {
  enabled: true;
  installed: boolean; running: boolean; lastResult: string | null;      // systemd Result, e.g. "exit-code"
  progress: { startedAt: number; current: string | null; done: number; total: number } | null;
  startedAt: number | null; finishedAt: number | null; ok: boolean | null; error: string | null;
  previousAt?: number | null;
  images: Record<string, {   // key = image ref as in the container
    containers: string[]; critical: number; high: number; error: string | null; scannedAt: number;
    vulns: { id: string; pkg: string; installed: string; fixed: string | null; severity: "CRITICAL" | "HIGH";
             title: string | null; url: string | null; target: string | null }[];   // at most 200
  }>;   // infrastructure (stacks not managed by Portainer) is left out
};
```

- `POST /api/updates/scan` → `{ ok, running: true }` (`systemctl start --no-block keepwatch-image-scan.service`;
  409 when not set up, 404 without module `image-scan`)

### Cleanup  (needs module `docker`)

- `GET /api/cleanup` →
  `{ total, parts: { images, containers, volumes, buildCache }, buildCache: { bytes },
     images: { bytes, count, items: { ref, size }[] }, kept: { ref, size }[], containers: { bytes, count, items: string[] } }`
  (`images` = without containers and not `:keepwatch-previous`; `kept` = the `:keepwatch-previous` tags; cached for 60 s)
- `POST /api/cleanup` with `{ buildCache?, images?, containers? }` → `{ ok, freed, message }`
  (`docker builder prune -af`, `docker rmi` without `-f` per image, `docker container prune -f`; never volumes)

## Timeline "What happened?"  (`server/timeline.py`, UI: `#timeline`, overview -> "Since yesterday")

Everything that happens on the server, as events in `/var/lib/keepwatch/dashboard/timeline.db`
(SQLite, 120 days, included in the backup). On the first start it is filled in from the existing logs
(`backfill: true`, "from logs"). Sources of disabled modules are skipped (see "Sources").

```ts
type TlKind = "services" | "backup" | "system" | "security" | "dashboard";
interface TlEvent {
  id: number; t: number; tEnd: number | null;      // tEnd: end of a run, or the last ban in that hour
  kind: TlKind; title: string; detail: string | null;
  level: "info" | "warn" | "crit";                 // warn/crit = problem (only those get a color)
  service: string | null; serviceTitle: string | null;  // stack / compose project, display name as on "Services"
  source: string;   // docker | portainer | backup | probe | apt | boot | cert | deploy | f2b | ssh | port22 | audit | updates | image | ...
  count: number;    // grouped: bans per hour + jail, SSH logins per hour + address
  backfill: boolean;
  link: TlLink | null;  // click target: page + element
}
type TlLink =
  | { view: View; sel?: string; text?: string; exact?: boolean; up?: string }  // page, then flash the element matching sel + text
  | { view: "settings"; setting: SettingRow };                                  // open this settings row
// View ids used by the backend: "overview" | "services" | "backups" | "security" | "settings"
// SettingRow (same as problem `target` "settings/<row>"): "remote-access" | "passkey" | "fail2ban" | "backup-schedule"
//   | "backup-remote" | "backup-password" | "updates" | "log-archive" | "portainer" | "proxy"
```

- `GET /api/timeline?from=&to=&before=&kind=services,system&service=&problems=1&q=&limit=300` (every 30 s) ->
  `{ events: TlEvent[] /* newest first */, more, services: { id, title, count }[],
     counts: { [kind]: { total, problems } }, range: { from, to }, oldest, keepDays, backfilledAt, backfilling }`
  (`before` = older page; `services`/`counts` cover the time range without the other filters;
  `problems` accepts `1`, `true`, `yes`)
- `GET /api/timeline/recent?n=8` (every 60 s) -> `{ since /* yesterday 00:00 in KW_LOCAL_TZ */, events, total, problems, backfilling }`
  - the n most important events since yesterday: problems first, then by weight (reboot, port 22, backup, deploy, updates ...).

Sources (module in brackets; skipped while it is off):
- `docker events` [docker] - own reader thread; starts of one project within 20 s = one event,
  starts right after boot = one event.
- Portainer stacks [portainer] - `UpdateDate`, commit from `GitConfig.ConfigHash`, merged into the docker event.
- Journal of `keepwatch-backup` / `keepwatch-backup-verify` [backup] (older snapshots from restic). The backup
  script's lines it reads: restic output, `[HH:MM:SS] step` lines, `-> remote (<name>)` and `No remote repository`.
- `/var/log/apt/history.log*`, `journalctl --list-boots` (+ kernel per boot) - always.
- `deploys.jsonl` (`/var/lib/keepwatch/deploys.jsonl`, written by `lib/apply.sh`:
  `{ t, commit, subject, dirty, changed: string[] }`) - always.
- `letsencrypt/archive/npm-*/certN.pem` and `<proxy data>/logs/letsencrypt.log*` [proxy].
- fail2ban [fail2ban] - its log for the backfill, `fail2ban.sqlite3` afterwards.
- SSH `Accepted` lines from the journal - always (flagged `warn` when a login comes from outside the tailnet
  after port 22 was closed; that check needs [firewall] + [tailscale]).
- Port 22 open/closed from the journal of `keepwatch-firewall` [firewall] (expects a line like
  `Firewall set on eth0: public TCP 22,80,443`), automatic reopening from syslog identifier
  `keepwatch-ssh-fallback` [tailscale] (a message containing "reopened"/"opened").

Dashboard actions: every response to `POST`/`PUT`/`DELETE` is recorded through a hook in `Handler._json`
as `kind: "dashboard"` - only method, endpoint, success and a fixed summary
("IP allow-list of shop.example.com changed"). From the request body `timeline._summary` reads only an
allow-list of harmless fields (`ip`, `jail`, `public`, `pullImage`, `key`, `domain`, `mode`, `paths`, and the
repository type before the first `:` of `repo`), never tokens, passwords, credentials or environment variables
(of `env` only the count). Responses `428` (passkey required) are not recorded.

Other modules add events with `timeline.add(kind, title, detail=..., level=..., service=..., key=..., link=...)`
(docstring in `timeline.py`); `key` makes an entry unique.

## Keepwatch updates  (`server/selfupdate.py`, UI: overview banner + Settings → Keepwatch updates, `web/src/selfupdate.ts`)

The work is done by `keepwatch-self-update` (`lib/kwupdate.py`, installed by the dashboard module), the backend only
reads its result and starts it:

- **What runs**: `/opt/keepwatch/VERSION.json` `{ commit (40 hex), dirty, date, subject, repo ("owner/repo" of a
  github.com origin), ui (fingerprint of the UI sources the build fits, or null), source: "deploy" | "dashboard", at }`,
  written by `./keepwatch deploy` and by an update.
- **Check**: `keepwatch-self-update-check.service` (timer every 6 h, randomized, while `KW_SELF_UPDATE_CHECK` is on; and
  "Check now"). Unauthenticated GitHub API: `GET /repos/<repo>/commits/<branch>` with `If-None-Match`, then
  `GET /repos/<repo>/compare/<installed>...<latest>` once per pair. Writes `/var/lib/keepwatch/update.json`. Offline and
  GitHub's rate limit (403/429) only set `error` (and `retryAt`), the last result stays.
- **Apply**: `keepwatch-self-update@<sha>.service`, its own unit because `lib/apply.sh` restarts the dashboard. Only the
  commit of the last check, only if nothing was deployed since. Downloads `codeload.github.com/<repo>/tar.gz/<sha>` (top
  directory `<name>-<sha>/` and git's recorded commit id are checked), reuses the installed UI build when the UI sources did
  not change, otherwise fetches the build CI published for them (release `dashboard-ui`, asset
  `keepwatch-ui-<fingerprint>.tar.gz`, `.github/workflows/dashboard-ui.yml`) - missing: stops before changing anything.
  Keeps `/etc/keepwatch/keepwatch.conf`, swaps `/opt/keepwatch` ↔ the new copy (previous: `/opt/keepwatch.prev`), runs
  `lib/apply.sh`. If that fails: the previous copy goes back (the failed one to `/opt/keepwatch.failed`) and `apply.sh`
  runs again. One deploy or update at a time: `flock /run/keepwatch.lock` (apply.sh, deploy's copy, the updater).
- Timeline: `deploys.jsonl` lines carry `via: "deploy" | "dashboard" | "rollback"`; a rolled-back update adds `ok: false`.

Without `KW_SELF_UPDATE_REPO`: `GET` answers `{ enabled: false }`, the others 404.

- `GET /api/self-update` (every 60 s, every 2 s while an update runs; keep polling while the dashboard restarts)
  ```ts
  { enabled: true; repo: "owner/repo"; branch: string; url: "https://github.com/owner/repo";
    autoCheck: boolean;                      // keepwatch-self-update-check.timer enabled
    installed: { commit: string | null; date: number | null; subject: string | null; dirty: boolean;
                 source: "deploy" | "dashboard" | null; at: number | null; repo: string | null };   // VERSION.json
    latest: { commit: string; date: number | null; subject: string | null } | null;   // newest on the branch
    current: boolean;                        // the last check was made for what runs now (else: checking again)
    available: boolean;                      // the branch has something this server does not run
    localBuild: boolean;                     // dirty, or a commit that is not on the branch (updating replaces it)
    otherRepo: boolean;                      // deployed from another GitHub repository than KW_SELF_UPDATE_REPO
    changes: string[]; moreChanges: number;  // commit subjects for "What's new" (newest first, max 20)
    checkedAt: number | null; error: string | null; errorAt: number | null; retryAt: number | null;
    run: { state: "idle" | "running" | "done" | "failed";
           step: "starting" | "prepare" | "download" | "install" | "apply" | "rollback" | null;
           module: string | null;            // section of apply.sh in progress
           target: string | null; startedAt: number | null; finishedAt: number | null;
           message: string | null; rolledBack: boolean; log: string[] } }   // last 40 lines
  ```
  A `running` update without a sign of life for 90 s whose unit is gone is reported as `failed`.
- `POST /api/self-update/check` `{}` → like `GET` (a check in the last 30 s is not repeated); 503 when the unit is missing.
- `POST /api/self-update/apply` `{ sha }` → `{ ok: true, ...GET }`, the update runs in the background. **Passkey**
  ("Install a Keepwatch update"). `sha` must be `latest.commit` with `available` (409 otherwise: "Check again"), 409 while
  one runs.
- `PUT /api/self-update/settings` `{ autoCheck: boolean }` → like `GET`. Switches the timer; a deploy only overrides it
  when `KW_SELF_UPDATE_CHECK` changed since the last deploy.

## GET /api/backups  (every 10 s, every 2 s during a backup; needs module backup)

```ts
{
  enabled: true;
  targets: { name: string; kind: "local" | "remote"; configured: boolean; location: string;   // location without credentials
             snapshots: number; size: number | null; lastSnapshot: number | null }[];
  running: boolean;
  lastRun: { startedAt: number; finishedAt: number | null; ok: boolean | null; durationSec: number | null } | null;
  nextRun: number | null;
  snapshots: { id: string; time: number; paths: string[]; tags: string[]; target: string }[];  // newest first;
                                                   // target = "Local" or the remote's name
  log: string[];          // last ~80 lines of the current or last run
  probe: { at: number; running: boolean; ok: boolean | null; durationSec: number | null } | null;  // self-test
  probeNext: number | null;
  remoteLastOk: number | null;     // last successful off-site copy (/var/lib/keepwatch/backup/remote-last-ok)
}
```

The local target is always listed (`name: "Local"`); the remote one always too, with
`configured: false` and `location: ""` while no off-site repository is set. The problem
`backup.remote-stale` uses the newer of the remote's last snapshot and `remoteLastOk`. Its `name` is
`REMOTE_NAME`, else derived from the repository type ("S3", "Backblaze B2", "SFTP", "REST server",
"rclone", ...), else "Remote".

- `POST /api/backups/run` → `{ ok: true }` (starts `keepwatch-backup.service`; 409 if one is running)
- `POST /api/backups/probe` → `{ ok: true }` starts the self-test `keepwatch-backup-verify.service` now
  (test restore of the latest local snapshot + reading a sample of the off-site data; takes a few
  minutes, then read `probe` again).

Schedules are written like `lib/common.sh` `calendar` does: `OnCalendar=*-*-* 03:00:00 <KW_LOCAL_TZ>`.
Times read back from timer files are converted to `KW_LOCAL_TZ` (a line in another zone, or
without one = the system zone, is converted), so `schedule` / `rebootTime` are always local.

Backup configuration: `/etc/keepwatch/backup/env` (shell syntax, read by `keepwatch-backup`):
`RESTIC_PASSWORD_FILE` (default `/etc/keepwatch/backup/restic.pass`), `LOCAL_REPO` (default
`/var/backups/keepwatch/restic`), `KEEP_*`, `REMOTE_KEEP_*`, `REMOTE_REPO`, `REMOTE_NAME`,
`REMOTE_ENV_KEYS` (names of the credential variables for the remote, which the backup script
exports) plus those variables; `RCLONE_CONFIG=/etc/keepwatch/backup/rclone.conf` for `rclone:` repositories.

## Settings (everything you would otherwise change in configuration files)

Everything here ends up on the server under `/etc` or in the Proxy Manager database and is
therefore part of the backup: a new server gets it back with the restore. `./keepwatch deploy`
never overwrites these files – the values in `keepwatch.conf` are only initial values.

### GET /api/settings  (on opening, after every save)

Each section is `{ enabled: false }` while its module is off.

```ts
{
  backup: { enabled: true;
            schedule: string;              // "03:00" in KW_LOCAL_TZ
            keepDaily: number; keepWeekly: number; keepMonthly: number;                    // local (KEEP_*)
            remoteKeepDaily: number; remoteKeepWeekly: number; remoteKeepMonthly: number;  // off-site (REMOTE_KEEP_*)
            passwordSet: boolean };        // module backup
  remote: { configured: boolean;
            name: string;                  // display name (REMOTE_NAME or derived from the URL)
            repo: string | null;           // restic repository URL, credentials in the URL masked (//***@)
            env: string[];                 // NAMES of the stored credential variables - values are never returned
            rcloneConf: boolean;           // /etc/keepwatch/backup/rclone.conf exists
            check: { ok: boolean; at: number; message: string } | null };   // last test; module backup
  portainer: { enabled: true; tokenSet: boolean; connected: boolean; reason: string | null };  // module portainer
  fail2ban: { enabled: true;
              sshMaxretry: number;         // failed SSH logins from the internet before a ban (jail sshd;
                                           // KW_F2B_SSH_MAXRETRY, default 7)
              maxretry: number | null;     // failed SSH logins through Tailscale before a ban (jail sshd-tailscale;
                                           // default KW_F2B_SSH_MAXRETRY too; null without tailscale)
              findtimeHours: number; bantimeHours: number;
              recidiveMaxretry: number; recidiveFindtimeDays: number;   // repeat offenders: n bans in x days
              recidiveBantimeDays: number;                              // -> y days, all ports
              ignoreip: string[] };   // without 127.0.0.1/8, ::1 and the tailnet ranges. Every further ban
                                      // of the same IP doubles (bantime.increment). Module fail2ban
  updates: { enabled: true; autoReboot: boolean; rebootTime: string };  // "04:00" KW_LOCAL_TZ: security updates
                                      // run then; a needed reboot follows right after. Module auto-updates
  myIps: string[];       // IPs of the open SSH connections (= your connection)
  tailscale: TailscaleSettings | { enabled: false };   // section "Tailscale and SSH"
  ssh: { enabled: true; public: boolean; revertAt: number | null } | { enabled: false };  // firewall + tailscale
}
```

- `PUT /api/settings/backup` with `{ schedule, keepDaily, keepWeekly, keepMonthly, remoteKeepDaily?, remoteKeepWeekly?, remoteKeepMonthly? }` –
  a missing `remoteKeep*` keeps its current value. 400 when off-site keeps fewer than local at any level
  (otherwise `restic copy` copies again every night what was just pruned off-site). Writes
  `/etc/systemd/system/keepwatch-backup.timer.d/schedule.conf`.
- `POST /api/settings/backup/password` → `{ password: string }` – only on request (for the password
  manager), never automatically.
- `PUT /api/settings/remote` with

  ```ts
  { repo: string;                          // any restic repository: s3:https://host/bucket, b2:bucket:path,
                                           // sftp:user@host:/path, rest:https://host/, rclone:remote:path, azure:..., gs:...,
                                           // local:/path or /path
    name?: string;                         // display name, default from the type
    env?: { name: string; value?: string | null }[];   // credentials restic needs (AWS_ACCESS_KEY_ID, B2_ACCOUNT_KEY, ...)
    rcloneConf?: string }                  // contents of rclone.conf (write-only), for rclone: repositories
  ```

  `env` is the full list of credential variables: a missing/empty `value` keeps the stored value,
  names left out are removed. Names must be `[A-Z][A-Z0-9_]*` and not one of the backup's own keys.
  Checks access (`restic cat config`), creates the repository if it does not exist yet (with the
  chunker parameters of the local one, so `restic copy` deduplicates), saves and starts the first
  off-site backup → `{ ok: true, message: string }`. Errors (wrong credentials, unreachable host, …)
  as 4xx with `error`; nothing is saved then.
- `POST /api/settings/remote/test` → `{ ok: boolean, message: string }` (`restic snapshots`)
- `DELETE /api/settings/remote` → removes the off-site repository and its credentials from the
  configuration (the data in the repository stays).
- `PUT /api/settings/portainer` with `{ token: string }` → checks and saves → `{ ok: true }`
- `PUT /api/settings/fail2ban` with `{ sshMaxretry?, maxretry?, findtimeHours, bantimeHours, recidiveMaxretry, recidiveFindtimeDays, recidiveBantimeDays, ignoreip }`
  (`sshMaxretry`/`maxretry` 1–50, each optional – a missing one keeps the current value; `maxretry` only with the tailscale module) → writes `/etc/fail2ban/jail.d/zz-keepwatch-dashboard.local`,
  tests with `fail2ban-client -t`, reloads.
- `PUT /api/settings/updates` with `{ autoReboot, rebootTime }` → writes `52-auto-reboot`, the
  `apt-daily-upgrade.timer` override at `rebootTime` and the `apt-daily.timer` override (package
  lists) 30 minutes before, both in `KW_LOCAL_TZ`.

### Access lists of the sites  (needs module proxy)

```ts
// GET /api/access
{
  myIps: string[];
  hosts: {
    id: number; domains: string[];
    mode: "open" | "list";            // open = everyone gets in
    entries: { value: string;         // "203.0.113.7" or "198.51.100.0/24"
               note: string;          // free text, stored as a comment on the nginx line
               addresses: number;     // how many addresses the entry covers (1 for a single IP)
             }[];
    pathLock: { paths: string[]; entries: Entry[] };   // allow-list for single paths only
  }[];
}
```

`PUT /api/access/<id>` with `{ mode, entries: { value, note }[] }` → writes the database and the
nginx configuration, tests with `nginx -t`, reloads; on an error everything is rolled back →
`{ ok: true }`. Duplicates are merged. `mode: "list"` with an empty list is an error (it would lock
everyone out); `mode: "open"` removes all entries.

`PUT /api/access/<id>/paths` with `{ paths: string[], entries: { value, note }[] }` → only these paths
(e.g. `/admin`, at most 10) are limited to the list, the rest of the site stays open. Empty `paths`
switches the lock off (the list is kept for later). Same checks and rollback as above.

## Tailscale and SSH from the internet  (needs modules tailscale, firewall)

Goal: port 22 closed to the internet, administration only through Tailscale **and** an SSH key.
The web UIs (dashboard, Proxy Manager, Portainer, `KW_EXTRA_UIS`) listen on `127.0.0.1` only and
are reached through the SSH tunnel; `tailscale serve` should share nothing.

```ts
type TailscaleSettings = {
  enabled: true;
  installed: boolean;
  state: "NeedsLogin" | "Running" | "Stopped" | "Starting" | "NoState" | null;
  ip: string | null;              // 100.x.y.z
  dnsName: string | null;         // MagicDNS name of the server
  keyExpiry: number | null;       // Unix; null = does not expire ("Disable key expiry" in the admin console)
  loginUrl: string | null;        // while a login is pending
  urls: { port: number; name: string; url: string }[];   // what `tailscale serve` still shares - should be [] (else a warning)
  viaTailscale: boolean;          // Host is localhost AND an SSH connection from the tailnet is open
};
```

- `POST /api/settings/tailscale/login` → runs `tailscale up --hostname=<KW_HOSTNAME>` →
  `{ loginUrl: string | null }` (open in a new tab; then GET /api/settings every 3 s until `state` is
  "Running"). Needs module tailscale.
- `PUT /api/settings/ssh` with `{ public: boolean }` → sets `SSH_PUBLIC=yes|no` in
  `/etc/keepwatch/firewall.env` and restarts `keepwatch-firewall`. All other lines of the file stay.
  Closing adds `SSH_PUBLIC_SINCE=<unix time>` (kept if it was closed already) and drops the markers it
  settles (`# KEEPWATCH_PENDING_CLOSE=1` from a deploy waiting for Tailscale, `# SSH_FALLBACK_OPENED=…`);
  opening drops `SSH_PUBLIC_SINCE`.
  - `false` only works when `tailscale.state` is "Running" **and** `viaTailscale` is true (else 409 with
    an explanation). Then a 10-minute deadline runs: without confirmation the server opens port 22
    again by itself (transient unit `keepwatch-ssh-revert`).
  - `true` opens it again at once.
- `POST /api/settings/ssh/confirm` → ends the deadline, port 22 stays closed → `{ ok: true }`

If Tailscale stops working while port 22 is closed, `keepwatch-ssh-fallback` opens it again and
leaves `# SSH_FALLBACK_OPENED=<unix time> <reason>` in `firewall.env` (problem `ssh.fallback-opened`).

## Passkey for dangerous actions  (`server/touchid.py`, UI: Settings → Passkey, `web/src/touchid.ts`)

A stolen or taken-over device with tunnel access should not be enough. Once a device is registered, the backend
requires a fresh WebAuthn assertion (ES256, "user verified") for every action in `DANGER` (the one list, at the top of
`touchid.py`). **No password fallback.** As long as no device is registered, everything works without it.
`KW_DASHBOARD_PASSKEY="no"` turns the whole mechanism off (no gate, registration endpoints answer 404).

Dangerous (as of this file - `DANGER` is authoritative): open port 22 · log in to Tailscale again · loosen fail2ban
settings (more attempts, shorter windows/bans, new "never ban" entries) · lift a ban (fail2ban and ban history) · change
IP allowlist / path allowlist · create proxy host · redeploy stack · change **and view** environment variables
(`GET /api/stacks/<id>/env`, plain text) · stop container · update/roll back an image · clean up · change/remove
credentials of Proxy Manager, Portainer, off-site backup target · show backup password · shorten backup retention ·
shorten log archive · add/remove passkey devices, create a pairing code (`register/start` with a `pairCode` is not). A condition that raises counts as dangerous. Entries that belong to a
disabled module are skipped (those endpoints answer 404 anyway), and `protects` lists only enabled ones.

Without passkey: starting checks/scans, back up now, verify run, acknowledging, renewing certificates,
starting/restarting containers, closing port 22 (and confirming it), longer retention, stricter fail2ban.

### Flow of a dangerous request

1. Request as usual → `428 { error, touchid: { challenge, rpId, allow: string[], action, timeout } }`.
   `challenge`: 32 random bytes (base64url), valid for **2 minutes**, **single use**, bound to method, path and
   body (GET/DELETE: query). `allow`: ids of the devices for this address (`rpId` = host without port).
   `action`: the English label from `DANGER`, e.g. "Open port 22".
2. The client signs (`navigator.credentials.get` with `userVerification: "required"`, or the macOS app bridge) and
   sends **the same** request with header `X-Touch-ID: {"id","clientDataJSON","authenticatorData","signature"}`
   (JSON, values base64url).
3. The backend checks: `type = webauthn.get`, challenge matches this request, origin `https://<rpId>[:port]`
   (or `http://localhost`), `rpIdHash`, flags UP **and** UV, ECDSA signature over
   `authenticatorData ‖ SHA-256(clientDataJSON)`, counter (if ≠ 0) increases. Then the endpoint runs.
   Expired/unknown → `428` again with a new challenge; anything else → `403`.
   No device for this address (RP ID = host without port) → `403` with a hint where the device works. Through the
   tunnel the RP ID is `localhost` (WebAuthn allows `http` there), regardless of the local port.

`428` responses are not written to the timeline (intermediate step). `request` in `web/src/api.ts` does all of this by
itself - every call through `api.get/post/put/del` gets the passkey step without extra code.

### Endpoints

- `GET /api/touchid` → `{ enabled, active, crypto, rpId, rpUsable, here, devices: { id, name, kind: "passkey"|"app", rpId, created, lastUsed, here }[], pairing: { expires } | null, protects: string[], ttl }`
  (`enabled: false` = `KW_DASHBOARD_PASSKEY="no"`; then `active: false`, `devices: []`, `pairing: null`, `protects: []`.
  `pairing`: a pairing code is pending until `expires` - the code itself is only in the answer of `POST /api/touchid/pair`)
- `POST /api/touchid/register/start` `{ name, pairCode? }` → `{ challenge, rp: { id, name: "Keepwatch" }, user: { id, name, displayName }, exclude: string[], timeout }`.
  - No device yet: no confirmation (whoever registers first turns passkeys on). If another device gets registered
    before `finish`, that `finish` fails with 409.
  - Devices exist, without `pairCode`: dangerous ("Add another passkey device") - `428`, confirm with a registered
    device **for this address** (another key on a device that can already confirm here).
  - Devices exist, with `pairCode` (6 digits, spaces allowed): no `428`; the code is checked and used up at once (a
    cancelled setup needs a new code). No pending code, expired, created before a `keepwatch-passkey reset` → `403`;
    wrong → `403`, after 5 wrong attempts the code is dropped.
- `POST /api/touchid/register/finish`
  - browser: `{ kind: "passkey", id, name, clientDataJSON, attestationObject }` (`attestation: "none"`, ES256)
  - macOS app: `{ kind: "app", id, name, publicKey (SPKI DER, base64url), clientDataJSON, authenticatorData, signature }`
  - → `{ ok, device }`. Checks `type = webauthn.create`, challenge, origin, RP ID, UP+UV, for `app` the signature.
- `POST /api/touchid/pair` (passkey) → `{ code: "123456", expires }`. Pairing code for a device without a key (the macOS
  app, another browser or computer, another address): 6 random digits, valid for **5 minutes**, **single use**,
  **5 wrong attempts** and it is dropped. Only one code at a time - a new one replaces the pending one. Kept in memory
  only (a dashboard restart drops it). No device registered yet → `409` (the first one needs no code).
- `DELETE /api/touchid/devices/<id>` (passkey) → `{ ok, active }`. Any device can be removed except the **last** one
  (`409`): otherwise passkeys would be off and anyone with tunnel access could register first. To switch devices,
  add the new one first, then remove the old one. All devices lost: `keepwatch-passkey reset` on the server.

Stored: `/etc/keepwatch/dashboard/passkeys.json` (600, part of the backup) - public keys, names, counters, times only.
Verified with `python3-cryptography` (Ubuntu package); if it is missing while devices exist → `503` (closed, not open).
Emergency: `keepwatch-passkey reset` on the server (`keepwatch-passkey list` shows the devices).

### macOS app bridge (`window.webkit.messageHandlers.keepwatchTouchID`, older apps: `serverTouchID`)

`WKScriptMessageHandlerWithReply`; `postMessage(msg)` returns a promise. Errors as `{ error: "cancelled" | "unknown" | "unavailable" | <text> }`.
Answers only the main frame of the dashboard in the app's own tunnel (`http://localhost:<local port for the dashboard>`),
`rpId` must be `localhost`. A key only works for the RP ID it was created for.

- `{ op: "register", challenge, rpId, name, reason }` → create a new Secure Enclave key (P-256, access
  `.privateKeyUsage + .biometryCurrentSet`), `clientDataJSON = {"type":"webauthn.create","challenge":…,"origin":<origin of the frame>}`,
  `authenticatorData = SHA-256(rpId) ‖ 0x05 ‖ 00 00 00 00` (37 bytes), sign with Touch ID →
  `{ id, publicKey, clientDataJSON, authenticatorData, signature }` (all base64url, signature DER).
- `{ op: "sign", challenge, rpId, allow, reason }` → own key not in `allow` → `{ error: "unknown" }`; otherwise as above with
  `"type":"webauthn.get"` → `{ id, clientDataJSON, authenticatorData, signature }`.
