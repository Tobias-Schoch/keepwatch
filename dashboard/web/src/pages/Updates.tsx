import { ArrowUpRight, ChevronDown, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, usePoll, type Poll } from "../api";
import { FoldToggle } from "../common";
import { Button, Confirm, cx, Panel, Pill, type ConfirmCopy } from "../design/ui";
import { has } from "../config";
import { agoShort, bytes, fmtDate, shortDateTime } from "../format";
import { useAction, useToast } from "../messages";
import { setMaintenanceOpen, useMaintenanceOpen } from "./servicesStore";
import { busyUpdates, scanOf, versionOf, type Cleanup, type ImageUpdate, type ScanImage, type Updates } from "../updates";

/**
 * Images (update, rollback, vulnerabilities) in an expanded service, the "n updates available" chip
 * and the collapsed "Maintenance" panel (check for updates, scan, cleanup).
 * The backend runs jobs in the background; meanwhile the page polls every 3 s (useUpdates) and reports the result.
 * Image updates and cleanup need the docker module, the scan needs image-scan, redeploys need portainer.
 */

const day = (unix: number | null | undefined) => (unix ? fmtDate(unix, { month: "short", day: "numeric" }) : null);
const short = (commit: string | null) => (commit ? commit.slice(0, 7) : "?");
const isPostgres = (i: ImageUpdate) => /(^|\/)postgres:/.test(i.ref);

const KIND_LABEL: Record<string, string> = { minor: "new version", patch: "patch", build: "new build" };
const isProxy = (i: ImageUpdate) => /nginx-proxy-manager/.test(i.ref);
const isPortainer = (i: ImageUpdate) => /(^|\/)portainer(-ce|-ee)?:/.test(i.ref);

function updateCopy(i: ImageUpdate): ConfirmCopy {
  const target = i.remote?.version ?? "the new version";
  const where =
    i.via === "portainer"
      ? `The stack ${i.project} is redeployed (which also pulls the latest Git commit). Its sites are briefly down.`
      : isProxy(i)
        ? "All sites are down for about half a minute."
        : isPortainer(i)
          ? "Portainer restarts – redeploys and environment variables don't work meanwhile."
          : "The service restarts.";
  return {
    title: `Update ${i.name ?? i.ref} to ${target}?`,
    description: `${where}${isPostgres(i) ? " The database is backed up first (pg_dumpall)." : ""}`,
    note: `If a container isn't healthy within 2 min, it rolls back to ${versionOf(i.local)} automatically.`,
    confirmLabel: "Update",
    tone: "accent",
  };
}

function rollbackCopy(i: ImageUpdate): ConfirmCopy {
  const v = i.previous?.version ?? day(i.previous?.created) ?? "the previous version";
  return {
    title: `Roll ${i.name ?? i.ref} back to ${v}?`,
    description: "The previous image is put back and the service recreated without a pull.",
    note: i.via === "portainer" ? `This redeploys the stack ${i.project}.` : undefined,
    confirmLabel: "Roll back",
    tone: "danger",
  };
}

/** Deployed Git commit of a stack as short text ("a93e7fb · today 21:25"). */
export function gitText(u: Updates | null, stack: string | null): string | null {
  const g = stack && u ? (u.stacks ?? []).find((s) => s.name === stack) : undefined;
  if (!g) return null;
  return `${short(g.commit)}${g.deployedAt ? ` · ${shortDateTime(g.deployedAt)}` : ""}`;
}

/** Job is running or ended at most 6 hr ago. */
const active = (job: Updates["jobs"][string] | undefined) => !!job && (job.state === "running" || (!!job.finishedAt && Date.now() / 1000 - job.finishedAt < 6 * 3600));

