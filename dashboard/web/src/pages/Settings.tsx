import { Archive, ArrowUpCircle, Blocks, Clock, Eye, EyeOff, Fingerprint, Globe, KeyRound, Layers, LogOut, PackageCheck, Plus, RefreshCw, ShieldBan, ShieldCheck, Trash2, UploadCloud, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, refreshAll, usePoll } from "../api";
import { Chips, Loading, PageHero, Stale } from "../common";
import { has, useConfig } from "../config";
import { Reveal } from "../design/fx";
import { Button, Callout, Confirm, CopyButton, cx, Field, IconButton, KeyValue, Panel, Pill, Toggle } from "../design/ui";
import { ago, agoShort, minutesOf, timeZone } from "../format";
import { covers, isValidEntry, normalize } from "../ip";
import { ArchiveBody, archiveState, ArchiveSummary } from "../logarchive/ArchiveCard";
import { useArchiveOverview } from "../logarchive/api";
import { useAction, useToast } from "../messages";
import { useNav } from "../nav";
import type { RemoteRepo, RemoteRepoInput, Settings } from "../types";
import { NPM_CARD_ID } from "./NewSite";
import { NpmBody, useNpmStatus } from "./NpmAccess";
import { DBody, DFoot, SaveFoot, SettingDialog, SettingRow } from "./settingsUi";
import { onOpenSetting, pendingSetting, settingsIndex, settingTitle, type SettingKey } from "./settingsOpen";
import { SelfUpdateBody, selfUpdateRowState, selfUpdateRowValue } from "./SelfUpdate";
import { ModulesBody, modulesRowState, modulesRowValue } from "./Modules";
import { useModules } from "../modules";
import { useSelfUpdate } from "../selfupdate";
import { RemoteAccessBody, SshCountdown, sshAvailable, tailscaleState } from "./Tailscale";
import { TouchIdBody, touchRowState, touchRowValue, useTouchStatus } from "./TouchId";

/** Only fetched on open and after every save (API.md); the interval is just a fallback. */
const SETTINGS_EVERY = 60 * 60_000;

const TIME_OK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A settings section the server reports as `{enabled: false}` (module off) counts as missing. */
const on = <T,>(x: T | null | undefined): x is T => !!x && (x as { enabled?: boolean }).enabled !== false;

/** Schedules run in the user's timezone (KW_LOCAL_TZ) – always 24 h, whatever the browser language. */
function TimeField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  const bad = !TIME_OK.test(value);
  return (
    <Field label={label} htmlFor={id} aside={timeZone()} error={bad ? "Time as HH:MM, e.g. 03:00" : undefined}>
      <input
        id={id}
        className={cx("o-input d-time d-mono", bad && "is-bad")}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^\d:]/g, "").slice(0, 5))}
        onBlur={() => {
          const m = /^(\d{1,2}):?(\d{2})$/.exec(value);
          if (m && Number(m[1]) < 24) onChange(`${m[1].padStart(2, "0")}:${m[2]}`);
        }}
        inputMode="numeric"
        placeholder="03:00"
        autoComplete="off"
      />
    </Field>
  );
}

function NumField({ id, label, value, onChange, min = 0, max = 9999, unit }: { id: string; label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; unit?: string }) {
  const bad = !Number.isInteger(value) || value < min || value > max;
  return (
    <Field label={label} htmlFor={id} aside={unit} error={bad ? `Whole number from ${min} to ${max}` : undefined}>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        className={cx("o-input d-num", bad && "is-bad")}
        value={Number.isFinite(value) ? value : ""}
        min={min}
        max={max}
        step={1}
        onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))}
      />
    </Field>
  );
}

const intOk = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max;

/** 24 -> "24 hr", 168 -> "7 days" */
function dur(h: number): string {
  if (!Number.isFinite(h)) return "?";
  if (h % 24 === 0 && h >= 48) return `${h / 24} days`;
  return `${h} hr`;
}
/** Short form for the row: 168 -> "7 d", 24 -> "24 hr" */
function durShort(h: number): string {
  if (!Number.isFinite(h)) return "?";
  if (h % 24 === 0 && h >= 48) return `${h / 24} d`;
  return `${h} hr`;
}

/**
 * If the backup runs after the updates (within 12 hr after them), there is no fresh snapshot
 * before an update. Only then a warning, otherwise nothing.
 */
function orderWarning(backup: string, updates: string): string | null {
  const b = minutesOf(backup);
  const u = minutesOf(updates);
  if (!Number.isFinite(b) || !Number.isFinite(u)) return null;
  const before = (u - b + 1440) % 1440; // minutes from the backup to the updates
  return before === 0 || before > 12 * 60 ? `The backup (${backup}) runs after the updates (${updates}).` : null;
}

/* ---------- Off-site backup ------------------------------------------------------------------- */

/** What the server reports about the off-site repository (names only for credentials, never values). */
type Remote = RemoteRepo;

const REPO_OK = /^(?:(?:s3|b2|sftp|rest|rclone|azure|gs|swift):\S+|\/\S+)$/;
const ENV_OK = /^[A-Z][A-Z0-9_]{1,63}$/;
const RESERVED = new Set(["RESTIC_PASSWORD_FILE", "RESTIC_REPOSITORY", "RESTIC_CACHE_DIR", "PATH", "HOME", "LD_PRELOAD"]);

