import { ArrowUpCircle, CheckCircle2, ExternalLink, Loader2, RefreshCw, X, XCircle, type LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { refreshAll } from "../api";
import { FoldToggle } from "../common";
import { Button, Callout, Confirm, cx, IconButton, KeyValue, Pill, Toggle, type Tone } from "../design/ui";
import { ago, agoShort, dateTime, fmtDate, nowSec } from "../format";
import { useAction } from "../messages";
import { checkNow, installUpdate, offerKey, runKey, setAutoCheck, stepLabel, useDismissed, useSelfUpdate, type SelfUpdate } from "../selfupdate";
import { DBody, DFoot } from "./settingsUi";
import "./selfupdate.css";

/*
 * Keepwatch updates from the dashboard: a calm banner on the overview, the details in
 * Settings → Keepwatch updates. Never commit ids in the main text – a version is its date.
 */

/** "Oct 27, 2026" */
const day = (unix: number | null | undefined) => (unix ? fmtDate(unix, { month: "short", day: "numeric", year: "numeric" }) : "unknown date");

/** A finished run that belongs to what runs now (a deploy since then makes it old news). */
function runShown(s: SelfUpdate): "done" | "failed" | null {
  const r = s.run;
  if (r.state === "done" && s.installed.source === "dashboard" && s.installed.commit === r.target && nowSec() - (r.finishedAt ?? 0) < 86400) return "done";
  if (r.state === "failed" && (r.finishedAt ?? 0) >= (s.installed.at ?? 0)) return "failed";
  return null;
}

function compareUrl(s: SelfUpdate): string {
  const from = s.installed.commit;
  return from && s.latest && !s.localBuild ? `${s.url}/compare/${from}...${s.latest.commit}` : `${s.url}/commits/${encodeURIComponent(s.branch)}`;
}

/* ---------- Building blocks --------------------------------------------------------------------------- */

function Banner({ tone, icon: Icon, spin, title, children, onDismiss }: { tone: Tone; icon: LucideIcon; spin?: boolean; title: ReactNode; children?: ReactNode; onDismiss?: () => void }) {
  return (
    <div className="o-callout su-banner" data-tone={tone} role={tone === "rose" ? "alert" : "status"}>
      <span className="o-callout-icon">
        <Icon className={cx("h-4 w-4", spin && "o-spin")} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="o-callout-title">{title}</div>
        {children}
      </div>
      {onDismiss && (
        <IconButton label="Dismiss" size="sm" onClick={onDismiss} className="o-callout-x">
          <X className="h-3.5 w-3.5" />
        </IconButton>
      )}
    </div>
  );
}

function WhatsNew({ s, defaultOpen = false }: { s: SelfUpdate; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!s.changes.length && !s.localBuild) return null;
  return (
    <div className="su-new">
      <FoldToggle open={open} onToggle={() => setOpen((v) => !v)}>
        What's new
      </FoldToggle>
      {open && (
        <>
          {s.changes.length > 0 ? (
            <ul className="su-changes">
              {s.changes.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
              {s.moreChanges > 0 && <li className="su-more">and {s.moreChanges} more</li>}
            </ul>
          ) : (
            <p className="o-hint">GitHub can't compare a local build with the newest version.</p>
          )}
          <a className="su-link" href={compareUrl(s)} target="_blank" rel="noreferrer noopener">
            All changes on GitHub <ExternalLink className="h-3 w-3" />
          </a>
        </>
      )}
    </div>
  );
}

function Log({ lines, label = "Show details" }: { lines: string[]; label?: string }) {
  const [open, setOpen] = useState(false);
  if (!lines.length) return null;
  return (
    <div className="su-new">
      <FoldToggle open={open} onToggle={() => setOpen((v) => !v)}>
        {open ? "Hide details" : label}
      </FoldToggle>
      {open && <pre className="su-log">{lines.join("\n")}</pre>}
    </div>
  );
}

/** Seconds since `from`, ticking. */
function Elapsed({ from }: { from: number | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!from) return null;
  const s = Math.max(0, nowSec() - from);
  return <span className="su-elapsed">{s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`}</span>;
}

/** "Update now": confirmation, then the passkey (428 → api.ts), then the server takes over. */
function useInstall(s: SelfUpdate | null, after: () => void) {
  const { busy, run } = useAction();
  const [ask, setAsk] = useState(false);
  const sha = s?.latest?.commit;
  const dialog =
    ask && s && sha ? (
      <Confirm
        icon={ArrowUpCircle}
        copy={{
          title: "Install the Keepwatch update?",
          description: (
            <>
              The server downloads the version from {day(s.latest?.date)} from GitHub and sets itself up with it, like <span className="d-mono">./keepwatch deploy</span>. The dashboard restarts on the way – this page reconnects by itself.
            </>
          ),
          note: (
            <>
              {s.localBuild && (
                <>
                  <b>This server runs a local build.</b> Changes it has that aren't on GitHub ({s.branch}) are replaced – deploy from your computer instead to keep them.{" "}
                </>
              )}
              If setting up fails, the previous version is put back.
            </>
          ),
          confirmLabel: s.localBuild ? "Replace and update" : "Update now",
          tone: "accent",
          // Replacing a local build can undo changes that exist only on this server: never by a quick click.
          requireTyping: s.localBuild ? "replace" : undefined,
        }}
        onClose={() => setAsk(false)}
        onConfirm={() => void run("install", () => installUpdate(sha)).then((ok) => ok && after())}
      />
    ) : null;
  return { open: () => setAsk(true), busy: busy === "install", dialog };
}

/* ---------- Overview ---------------------------------------------------------------------------------- */

/** Only when there is something to say: an update, one in progress, or how the last one went. */
export function SelfUpdateBanner() {
  const { s, error, fast } = useSelfUpdate();
  const d = useDismissed();
  const install = useInstall(s, () => {
    fast(true);
    refreshAll();
  });
  if (!s) return null;
  const r = s.run;
  let body: ReactNode = null;
  if (r.state === "running") {
    body = (
      <Banner tone="accent" icon={Loader2} spin title="Installing the Keepwatch update">
        <div className="o-callout-text">
          {error ? "The dashboard is restarting with the new version – this page reconnects by itself." : stepLabel(r)} · <Elapsed from={r.startedAt} />
        </div>
        <Log lines={r.log} />
      </Banner>
    );
  } else if (runShown(s) === "failed" && !d.has(runKey(s))) {
    body = (
      <Banner tone="rose" icon={XCircle} title="The Keepwatch update didn't go through" onDismiss={() => d.dismiss(runKey(s))}>
        <div className="o-callout-text">{r.message}</div>
        <Log lines={r.log} label="Show log" />
        {s.available && (
          <div className="su-actions">
            <Button size="sm" variant="secondary" onClick={install.open} disabled={install.busy}>
              Try again
            </Button>
          </div>
        )}
      </Banner>
    );
  } else if (runShown(s) === "done" && !d.has(runKey(s))) {
    body = (
      <Banner tone="ok" icon={CheckCircle2} title="Keepwatch updated" onDismiss={() => d.dismiss(runKey(s))}>
        <div className="o-callout-text">The server now runs the version from {day(s.installed.date)}.</div>
      </Banner>
    );
  } else if (s.available && s.latest && !d.has(offerKey(s))) {
    body = (
      <Banner tone={s.localBuild ? "sand" : "accent"} icon={ArrowUpCircle} title="Keepwatch update available">
        <div className="o-callout-text">
          A newer version from {day(s.latest.date)} is ready on GitHub{s.installed.date ? <>, this server runs the one from {day(s.installed.date)}</> : null}.
          {s.localBuild && (
            <>
              {" "}
              <b>This server runs a local build:</b> updating replaces its changes that aren't on GitHub. To keep them, deploy from your computer instead.
            </>
          )}
        </div>
        <WhatsNew s={s} />
        <div className="su-actions">
          <Button size="sm" variant="primary" onClick={install.open} disabled={install.busy}>
            {install.busy ? <RefreshCw className="h-3.5 w-3.5 o-spin" /> : <ArrowUpCircle className="h-3.5 w-3.5" />}
            Update now
          </Button>
          <Button size="sm" variant="ghost" onClick={() => d.dismiss(offerKey(s))}>
            Later
          </Button>
        </div>
      </Banner>
    );
  }
  if (!body) return null;
  return (
    <section className="mb-8" aria-label="Keepwatch update">
      {body}
      {install.dialog}
    </section>
  );
}

/* ---------- Settings → Keepwatch updates ----------------------------------------------------------------- */

export function selfUpdateRowValue(s: SelfUpdate | null, error: string | null): ReactNode {
  if (!s) return error ? "unavailable" : "…";
  const checked = s.checkedAt ? <> · checked {agoShort(s.checkedAt)}</> : null;
  if (s.run.state === "running") return <>installing the update …</>;
  if (s.available) return <><b>update available</b> · version from {day(s.latest?.date)}</>;
  return (
    <>
      {s.localBuild ? "local build" : "up to date"} · version from {day(s.installed.date)}
      {checked}
    </>
  );
}

export function selfUpdateRowState(s: SelfUpdate | null): ReactNode {
  if (!s) return null;
  if (s.run.state === "running") return <Pill tone="accent" dot>installing</Pill>;
  if (runShown(s) === "failed") return <Pill tone="rose" dot>update failed</Pill>;
  if (s.available) return <Pill tone="accent" dot>update available</Pill>;
  if (s.error) return <Pill tone="sand">check failed</Pill>;
  return null;
}

export function SelfUpdateBody({ close }: { close: () => void }) {
  const { s, error, fast } = useSelfUpdate();
  const { busy, run } = useAction();
  const install = useInstall(s, () => {
    fast(true);
    refreshAll();
  });
  if (!s)
    return (
      <DBody>
        <p className="o-hint">{error ?? "Loading …"}</p>
      </DBody>
    );
  const r = s.run;
  const shown = runShown(s);
  const have = s.installed;
  return (
    <>
      <DBody>
        <div className="flex flex-col gap-5">
          {r.state === "running" && (
            <Banner tone="accent" icon={Loader2} spin title="Installing the update">
              <div className="o-callout-text">
                {error ? "The dashboard is restarting – this reconnects by itself." : stepLabel(r)} · <Elapsed from={r.startedAt} />
              </div>
              <Log lines={r.log} />
            </Banner>
          )}
          {shown === "failed" && (
            <Callout tone="rose" title={`The last update didn't go through (${ago(r.finishedAt)})`}>
              {r.message}
              <Log lines={r.log} label="Show log" />
            </Callout>
          )}
          {shown === "done" && (
            <Callout tone="ok" title={`Updated ${ago(r.finishedAt)}`}>
              The server runs the newest version from GitHub.
            </Callout>
          )}
          {s.available && s.latest && r.state !== "running" && (
            <Callout tone="accent" icon={ArrowUpCircle} title="Update available">
              The version from {day(s.latest.date)} is ready on GitHub.
              <WhatsNew s={s} defaultOpen />
            </Callout>
          )}
          <KeyValue
            items={[
              [
                "This server runs",
                <span className="inline-flex flex-wrap items-center justify-end gap-2">
                  {have.commit ? <>version from {day(have.date)}</> : "an unknown version"}
                  {have.commit && (
                    <span className="d-mono o-mute" title={have.commit}>
                      {have.commit.slice(0, 7)}
                    </span>
                  )}
                  {s.localBuild && <Pill tone="sand">local build</Pill>}
                </span>,
              ],
              ["Installed", have.at ? `${dateTime(have.at)} · ${have.source === "dashboard" ? "from the dashboard" : "by ./keepwatch deploy"}` : "—"],
              [
                "Updates from",
                <a className="su-link" href={s.url} target="_blank" rel="noreferrer noopener">
                  github.com/{s.repo} <span className="o-mute">· {s.branch}</span> <ExternalLink className="h-3 w-3" />
                </a>,
              ],
              [
                "Last check",
                s.error ? (
                  <span className="inline-flex flex-wrap items-center justify-end gap-2">
                    <Pill tone="sand">failed {agoShort(s.errorAt)}</Pill>
                    {s.checkedAt ? `last good ${ago(s.checkedAt)}` : null}
                  </span>
                ) : s.checkedAt ? (
                  ago(s.checkedAt)
                ) : (
                  "not yet"
                ),
              ],
            ]}
          />
          {s.error && (
            <Callout tone="sand" title="The last check didn't work">
              {s.error}
              {s.retryAt ? <> GitHub accepts the next one {ago(s.retryAt)}.</> : null}
            </Callout>
          )}
          {s.localBuild && !s.available && have.commit && (
            <p className="o-hint">This server runs a local build (deployed with changes that aren't on GitHub). Nothing newer is on GitHub.</p>
          )}
          {s.otherRepo && (
            <Callout tone="sand" title="Deployed from another repository">
              This server was deployed from <span className="d-mono">{have.repo}</span>, but updates come from <span className="d-mono">{s.repo}</span>. For a fork, set{" "}
              <span className="d-mono">KW_SELF_UPDATE_REPO</span> in keepwatch.conf and deploy.
            </Callout>
          )}
          <div className="o-switch-row">
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-medium text-[var(--o-text)]">Check automatically</div>
              <div className="o-hint">Every 6 hours, one request to GitHub. Off: only when you click “Check now”.</div>
            </div>
            <Toggle checked={s.autoCheck} disabled={busy === "auto"} onChange={(v) => void run("auto", () => setAutoCheck(v), v ? "Automatic check on." : "Automatic check off.").then(() => refreshAll())} label="Check for Keepwatch updates every 6 hours" />
          </div>
          <p className="o-hint">
            Installing an update needs a passkey. From your computer it works as before: <span className="d-mono">git pull</span>, then <span className="d-mono">./keepwatch deploy</span>.
          </p>
        </div>
      </DBody>
      <DFoot>
        <Button variant="ghost" className="mr-auto" onClick={close}>
          Close
        </Button>
        <Button variant="secondary" disabled={!!busy || r.state === "running"} onClick={() => void run("check", () => checkNow()).then(() => refreshAll())}>
          <RefreshCw className={cx("h-4 w-4", busy === "check" && "o-spin")} />
          {busy === "check" ? "Checking …" : "Check now"}
        </Button>
        {s.available && r.state !== "running" && (
          <Button variant="primary" disabled={install.busy} onClick={install.open}>
            <ArrowUpCircle className="h-4 w-4" />
            Update now
          </Button>
        )}
      </DFoot>
      {install.dialog}
    </>
  );
}