/** Images of a service block, only when there is something to see or do: update, job, vulnerabilities, rollback. One row per image. */
export function BlockUpdates({ stack, containers, u, onDone }: { stack: string | null; containers: string[]; u: Updates | null; onDone: () => void }) {
  const { busy, run } = useAction();
  const [ask, setAsk] = useState<{ i: ImageUpdate; action: "apply" | "rollback" } | null>(null);
  if (!u) return null;
  const mine = (cs: string[]) => cs.some((c) => containers.includes(c));
  const scan = Object.entries(scanOf(u)?.images ?? {}).filter(([, e]) => (e.critical || e.high || e.error) && mine(e.containers));
  const vulnOf = (ref: string) => scan.find(([r]) => r === ref)?.[1];
  const images = u.images ?? [];
  const items = images.filter((i) => mine(i.containers) && (i.status === "update" || i.status === "major" || !!i.previous || active(u.jobs?.[i.key]) || !!vulnOf(i.ref)));
  const loose = scan.filter(([r]) => !images.some((i) => i.ref === r && mine(i.containers)));
  if (!items.length && !loose.length) return null;
  const git = stack ? (u.stacks ?? []).find((s) => s.name === stack) : undefined;
  const blocked = !!busy || busyUpdates(u);
  const go = (i: ImageUpdate, action: "apply" | "rollback") =>
    void run(`${action}-${i.key}`, () => api.post(`/api/updates/${action}`, { key: i.key }), action === "apply" ? `${i.name ?? i.ref}: updating …` : `${i.name ?? i.ref}: rolling back …`).then(onDone);
  return (
    <div className="svc-rows">
      {items.map((i) => (
        <ImageRow key={i.key} imageRef={i.ref} i={i} u={u} e={vulnOf(i.ref)} built={false} blocked={blocked} onApply={() => setAsk({ i, action: "apply" })} onRollback={() => setAsk({ i, action: "rollback" })} />
      ))}
      {loose.map(([ref, e]) => (
        <ImageRow key={ref} imageRef={ref} u={u} e={e} built={!!git?.built.includes(ref)} blocked={blocked} />
      ))}
      {ask && (
        <Confirm
          icon={ask.action === "apply" ? RefreshCw : RotateCcw}
          copy={ask.action === "apply" ? updateCopy(ask.i) : rollbackCopy(ask.i)}
          onClose={() => setAsk(null)}
          onConfirm={() => go(ask.i, ask.action)}
        />
      )}
    </div>
  );
}

const cveUrl = (id: string, url: string | null) => url ?? (id.startsWith("CVE-") ? `https://nvd.nist.gov/vuln/detail/${id}` : `https://avd.aquasec.com/nvd/${id.toLowerCase()}`);

interface ImageRowProps {
  imageRef: string;
  i?: ImageUpdate;
  u: Updates;
  e?: ScanImage;
  built: boolean;
  blocked: boolean;
  onApply?: () => void;
  onRollback?: () => void;
}