/** Credential variables restic expects per backend (restic docs). */
const TYPICAL: Record<string, { label: string; env: string[] }> = {
  s3: { label: "S3", env: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] },
  b2: { label: "Backblaze B2", env: ["B2_ACCOUNT_ID", "B2_ACCOUNT_KEY"] },
  azure: { label: "Azure", env: ["AZURE_ACCOUNT_NAME", "AZURE_ACCOUNT_KEY"] },
  gs: { label: "Google Cloud Storage", env: ["GOOGLE_PROJECT_ID", "GOOGLE_APPLICATION_CREDENTIALS"] },
  swift: { label: "Swift", env: ["OS_AUTH_URL", "OS_USERNAME", "OS_PASSWORD"] },
  rest: { label: "REST server", env: ["RESTIC_REST_USERNAME", "RESTIC_REST_PASSWORD"] },
};
const scheme = (repo: string) => /^([a-z0-9]+):/.exec(repo.trim())?.[1] ?? "";
/** Name the backend shows when REMOTE_NAME is empty (REPO_LABEL in server/dashboard.py). */
const REPO_LABEL: Record<string, string> = { s3: "S3", b2: "Backblaze B2", sftp: "SFTP", rest: "REST server", rclone: "rclone", azure: "Azure", gs: "Google Cloud Storage", swift: "Swift" };
const derivedName = (repo: string) => REPO_LABEL[scheme(repo)] ?? "Remote";

interface EnvRow {
  id: number;
  name: string;
  value: string;
  /** The server already has a value for this name (write-only: empty = keep it). */
  stored: boolean;
}

let rowSeq = 1;

function RemoteBody({ r, reload, close }: { r: Remote; reload: () => void; close: () => void }) {
  const { busy, run } = useAction();
  const toast = useToast();
  const [change, setChange] = useState(false);
  const [askRemove, setAskRemove] = useState(false);
  const editing = !r.configured || change;

  const test = () =>
    void run("test", async () => {
      const res = await api.post<{ ok: boolean; message: string }>("/api/settings/remote/test");
      if (res.ok) toast(res.message || "Connected.");
      else toast(res.message || "No connection.", "error", "Repository not reachable");
    }).then(() => reload());

  if (editing)
    return (
      <RemoteForm
        r={r}
        onCancel={() => (change ? setChange(false) : close())}
        onSaved={() => {
          setChange(false);
          reload();
          refreshAll();
          close();
        }}
      />
    );

  return (
    <>
      <DBody>
        <KeyValue
          items={[
            ...(r.name ? ([["Name", r.name]] as [string, string][]) : []),
            ["Repository", <span className="d-mono break-all">{r.repo ?? "—"}</span>],
            [
              "Credentials",
              r.env?.length ? (
                <span className="d-chips justify-end">
                  {r.env.map((n) => (
                    <span key={n} className="d-chip-x d-mono">
                      {n}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="o-mute">none</span>
              ),
            ],
            [
              "Last test",
              r.check ? (
                <span className="inline-flex flex-wrap items-center justify-end gap-2">
                  <Pill tone={r.check.ok ? "ok" : "rose"}>{r.check.ok ? "ok" : "failed"}</Pill>
                  {ago(r.check.at)}
                </span>
              ) : (
                "none yet"
              ),
            ],
          ]}
        />
        {r.check && !r.check.ok && (
          <Callout tone="rose" className="mt-3" title="The last test failed">
            {r.check.message} Check the credentials with "Edit".
          </Callout>
        )}
      </DBody>
      <DFoot>
        <Button variant="ghost" className="mr-auto" onClick={() => setAskRemove(true)} disabled={!!busy}>
          <LogOut className="h-4 w-4" /> Remove
        </Button>
        <Button variant="secondary" onClick={() => setChange(true)} disabled={!!busy}>
          Edit
        </Button>
        <Button variant="primary" onClick={test} disabled={!!busy}>
          <RefreshCw className={cx("h-4 w-4", busy === "test" && "o-spin")} /> Test connection
        </Button>
      </DFoot>
      {askRemove && (
        <Confirm
          icon={LogOut}
          copy={{
            title: "Remove the off-site repository?",
            description: "Backups then only go to the server's own disk, next to the data.",
            note: "The data in the repository stays and can still be restored with the backup password. To delete it, do that at your storage provider.",
            confirmLabel: "Remove",
            tone: "danger",
          }}
          onClose={() => setAskRemove(false)}
          onConfirm={() =>
            void run("remove", () => api.del("/api/settings/remote"), "Off-site repository removed. Backups are local only now.").then((ok) => {
              if (ok) {
                reload();
                refreshAll();
                close();
              }
            })
          }
        />
      )}
    </>
  );
}

function RemoteForm({ r, onCancel, onSaved }: { r: Remote; onCancel: () => void; onSaved: () => void }) {
  const { busy, run } = useAction();
  const toast = useToast();
  const [repo, setRepo] = useState(r.repo && !r.repo.includes("***@") ? r.repo : "");
  // The server derives a name from the type ("S3") when none was set – don't carry that over as a custom name.
  const [name, setName] = useState(r.configured && r.name && r.name !== derivedName(r.repo ?? "") ? r.name : "");
  const [rows, setRows] = useState<EnvRow[]>(() => (r.env ?? []).map((n) => ({ id: rowSeq++, name: n, value: "", stored: true })));
  const [rclone, setRclone] = useState("");

  const kind = scheme(repo);
  const typical = TYPICAL[kind];
  const missingTypical = typical ? typical.env.filter((n) => !rows.some((x) => x.name === n)) : [];
  const names = rows.map((x) => x.name.trim());
  const rowError = (x: EnvRow): string | null => {
    const n = x.name.trim();
    if (!n) return "Name missing";
    if (!ENV_OK.test(n)) return "Use A–Z, 0–9 and _";
    if (RESERVED.has(n)) return "Reserved name";
    if (names.filter((y) => y === n).length > 1) return "Listed twice";
    if (!x.stored && !x.value) return "Value missing";
    return null;
  };
  const repoOk = REPO_OK.test(repo.trim());
  // A repository URL with user:password@ shows masked – it has to be typed again to change anything.
  const masked = !!r.repo && r.repo.includes("***@") && !repo;
  const valid = repoOk && rows.every((x) => !rowError(x));
  const set = (id: number, patch: Partial<EnvRow>) => setRows((cur) => cur.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const add = (n = "") => setRows((cur) => [...cur, { id: rowSeq++, name: n, value: "", stored: false }]);

  const save = () =>
    void run("save", async () => {
      const body: RemoteRepoInput = {
        repo: repo.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        env: rows.map((x) => ({ name: x.name.trim(), value: x.value ? x.value : null })),
        ...(kind === "rclone" && rclone.trim() ? { rcloneConf: rclone } : {}),
      };
      const res = await api.put<{ ok: true; message?: string }>("/api/settings/remote", body);
      toast(res.message || "Connected. The first off-site backup is running.");
    }).then((ok) => ok && onSaved());

  return (
    <>
      <DBody>
        <form
          className="o-form !gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !busy) save();
          }}
        >
          <Field
            label="Repository"
            htmlFor="s-rm-repo"
            hint={masked ? "Contains credentials, so it's shown masked – enter it again to save." : "Any restic repository: s3:, b2:, sftp:, rest:, rclone:, azure:, gs: or swift:."}
            error={repo.trim() && !repoOk ? "That doesn't look like a restic repository URL." : undefined}
          >
            <input
              id="s-rm-repo"
              className={cx("o-input d-mono", repo.trim() && !repoOk && "is-bad")}
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder={masked ? r.repo ?? "" : "s3:https://s3.amazonaws.com/my-bucket/keep"}
              autoComplete="off"
              spellCheck={false}
              data-autofocus
            />
          </Field>
          <Field label="Name" htmlFor="s-rm-name" aside="optional" hint="Shown on the Backups page instead of the storage type.">
            <input id="s-rm-name" className="o-input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder={typical?.label ?? "e.g. Backblaze"} autoComplete="off" />
          </Field>

          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[13.5px] font-medium text-[var(--o-text)]">Credentials</span>
              <span className="o-hint">Environment variables for restic · write-only</span>
            </div>
            {rows.length > 0 && (
              <div className="d-env-rows">
                {rows.map((x) => {
                  const err = rowError(x);
                  return (
                    <div key={x.id} className="d-env-row">
                      <input
                        className={cx("o-input d-mono", err && x.name && "is-bad")}
                        value={x.name}
                        onChange={(e) => set(x.id, { name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"), stored: x.stored && e.target.value.toUpperCase() === x.name })}
                        placeholder="NAME"
                        aria-label="Variable name"
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <input
                        type="password"
                        className={cx("o-input d-mono", err === "Value missing" && "is-bad")}
                        value={x.value}
                        onChange={(e) => set(x.id, { value: e.target.value })}
                        placeholder={x.stored ? "•••••• stored" : "value"}
                        aria-label={`Value of ${x.name || "the variable"}`}
                        autoComplete="new-password"
                        spellCheck={false}
                      />
                      <IconButton label={`Remove ${x.name || "variable"}`} size="sm" onClick={() => setRows((cur) => cur.filter((y) => y.id !== x.id))}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </IconButton>
                      {err && (x.name || x.value) && <span className="d-env-err">{err}</span>}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => add()}>
                <Plus className="h-3.5 w-3.5" /> Add variable
              </Button>
              {missingTypical.length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => missingTypical.forEach((n) => add(n))} title={missingTypical.join(", ")}>
                  <Plus className="h-3.5 w-3.5" /> Add {typical!.label} keys
                </Button>
              )}
            </div>
            <p className="o-hint">Stored values are never shown again. Leave a value empty to keep the stored one.</p>
          </div>

          {kind === "rclone" && (
            <Field label="rclone.conf" htmlFor="s-rm-rclone" aside="optional" hint={r.rcloneConf ? "A config is stored – leave empty to keep it." : "The [remote] section rclone needs for this repository."}>
              <textarea
                id="s-rm-rclone"
                className="o-input d-mono min-h-[96px]"
                value={rclone}
                onChange={(e) => setRclone(e.target.value)}
                placeholder={r.rcloneConf ? "•••••• stored" : "[remote]\ntype = …"}
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
          )}
          <p className="o-hint -mt-1">restic encrypts everything with the backup password before it leaves the server. Saving checks access, creates the repository if needed and starts the first off-site backup.</p>
          <button type="submit" hidden />
        </form>
      </DBody>
      <DFoot>
        <Button variant="ghost" onClick={onCancel} disabled={!!busy}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!valid || !!busy} onClick={save}>
          {busy === "save" ? <RefreshCw className="h-4 w-4 o-spin" /> : <UploadCloud className="h-4 w-4" />}
          {busy === "save" ? "Connecting …" : "Save & connect"}
        </Button>
      </DFoot>
    </>
  );
}

/* ---------- Backup password -------------------------------------------------------------------- */

function PasswordBody({ set, close }: { set: boolean; close: () => void }) {
  const { busy, run } = useAction();
  const [pw, setPw] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  return (
    <>
      <DBody>
        {!set ? (
          <p className="o-hint">Created with the first backup.</p>
        ) : pw !== null ? (
          <div className="d-secret">
            <span className={cx(!shown && "is-masked")}>{shown ? pw : "••••••••••••••••"}</span>
            <IconButton label={shown ? "Hide" : "Show"} size="sm" onClick={() => setShown((v) => !v)}>
              {shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </IconButton>
            <CopyButton text={pw} label="Copy password" />
          </div>
        ) : (
          <Button
            variant="secondary"
            disabled={!!busy}
            onClick={() =>
              void run("pw", async () => {
                const r = await api.post<{ password: string }>("/api/settings/backup/password");
                setPw(r.password);
                setShown(false);
              })
            }
          >
            <Eye className="h-4 w-4" /> {busy ? "Fetching …" : "Reveal password"}
          </Button>
        )}
        {set && <p className="o-hint mt-4">Keep it in your password manager. Without it, no backup – local or off-site – can be restored.</p>}
      </DBody>
      <DFoot>
        <Button variant="ghost" onClick={close}>
          Close
        </Button>
      </DFoot>
    </>
  );
}

/* ---------- Schedule & retention ----------------------------------------------------------------- */

function ScheduleBody({ b, updatesAt, reload, close }: { b: Settings["backup"]; updatesAt: string | null; reload: () => void; close: () => void }) {
  const { busy, run } = useAction();
  const [f, setF] = useState({
    schedule: b.schedule, keepDaily: b.keepDaily, keepWeekly: b.keepWeekly, keepMonthly: b.keepMonthly,
    remoteKeepDaily: b.remoteKeepDaily, remoteKeepWeekly: b.remoteKeepWeekly, remoteKeepMonthly: b.remoteKeepMonthly,
  });
  const dirty = (Object.keys(f) as (keyof typeof f)[]).some((k) => f[k] !== b[k]);
  // Off-site keeps at least as much as local per tier, otherwise every backup copies what was just pruned.
  const shorter = f.remoteKeepDaily < f.keepDaily || f.remoteKeepWeekly < f.keepWeekly || f.remoteKeepMonthly < f.keepMonthly;
  const valid =
    TIME_OK.test(f.schedule) && intOk(f.keepDaily, 1, 365) && intOk(f.keepWeekly, 0, 260) && intOk(f.keepMonthly, 0, 120) &&
    intOk(f.remoteKeepDaily, 1, 365) && intOk(f.remoteKeepWeekly, 0, 260) && intOk(f.remoteKeepMonthly, 0, 120) && !shorter;
  const warn = updatesAt ? orderWarning(f.schedule, updatesAt) : null;
  return (
    <>
      <DBody>
        <div className="flex flex-col gap-5">
          <TimeField id="s-schedule" label="Daily backup at" value={f.schedule} onChange={(schedule) => setF({ ...f, schedule })} />
          <div className="d-fields is-3">
            <NumField id="s-kd" label="Local: days" value={f.keepDaily} min={1} max={365} onChange={(keepDaily) => setF({ ...f, keepDaily })} />
            <NumField id="s-kw" label="Weeks" value={f.keepWeekly} max={260} onChange={(keepWeekly) => setF({ ...f, keepWeekly })} />
            <NumField id="s-km" label="Months" value={f.keepMonthly} max={120} onChange={(keepMonthly) => setF({ ...f, keepMonthly })} />
          </div>
          <div className="d-fields is-3">
            <NumField id="s-rkd" label="Off-site: days" value={f.remoteKeepDaily} min={1} max={365} onChange={(remoteKeepDaily) => setF({ ...f, remoteKeepDaily })} />
            <NumField id="s-rkw" label="Weeks" value={f.remoteKeepWeekly} max={260} onChange={(remoteKeepWeekly) => setF({ ...f, remoteKeepWeekly })} />
            <NumField id="s-rkm" label="Months" value={f.remoteKeepMonthly} max={120} onChange={(remoteKeepMonthly) => setF({ ...f, remoteKeepMonthly })} />
          </div>
          <p className="o-hint -mt-2" style={shorter ? { color: "var(--o-rose)" } : undefined}>
            {shorter ? "Off-site has to keep at least as much as local, tier by tier." : "One snapshot per day, then per week, then per month."}
          </p>
          {warn && <Callout tone="sand">{warn}</Callout>}
        </div>
      </DBody>
      <SaveFoot dirty={dirty} valid={valid} busy={!!busy} onCancel={close} onSave={() => void run("save", () => api.put("/api/settings/backup", f), "Schedule saved.").then((ok) => ok && (reload(), close()))} />
    </>
  );
}

/* ---------- Portainer ------------------------------------------------------------------------------ */

function PortainerBody({ p, reload, close }: { p: Settings["portainer"]; reload: () => void; close: () => void }) {
  const { busy, run } = useAction();
  const [token, setToken] = useState("");
  return (
    <>
      <DBody>
        <div className="flex flex-col gap-4">
          {!p.connected && p.reason && (
            <Callout tone="sand" title={p.tokenSet ? "The token doesn't work" : "No token yet"}>
              {p.reason}
            </Callout>
          )}
          <Field label={p.tokenSet ? "New token" : "Token"} htmlFor="s-ptoken" hint="Portainer → My account → Access tokens.">
            <input id="s-ptoken" type="password" className="o-input d-mono" value={token} onChange={(e) => setToken(e.target.value)} placeholder={p.tokenSet ? "••••••••  (stored)" : "ptr_…"} autoComplete="off" spellCheck={false} data-autofocus />
          </Field>
        </div>
      </DBody>
      <DFoot>
        <Button variant="ghost" onClick={close} disabled={!!busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!token.trim() || !!busy}
          onClick={() =>
            void run("token", () => api.put("/api/settings/portainer", { token: token.trim() }), "Portainer connected.").then((ok) => {
              if (ok) {
                reload();
                refreshAll();
                close();
              }
            })
          }
        >
          {busy && <RefreshCw className="h-4 w-4 o-spin" />}
          {busy ? "Checking …" : "Save & check"}
        </Button>
      </DFoot>
    </>
  );
}

/* ---------- fail2ban ------------------------------------------------------------------------------ */

function Fail2banBody({ f2b, myIps, reload, close }: { f2b: Settings["fail2ban"]; myIps: string[]; reload: () => void; close: () => void }) {
  const { busy, run } = useAction();
  const [f, setF] = useState({ ...f2b, ignoreip: f2b.ignoreip ?? [] });
  // No ban longer than KW_F2B_MAX_BANTIME (older servers don't send it: their old limits).
  const maxBan = f2b.maxBantimeDays ?? 3650;
  // sshMaxretry: from the internet (jail sshd). maxretry: through Tailscale – null without the tailscale module.
  const tailnet = f.maxretry !== null;
  const internet = typeof f.sshMaxretry === "number";
  const [ip, setIp] = useState("");
  const [bad, setBad] = useState<string | null>(null);
  const dirty = JSON.stringify(f) !== JSON.stringify({ ...f2b, ignoreip: f2b.ignoreip ?? [] });
  const valid =
    (!tailnet || intOk(f.maxretry ?? NaN, 1, 50)) && (!internet || intOk(f.sshMaxretry ?? NaN, 1, 50)) && intOk(f.findtimeHours, 1, 720) && intOk(f.bantimeHours, 1, maxBan * 24) &&
    intOk(f.recidiveMaxretry, 1, 50) && intOk(f.recidiveFindtimeDays, 1, 365) && intOk(f.recidiveBantimeDays, 1, maxBan);
  const n = (v: number) => (Number.isFinite(v) ? v : "?");
  const add = (raw: string) => {
    const v = normalize(raw);
    if (!isValidEntry(raw)) return setBad("Not a valid IP address or range.");
    if (f.ignoreip.some((x) => normalize(x) === v)) return setBad(`${v} is already listed.`);
    setF((cur) => ({ ...cur, ignoreip: [...cur.ignoreip, v] }));
    setIp("");
    setBad(null);
  };
  const missingMine = myIps.filter((m) => !f.ignoreip.some((x) => covers(x, m)));
  return (
    <>
      <DBody>
        <div className="flex flex-col gap-5">
          <div className="d-fields is-2">
            {internet && (
              <NumField id="s-f-sretry" label="Failed SSH logins before a ban (internet)" value={f.sshMaxretry ?? NaN} min={1} max={50} onChange={(sshMaxretry) => setF({ ...f, sshMaxretry })} />
            )}
            {tailnet && <NumField id="s-f-retry" label="Failed SSH logins before a ban (Tailscale)" value={f.maxretry ?? NaN} min={1} max={50} onChange={(maxretry) => setF({ ...f, maxretry })} />}
          </div>
          <div className="d-fields is-2">
            <NumField id="s-f-find" label="Time window" unit="hours" value={f.findtimeHours} min={1} max={720} onChange={(findtimeHours) => setF({ ...f, findtimeHours })} />
            <NumField id="s-f-ban" label="First ban" unit="hours" value={f.bantimeHours} min={1} max={maxBan * 24} onChange={(bantimeHours) => setF({ ...f, bantimeHours })} />
          </div>
          <p className="o-hint -mt-2">
            {[internet && `${n(f.sshMaxretry ?? NaN)}× from the internet`, tailnet && `${n(f.maxretry ?? NaN)}× through Tailscale`].filter(Boolean).join(", ") || "Failed logins"} in {dur(f.findtimeHours)} →{" "}
            {dur(f.bantimeHours)}, then doubled each time (up to {maxBan >= 364 ? "1 year" : `${maxBan} days`})
          </p>
          <div className="d-fields is-3">
            <NumField id="s-f-rretry" label="Repeat offenders" unit="bans" value={f.recidiveMaxretry} min={1} max={50} onChange={(recidiveMaxretry) => setF({ ...f, recidiveMaxretry })} />
            <NumField id="s-f-rfind" label="within" unit="days" value={f.recidiveFindtimeDays} min={1} max={365} onChange={(recidiveFindtimeDays) => setF({ ...f, recidiveFindtimeDays })} />
            <NumField id="s-f-rec" label="then banned for" unit="days" value={f.recidiveBantimeDays} min={1} max={maxBan} onChange={(recidiveBantimeDays) => setF({ ...f, recidiveBantimeDays })} />
          </div>
          <p className="o-hint -mt-2">
            {n(f.recidiveMaxretry)} {f.recidiveMaxretry === 1 ? "ban" : "bans"} in {n(f.recidiveFindtimeDays)} days → {n(f.recidiveBantimeDays)} days on all ports
          </p>
          <Field label="Never ban" aside="in addition to localhost" error={bad ?? undefined}>
            <div className="flex flex-col gap-3">
              {f.ignoreip.length > 0 && (
                <div className="d-chips">
                  {f.ignoreip.map((x) => (
                    <span key={x} className="d-chip-x">
                      {x}
                      <button type="button" aria-label={`Remove ${x}`} onClick={() => setF({ ...f, ignoreip: f.ignoreip.filter((y) => y !== x) })}>
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <form
                className="flex flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (ip.trim()) add(ip);
                }}
              >
                <input
                  className={cx("o-input d-mono !w-auto min-w-[180px] flex-1", bad && "is-bad")}
                  value={ip}
                  onChange={(e) => {
                    setIp(e.target.value);
                    setBad(null);
                  }}
                  placeholder="IP or range"
                  aria-label="IP or range that is never banned"
                  spellCheck={false}
                  autoComplete="off"
                />
                <Button type="submit" variant="secondary" disabled={!ip.trim()}>
                  <Plus className="h-4 w-4" /> Add
                </Button>
                {myIps.length > 0 && (
                  <Button
                    variant="ghost"
                    disabled={missingMine.length === 0}
                    onClick={() => missingMine.forEach(add)}
                    title={missingMine.length ? `${missingMine.join(", ")} – home IPs change, and then the exception covers someone else.` : "Already listed"}
                  >
                    <UserRound className="h-4 w-4" /> My IP
                  </Button>
                )}
              </form>
            </div>
          </Field>
        </div>
      </DBody>
      <SaveFoot dirty={dirty} valid={valid} busy={!!busy} onCancel={close} onSave={() => void run("save", () => api.put("/api/settings/fail2ban", f), "fail2ban saved and reloaded.").then((ok) => ok && (reload(), close()))} />
    </>
  );
}

/* ---------- Automatic updates ---------------------------------------------------------------------- */

function UpdatesBody({ u, backupAt, reload, close }: { u: Settings["updates"]; backupAt: string | null; reload: () => void; close: () => void }) {
  const { busy, run } = useAction();
  const [f, setF] = useState({ autoReboot: u.autoReboot, rebootTime: u.rebootTime });
  const dirty = f.autoReboot !== u.autoReboot || f.rebootTime !== u.rebootTime;
  const valid = TIME_OK.test(f.rebootTime);
  const warn = backupAt ? orderWarning(backupAt, f.rebootTime) : null;
  return (
    <>
      <DBody>
        <div className="flex flex-col gap-5">
          <TimeField id="s-reboot" label="Install updates at" value={f.rebootTime} onChange={(rebootTime) => setF({ ...f, rebootTime })} />
          <div className="o-switch-row">
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-medium text-[var(--o-text)]">Reboot afterwards if needed</div>
              <div className="o-hint">Sites are down for about a minute.</div>
            </div>
            <Toggle checked={f.autoReboot} onChange={(autoReboot) => setF({ ...f, autoReboot })} label="Reboot afterwards when an update requires it" />
          </div>
          {warn && <Callout tone="sand">{warn}</Callout>}
        </div>
      </DBody>
      <SaveFoot dirty={dirty} valid={valid} busy={!!busy} onCancel={close} onSave={() => void run("save", () => api.put("/api/settings/updates", f), "Update settings saved.").then((ok) => ok && (reload(), close()))} />
    </>
  );
}

/* ---------- Page ----------------------------------------------------------------------------------- */

export function SettingsPage() {
  const p = usePoll<Settings>("/api/settings", SETTINGS_EVERY);
  const { overview } = useNav();
  const { refresh } = p;
  const reload = useCallback(() => void refresh(), [refresh]);
  const host = overview?.host.ip ?? overview?.host.hostname ?? "the server";
  return (
    <div className="o-wrap d-page">
      <Loading data={p.data} error={p.error}>
        {(s) => {
          const open = [
            has("tailscale") && on(s.tailscale) && s.tailscale.state !== "Running" && "Tailscale",
            has("backup") && on(s.remote) && !s.remote.configured && "off-site backup",
            has("portainer") && on(s.portainer) && !s.portainer.connected && "Portainer",
          ].filter(Boolean) as string[];
          return (
            <>
              <PageHero
                title={open.length ? "Almost set up." : "All set up."}
                lead={
                  <Chips>
                    <Pill tone="neutral" title={`Everything here configures the server (${host}), not this computer.`}>
                      applies to the server
                    </Pill>
                    <Pill tone="neutral" title="Schedules run in this timezone (KW_LOCAL_TZ).">
                      times in {timeZone()}
                    </Pill>
                    {open.length > 0 && <Pill tone="sand">open: {open.join(", ")}</Pill>}
                  </Chips>
                }
                aside={<Stale error={p.error} at={p.at} />}
              />
              {has("proxy") ? <SettingsWithNpm s={s} reload={reload} /> : <SettingsList s={s} reload={reload} npm={null} />}
            </>
          );
        }}
      </Loading>
    </div>
  );
}

type Npm = ReturnType<typeof useNpmStatus>;

/** Proxy Manager login only with the proxy module – its status is fetched only then. */
function SettingsWithNpm({ s, reload }: { s: Settings; reload: () => void }) {
  const npm = useNpmStatus();
  return <SettingsList s={s} reload={reload} npm={npm} />;
}

function Group({ title, delay, children }: { title: string; delay: number; children: ReactNode }) {
  return (
    <Reveal delay={delay} className="d-set-group">
      <h2 className="d-group-title">{title}</h2>
      <Panel className="d-set-panel">{children}</Panel>
    </Reveal>
  );
}

function SettingsList({ s, reload, npm }: { s: Settings; reload: () => void; npm: Npm | null }) {
  const cfg = useConfig();
  const [open, setOpen] = useState<SettingKey | null>(pendingSetting);
  useEffect(() => onOpenSetting(setOpen), []);
  const keys = new Set(settingsIndex().map((x) => x.key));
  const archive = useArchiveOverview(keys.has("logArchive"));
  const touch = useTouchStatus(keys.has("passkey"));
  const kwUpdate = useSelfUpdate();
  const mods = useModules();
  const shut = () => setOpen(null);

  // Rows only for installed modules whose section the server actually sent.
  const ts = on(s.tailscale) ? s.tailscale : null;
  const f = on(s.fail2ban) ? s.fail2ban : null;
  const b = on(s.backup) ? s.backup : null;
  const r = on(s.remote) ? (s.remote as Remote) : null;
  const u = on(s.updates) ? s.updates : null;
  const pt = on(s.portainer) ? s.portainer : null;
  const show = (k: SettingKey) =>
    keys.has(k) &&
    ({ tailscale: !!ts, fail2ban: !!f, schedule: !!b, remote: !!r, password: !!b, updates: !!u, portainer: !!pt, npm: !!npm } as Partial<Record<SettingKey, boolean>>)[k] !== false;

  const tsState = ts ? tailscaleState(ts) : null;
  const ssh = sshAvailable(s) ? s.ssh : null;
  const daysLeft = ts?.keyExpiry ? Math.floor((ts.keyExpiry - Date.now() / 1000) / 86400) : null;
  const warn = b && u ? orderWarning(b.schedule, u.rebootTime) : null;
  const ao = archive.data;
  const st = npm?.st ?? null;

  const row = (key: SettingKey, icon: typeof Clock, value: ReactNode, state?: ReactNode, extra?: { hint?: string; id?: string }) =>
    show(key) ? <SettingRow key={key} icon={icon} title={settingTitle(key)} value={value} state={state} onOpen={() => setOpen(key)} hint={extra?.hint} id={extra?.id} /> : null;

  const f2bHint = has("tailscale") ? "Limits for failed SSH logins from the internet and through Tailscale." : "Limits for failed SSH logins.";

  const access = [
    ts &&
      tsState &&
      row(
        "tailscale",
        ShieldCheck,
        <>
          {ts.state === "Running" ? <span className="d-mono">{ts.dnsName ?? ts.ip ?? "—"}</span> : "not in your tailnet"}
          {ssh && (
            <>
              {" "}
              · port 22 <b>{ssh.public ? "open" : "closed"}</b>
            </>
          )}
        </>,
        ssh?.revertAt ? (
          <SshCountdown at={ssh.revertAt} />
        ) : tsState.tone !== "ok" ? (
          <Pill tone={tsState.tone} dot>
            {tsState.label}
          </Pill>
        ) : daysLeft !== null && daysLeft < 30 ? (
          <Pill tone="rose">key expires soon</Pill>
        ) : null,
      ),
    row("passkey", Fingerprint, touchRowValue(touch.data, touch.error), touchRowState(touch.data), {
      hint: "Dangerous actions only with the passkey of a registered device.",
    }),
    f &&
      row(
        "fail2ban",
        ShieldBan,
        <>
          <b>{f.sshMaxretry ?? f.maxretry ?? "?"}×</b>
          {f.maxretry !== null && f.sshMaxretry !== undefined && f.maxretry !== f.sshMaxretry ? <> (Tailscale {f.maxretry}×)</> : null} / {durShort(f.findtimeHours)} → <b>{durShort(f.bantimeHours)}</b> · repeat offenders → <b>{f.recidiveBantimeDays} d</b>
          {(f.ignoreip?.length ?? 0) > 0 && <> · {f.ignoreip.length} never banned</>}
        </>,
        undefined,
        { hint: f2bHint },
      ),
  ].filter(Boolean);

  const backups = [
    b &&
      row(
        "schedule",
        Clock,
        <>
          daily at <b>{b.schedule}</b> · local <b>{b.keepDaily}</b> d / <b>{b.keepWeekly}</b> w / <b>{b.keepMonthly}</b> m · off-site <b>{b.remoteKeepDaily}</b> d /{" "}
          <b>{b.remoteKeepWeekly}</b> w / <b>{b.remoteKeepMonthly}</b> m
        </>,
        warn ? <Pill tone="sand">after the updates</Pill> : null,
        { hint: warn ?? undefined },
      ),
    r &&
      row(
        "remote",
        UploadCloud,
        r.configured ? (
          <>
            <span className="d-mono">{r.name || r.repo || "connected"}</span>
            {r.check && <> · tested {agoShort(r.check.at)}</>}
          </>
        ) : (
          "local only"
        ),
        !r.configured ? (
          <Pill tone="sand" dot>
            not set up
          </Pill>
        ) : r.check && !r.check.ok ? (
          <Pill tone="rose" dot>
            failing
          </Pill>
        ) : null,
      ),
    b && row("password", KeyRound, b.passwordSet ? "stored on the server" : "none yet", b.passwordSet ? null : <Pill tone="sand">missing</Pill>),
  ].filter(Boolean);

  const ops = [
    u &&
      row(
        "updates",
        PackageCheck,
        <>
          daily at <b>{u.rebootTime}</b> · {u.autoReboot ? "reboot when needed" : "no reboot"}
        </>,
      ),
    row("logArchive", Archive, ao ? <ArchiveSummary o={ao} /> : archive.error ? "unavailable" : "…", ao ? archiveState(ao) : null),
    pt &&
      row(
        "portainer",
        Layers,
        pt.connected ? "connected" : "no valid token",
        pt.connected ? null : (
          <Pill tone="sand" dot>
            not connected
          </Pill>
        ),
        { hint: "For redeploys and the environment variables under Services." },
      ),
    npm &&
      row(
        "npm",
        Globe,
        st ? (st.configured ? st.email : "no login stored") : npm.error ? "unavailable" : "…",
        st && !st.connected ? (
          <Pill tone={st.configured ? "rose" : "sand"} dot>
            {st.configured ? "rejected" : "missing"}
          </Pill>
        ) : null,
        { hint: "For \"New site\": creates hosts and certificates in the Proxy Manager.", id: NPM_CARD_ID },
      ),
  ].filter(Boolean);

  return (
    <>
      {access.length > 0 && (
        <Group title="Access" delay={40}>
          {access}
        </Group>
      )}
      {backups.length > 0 && (
        <Group title="Backups" delay={80}>
          {backups}
        </Group>
      )}
      {ops.length > 0 && (
        <Group title="Operations" delay={120}>
          {ops}
        </Group>
      )}
      <Group title="System" delay={160}>
        {row("selfUpdate", ArrowUpCircle, selfUpdateRowValue(kwUpdate.s, kwUpdate.error), selfUpdateRowState(kwUpdate.s), {
          hint: "Install new Keepwatch versions from GitHub without a computer.",
        })}
        {row("modules", Blocks, modulesRowValue(mods, cfg), modulesRowState(mods, cfg.fallback), {
          hint: "Which Keepwatch modules run on the server; switch the add-ons here.",
        })}
      </Group>

      {open === "tailscale" && ts && tsState && show("tailscale") && (
        <SettingDialog icon={ShieldCheck} title={settingTitle("tailscale")} size="md" onClose={shut} sub={<Pill tone={tsState.tone} dot>{tsState.label}</Pill>}>
          {(close) => (
            <>
              <DBody>
                <RemoteAccessBody s={s} reload={reload} />
              </DBody>
              <DFoot>
                <Button variant="ghost" onClick={close}>
                  Close
                </Button>
              </DFoot>
            </>
          )}
        </SettingDialog>
      )}
      {open === "passkey" && show("passkey") && (
        <SettingDialog icon={Fingerprint} title={settingTitle("passkey")} sub="Dangerous actions need Touch ID, Windows Hello or another passkey – no password fallback." onClose={shut}>
          {(close) =>
            touch.data ? (
              <TouchIdBody st={touch.data} reload={() => void touch.refresh()} close={close} />
            ) : (
              <DBody>
                <p className="o-hint">{touch.error ?? "Loading …"}</p>
              </DBody>
            )
          }
        </SettingDialog>
      )}
      {open === "fail2ban" && f && show("fail2ban") && (
        <SettingDialog icon={ShieldBan} title={settingTitle("fail2ban")} sub={f2bHint} onClose={shut}>
          {(close) => <Fail2banBody f2b={f} myIps={s.myIps ?? []} reload={reload} close={close} />}
        </SettingDialog>
      )}
      {open === "schedule" && b && show("schedule") && (
        <SettingDialog icon={Clock} title={settingTitle("schedule")} onClose={shut}>
          {(close) => <ScheduleBody b={b} updatesAt={u?.rebootTime ?? null} reload={reload} close={close} />}
        </SettingDialog>
      )}
      {open === "remote" && r && show("remote") && (
        <SettingDialog icon={UploadCloud} title={settingTitle("remote")} sub={r.configured ? undefined : "Right now every backup sits on the same disk as the data."} onClose={shut}>
          {(close) => <RemoteBody r={r} reload={reload} close={close} />}
        </SettingDialog>
      )}
      {open === "password" && b && show("password") && (
        <SettingDialog icon={KeyRound} title={settingTitle("password")} sub="Without this password, no backup can be read." size="sm" onClose={shut}>
          {(close) => <PasswordBody set={b.passwordSet} close={close} />}
        </SettingDialog>
      )}
      {open === "updates" && u && show("updates") && (
        <SettingDialog icon={PackageCheck} title={settingTitle("updates")} onClose={shut}>
          {(close) => <UpdatesBody u={u} backupAt={b?.schedule ?? null} reload={reload} close={close} />}
        </SettingDialog>
      )}
      {open === "logArchive" && show("logArchive") && (
        <SettingDialog icon={Archive} title={settingTitle("logArchive")} sub="Container logs that survive recreating a container." onClose={shut}>
          {(close) =>
            ao ? (
              <ArchiveBody o={ao} reload={() => void archive.refresh()} close={close} />
            ) : (
              <DBody>
                <p className="o-hint">{archive.error ?? "Loading …"}</p>
              </DBody>
            )
          }
        </SettingDialog>
      )}
      {open === "portainer" && pt && show("portainer") && (
        <SettingDialog icon={Layers} title={settingTitle("portainer")} sub="For redeploys and the environment variables under Services." onClose={shut}>
          {(close) => <PortainerBody p={pt} reload={reload} close={close} />}
        </SettingDialog>
      )}
      {open === "npm" && npm && show("npm") && (
        <SettingDialog icon={Globe} title={settingTitle("npm")} sub={'For "New site" under Services.'} onClose={shut}>
          {(close) => <NpmBody st={st} error={npm.error} load={npm.load} close={close} />}
        </SettingDialog>
      )}
      {open === "selfUpdate" && show("selfUpdate") && (
        <SettingDialog icon={ArrowUpCircle} title={settingTitle("selfUpdate")} sub="New Keepwatch versions from GitHub, installed by the server itself." size="md" onClose={shut}>
          {(close) => <SelfUpdateBody close={close} />}
        </SettingDialog>
      )}
      {open === "modules" && (
        <SettingDialog icon={Blocks} title={settingTitle("modules")} sub="What Keepwatch set up on this server – add-ons switch here, the rest from your computer." size="lg" onClose={shut}>
          {(close) => <ModulesBody mods={mods} close={close} />}
        </SettingDialog>
      )}
    </>
  );
}