/** One image: name, version or update, vulnerabilities (expandable with package, version and CVE), roll back / update on the right. */
function ImageRow({ imageRef, i, u, e, built, blocked, onApply, onRollback }: ImageRowProps) {
  const [open, setOpen] = useState(false);
  const job = i ? u.jobs?.[i.key] : undefined;
  const running = job?.state === "running";
  const recent = job && job.state !== "running" && job.finishedAt && Date.now() / 1000 - job.finishedAt < 6 * 3600 ? job : null;
  const prevLabel = i?.previous ? (i.previous.version ?? day(i.previous.created) ?? "previous") : null;
  const upd = !!i && (i.status === "update" || i.status === "major");
  const fixed = e ? e.vulns.filter((v) => v.fixed).length : 0;
  const fixHow = i?.status === "update" ? "The update fixes them" : built ? "Redeploying rebuilds the image with current packages" : "Newer packages fix them";
  return (
    <div className={cx("svc-row svc-img", recent?.state === "error" && "is-bad")}>
      <span className="svc-row-main">
        <span className={cx("svc-row-name", !i?.name && "d-mono")} title={[imageRef, i?.containers.join(", ")].filter(Boolean).join("\n")}>
          {i?.name ?? imageRef}
        </span>
        {running ? (
          <span className="d-upd-step">
            <RefreshCw className="h-3.5 w-3.5 o-spin" /> {job.action === "rollback" ? "rolling back" : "updating"} – {job.step ?? "…"}
          </span>
        ) : upd ? (
          <>
            <span className={cx("svc-ver", i.status === "major" && "is-major")}>
              {versionOf(i.local)} → {versionOf(i.remote)}
            </span>
            {i.status === "major" ? (
              <span className="svc-issue" title="Major version jumps are only shown, never applied with one click.">
                major update
              </span>
            ) : i.security ? (
              <span className="svc-issue" data-tone="sand">
                security patch
              </span>
            ) : (
              i.kind && <span className="svc-issue">{KIND_LABEL[i.kind] ?? i.kind}</span>
            )}
          </>
        ) : i ? (
          <span className="svc-issue" title={i.status === "unknown" ? (i.reason ?? undefined) : i.local.created ? `Image from ${day(i.local.created)}` : undefined}>
            {i.status === "unknown" ? "version unknown" : (i.local.version ?? (i.local.created ? `from ${day(i.local.created)}` : ""))}
          </span>
        ) : null}
        {recent && (
          <span className="svc-issue" data-tone={recent.state === "ok" ? "ok" : recent.state === "rolledBack" ? "sand" : "rose"} title={recent.message ?? undefined}>
            {recent.state === "ok" ? (recent.action === "rollback" ? "rolled back" : "updated") : recent.state === "rolledBack" ? "rolled back automatically" : "failed"} {agoShort(recent.finishedAt)}
          </span>
        )}
        {e &&
          (e.error ? (
            <span className="svc-issue" title={e.error}>
              scan failed
            </span>
          ) : (
            <button type="button" className="svc-vuln" onClick={() => setOpen((v) => !v)} aria-expanded={open} disabled={!e.vulns.length} title="Show vulnerabilities">
              {e.critical > 0 && <span data-tone="rose">{e.critical} critical</span>}
              {e.high > 0 && <span data-tone="sand">{e.high} high</span>}
              {fixed > 0 && <span title={fixHow}>{fixed === e.vulns.length ? "all" : fixed} fixable</span>}
              <ChevronDown className={cx("o-chev h-3.5 w-3.5", open && "is-open")} />
            </button>
          ))}
      </span>
      <span className="svc-row-side">
        {upd && i.notesUrl && (
          <a className="d-upd-link" href={i.notesUrl} target="_blank" rel="noreferrer">
            Release notes <ArrowUpRight className="inline h-3 w-3 align-[-1px]" />
          </a>
        )}
        {i?.previous && !running && onRollback && (
          <Button size="sm" variant="ghost" className="d-renew" disabled={blocked} onClick={onRollback} title={`Previous version: ${i.previous.ref}`}>
            <RotateCcw className="h-3.5 w-3.5" /> Roll back to {prevLabel}
          </Button>
        )}
        {i?.status === "update" && !running && onApply && (
          <Button size="sm" variant="primary" disabled={blocked} onClick={onApply} title={isPostgres(i) ? "The database is backed up automatically first." : undefined}>
            Update
          </Button>
        )}
      </span>
      {recent && recent.state !== "ok" && recent.message && <p className="d-upd-note">{recent.message}</p>}
      {open && e && (
        <div className="d-table-wrap d-vuln-list">
          <table className="d-table">
            <thead>
              <tr>
                <th>Vulnerability</th>
                <th>Package</th>
                <th>Installed</th>
                <th>Fixed in</th>
              </tr>
            </thead>
            <tbody>
              {e.vulns.map((v) => (
                <tr key={`${v.id}-${v.pkg}-${v.installed}`}>
                  <td className="whitespace-nowrap">
                    <span className={cx("d-sev", v.severity === "CRITICAL" ? "is-crit" : "is-high")} title={v.severity === "CRITICAL" ? "critical" : "high"} />
                    <a className="d-upd-link d-mono" href={cveUrl(v.id, v.url)} target="_blank" rel="noreferrer" title={v.title ?? undefined}>
                      {v.id} <ArrowUpRight className="inline h-3 w-3 align-[-1px]" />
                    </a>
                  </td>
                  <td className="is-main" title={v.target ?? undefined}>
                    {v.pkg}
                  </td>
                  <td className="d-mono">{v.installed}</td>
                  <td className="d-mono">{v.fixed ?? <span className="o-mute">no fix yet</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Row in "Maintenance": state of the security scan and "Scan now" (module image-scan). */
function ScanRow({ u, onDone }: { u: Updates | null; onDone: () => void }) {
  const { busy, run } = useAction();
  const sc = scanOf(u);
  if (!sc) return null;
  const all = Object.values(sc.images ?? {});
  const crit = all.reduce((n, i) => n + i.critical, 0);
  const high = all.reduce((n, i) => n + i.high, 0);
  const failed = sc.lastResult && sc.lastResult !== "success" && !sc.running;
  return (
    <div className="svc-maint-row">
      <span className="svc-maint-label">Security scan</span>
      <span className="svc-maint-state">
        {!sc.installed ? (
          <span className="o-mute" title="Installed by ./keepwatch deploy with the image-scan module">not installed</span>
        ) : sc.running ? (
          <span className="d-upd-step">
            <RefreshCw className="h-3.5 w-3.5 o-spin" />
            running{sc.progress ? ` – ${sc.progress.current === "database" ? "loading the vulnerability database" : `${sc.progress.done + 1} of ${sc.progress.total}`}` : " …"}
          </span>
        ) : sc.finishedAt ? (
          <>
            <span className="o-mute">{agoShort(sc.finishedAt)}</span>
            {crit > 0 && <Pill tone="rose">{crit} critical</Pill>}
            {high > 0 && <Pill tone="sand">{high} high</Pill>}
            {sc.error && (
              <Pill tone="neutral" title={sc.error}>
                {sc.ok === false && all.length ? "partly failed" : "failed"}
              </Pill>
            )}
          </>
        ) : (
          <span className="o-mute">never{failed ? " – last attempt failed" : ""}</span>
        )}
      </span>
      {sc.installed && !sc.running && (
        <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run("scan", () => api.post("/api/updates/scan"), "Security scan started – this takes a few minutes.").then(onDone)}>
          <RefreshCw className={cx("h-3.5 w-3.5", busy && "o-spin")} /> Scan now
        </Button>
      )}
    </div>
  );
}

/** Button: check for updates now. */
export function CheckButton({ p, size = "md" }: { p: Poll<Updates>; size?: "sm" | "md" }) {
  const { busy, run } = useAction();
  const checking = !!busy || !!p.data?.checking;
  return (
    <Button
      variant={size === "sm" ? "ghost" : "secondary"}
      size={size}
      disabled={checking}
      title={p.data?.checkedAt ? `last checked ${agoShort(p.data.checkedAt)}` : "not checked yet"}
      onClick={() => void run("check", () => api.post("/api/updates/check")).then(() => p.refresh())}
    >
      <RefreshCw className={cx(size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4", checking && "o-spin")} />
      {checking ? "Checking …" : size === "sm" ? "Check now" : "Check for updates"}
    </Button>
  );
}

/** Chip "n updates available" (sand), otherwise nothing. */
export function UpdatesChip({ u, onClick, services }: { u: Updates | null; onClick?: () => void; services?: boolean }) {
  if (!u || !u.available || !u.images) return null;
  const sec = u.images.some((i) => i.status === "update" && i.security);
  const pill = (
    <Pill tone="sand" title={u.images.filter((i) => i.status === "update").map((i) => `${i.ref}: ${versionOf(i.local)} → ${versionOf(i.remote)}`).join("\n")}>
      {services ? (u.available === 1 ? "1 service update" : `${u.available} service updates`) : u.available === 1 ? "1 update available" : `${u.available} updates available`}
      {sec ? " · security" : ""}
    </Pill>
  );
  return onClick ? (
    <button type="button" className="d-chip-btn" onClick={onClick}>
      {pill}
    </button>
  ) : (
    pill
  );
}

/* ---------- Cleanup -------------------------------------------------------------------------------- */

type Pick = "buildCache" | "images" | "containers";

function Row({ on, set, label, sub, title, size, disabled }: { on: boolean; set?: (v: boolean) => void; label: string; sub?: string; title?: string; size: number; disabled?: boolean }) {
  return (
    <label className={cx("d-clean-row", disabled && "is-off")} title={title}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => set?.(e.target.checked)} />
      <span className="min-w-0 flex-1">
        <span className="text-[var(--o-text)]">{label}</span>
        {sub && <span className="o-mute"> {sub}</span>}
      </span>
      <span className="d-mono o-dim">{bytes(size)}</span>
    </label>
  );
}

/** Cleanup (in "Maintenance"): build cache, unused images, stopped containers. Loads only when visible. */
function CleanupBody({ onDone }: { onDone?: () => void }) {
  const p = usePoll<Cleanup>(has("docker") ? "/api/cleanup" : null, 5 * 60_000);
  const { busy, run } = useAction();
  const toast = useToast();
  const [pick, setPick] = useState<Record<Pick, boolean> | null>(null);
  const [ask, setAsk] = useState(false);
  const c = p.data;
  if (!c) return null;
  const sel: Record<Pick, boolean> = pick ?? { buildCache: c.buildCache.bytes > 0, images: c.images.count > 0, containers: false };
  const set = (k: Pick) => (v: boolean) => setPick({ ...sel, [k]: v });
  const free = (sel.buildCache ? c.buildCache.bytes : 0) + (sel.images ? c.images.bytes : 0) + (sel.containers ? c.containers.bytes : 0);
  const parts = `Images ${bytes(c.parts.images)} · Volumes ${bytes(c.parts.volumes)} · Build cache ${bytes(c.parts.buildCache)} · Containers ${bytes(c.parts.containers)}`;
  return (
    <div className="svc-maint-clean">
      <div className="svc-maint-row">
        <span className="svc-maint-label">Cleanup</span>
        <span className="svc-maint-state o-mute" title={parts}>
          Docker uses {bytes(c.total)}
        </span>
        <Button size="sm" variant={free > 0 ? "secondary" : "ghost"} disabled={!!busy || free < 1} onClick={() => setAsk(true)}>
          {busy ? <RefreshCw className="h-3.5 w-3.5 o-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          {busy ? "Cleaning up …" : `Free ${bytes(free)}`}
        </Button>
      </div>
      <div className="svc-maint-picks">
        <Row on={sel.buildCache} set={set("buildCache")} label="Build cache" size={c.buildCache.bytes} disabled={c.buildCache.bytes <= 0} />
        <Row on={sel.images} set={set("images")} label="Unused images" title={c.kept.length ? "Previous versions for rollback are kept" : undefined} size={c.images.bytes} disabled={c.images.count === 0} />
        <Row on={sel.containers} set={set("containers")} label="Stopped containers" sub={c.containers.count ? `· ${c.containers.items.join(", ")}` : undefined} size={c.containers.bytes} disabled={c.containers.count === 0} />
      </div>
      {ask && (
        <Confirm
          icon={Trash2}
          copy={{
            title: `Free ${bytes(free)}?`,
            description: "Deletes " + [sel.buildCache && "the build cache", sel.images && `${c.images.count} unused images`, sel.containers && `${c.containers.count} stopped containers`].filter(Boolean).join(", ") + ".",
            note: "Volumes (where the data lives) and previous versions (:keepwatch-previous) stay. The next build of a stack takes a little longer without the cache.",
            confirmLabel: "Free up",
            tone: "danger",
          }}
          onClose={() => setAsk(false)}
          onConfirm={() =>
            void run("cleanup", async () => {
              const r = await api.post<{ ok: boolean; freed: number; message: string }>("/api/cleanup", sel);
              toast(r.message);
              setPick(null);
              await p.refresh();
              onDone?.();
            })
          }
        />
      )}
    </div>
  );
}

/**
 * "Maintenance" at the bottom of Services, collapsed: check for updates, security scan, cleanup.
 * Problems found there (updates, vulnerabilities) show up at the top and on the service anyway.
 */
export function Maintenance({ p, onCleaned }: { p: Poll<Updates>; onCleaned?: () => void }) {
  const open = useMaintenanceOpen();
  const u = p.data;
  const sc = scanOf(u);
  const meta = [
    u?.checking ? "checking for updates …" : u?.checkedAt ? `updates checked ${agoShort(u.checkedAt)}` : "updates never checked",
    sc?.installed ? (sc.running ? "scan running" : sc.finishedAt ? `scanned ${agoShort(sc.finishedAt)}` : "never scanned") : null,
  ].filter(Boolean);
  return (
    <Panel className="mt-8 d-fold-panel svc-maint">
      <FoldToggle open={open} onToggle={() => setMaintenanceOpen(!open)}>
        Maintenance
        {!open && <span className="d-fold-meta">{meta.join(" · ")}</span>}
      </FoldToggle>
      {open && (
        <div className="svc-maint-body">
          <div className="svc-maint-row">
            <span className="svc-maint-label">Updates</span>
            <span className="svc-maint-state o-mute">
              {u?.checkedAt ? `checked ${agoShort(u.checkedAt)}` : "never checked"}
              {u?.error && (
                <Pill tone="sand" className="ml-2" title={u.error}>
                  error
                </Pill>
              )}
            </span>
            <CheckButton p={p} size="sm" />
          </div>
          <ScanRow u={u} onDone={() => void p.refresh()} />
          <CleanupBody onDone={onCleaned} />
        </div>
      )}
    </Panel>
  );
}
