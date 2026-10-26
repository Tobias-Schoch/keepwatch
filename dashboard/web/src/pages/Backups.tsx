import { Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, EVERY, usePoll } from "../api";
import { Chips, FoldToggle, Loading, PageHero, Section, Stale } from "../common";
import { Button, Callout, cx, Panel, Pill } from "../design/ui";
import { ago, agoShort, bytes, dateTime, duration, num, plural, shortDateTime, span } from "../format";
import { useAction, useToast } from "../messages";
import type { Backups } from "../types";
import { useNav } from "../nav";

type Target = Backups["targets"][number];
type Snap = Backups["snapshots"][number];

/** Does the snapshot belong to this target? The backend writes the name ("Local") or the kind ("local"). */
const sameTarget = (s: Snap, t: Target) => s.target.toLowerCase() === t.name.toLowerCase() || s.target.toLowerCase() === t.kind;

/** A run writes one snapshot per target. Snapshots of the same run (≤ 2 hr apart, one per target) become one row. */
function byRun(snaps: Snap[], targets: Target[]) {
  const rows: { time: number; tags: string[]; paths: string[]; ids: Map<string, string> }[] = [];
  for (const s of [...snaps].sort((a, b) => b.time - a.time)) {
    const t = targets.find((x) => sameTarget(s, x));
    const key = t?.name ?? s.target;
    const row = rows.find((r) => Math.abs(r.time - s.time) < 2 * 3600 && !r.ids.has(key));
    if (row) {
      row.ids.set(key, s.id);
      s.tags.forEach((tag) => !row.tags.includes(tag) && row.tags.push(tag));
    } else rows.push({ time: s.time, tags: [...s.tags], paths: s.paths, ids: new Map([[key, s.id]]) });
  }
  return rows;
}

/** Tag of a backup started by hand. */
const isManual = (tags: string[]) => tags.includes("manual");

function Targets({ b }: { b: Backups }) {
  const { go } = useNav();
  return (
    <Panel className="!py-3">
      <div className="d-table-wrap">
        <table className="d-table">
          <tbody>
            {b.targets.map((t) => (
              <tr key={t.name}>
                <td className="is-main w-[140px]" title={t.location}>
                  {t.name}
                </td>
                {t.configured ? (
                  <>
                    <td>{plural(t.snapshots, "snapshot", "snapshots")}</td>
                    <td>{bytes(t.size)}</td>
                    <td className={cx("is-right", !!t.lastSnapshot && Date.now() / 1000 - t.lastSnapshot > 26 * 3600 && "text-[var(--o-sand)]")} title={dateTime(t.lastSnapshot)}>
                      {t.lastSnapshot ? agoShort(t.lastSnapshot) : "none yet"}
                    </td>
                  </>
                ) : (
                  <td colSpan={3}>
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <Pill tone="sand" dot>
                        not set up
                      </Pill>
                      {t.kind === "remote" && (
                        <>
                          <span className="o-mute">Every snapshot sits on the same disk as the data.</span>
                          <button type="button" className="o-link" onClick={() => go("settings")}>
                            Set up off-site →
                          </button>
                        </>
                      )}
                    </span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Log({ b }: { b: Backups }) {
  const failed = b.lastRun?.ok === false;
  const [open, setOpen] = useState(b.running || failed);
  const logBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (b.running || failed) setOpen(true);
  }, [b.running, failed]);
  useEffect(() => {
    if (open && logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight;
  }, [open, b.log.length]);
  if (!b.running && b.log.length === 0) return null;
  return (
    <Panel className="mt-8 d-fold-panel">
      <FoldToggle open={open} onToggle={() => setOpen((v) => !v)}>
        {b.running ? "Log (live)" : "Log of the last run"}
        <span className="d-fold-meta">{plural(b.log.length, "line", "lines")}</span>
      </FoldToggle>
      {open && (
        <div ref={logBox} className="d-log is-short mt-3" role="log">
          {b.log.length ? (
            b.log.map((l, i) => (
              <div key={i} className={cx("d-log-line", /error|fatal|failed/i.test(l) && "is-err")}>
                <span>{l}</span>
              </div>
            ))
          ) : (
            <div className="d-log-empty">Waiting for the first output …</div>
          )}
        </div>
      )}
    </Panel>
  );
}

export function BackupsPage() {
  const [fast, setFast] = useState(false);
  const p = usePoll<Backups>("/api/backups", fast ? EVERY.backupsRunning : EVERY.backups);
  const toast = useToast();
  const { busy, run } = useAction();
  const wasRunning = useRef<boolean | null>(null);
  const running = p.data?.running ?? false;

  useEffect(() => {
    if (!p.data) return;
    setFast(p.data.running);
    if (wasRunning.current && !p.data.running) {
      const ok = p.data.lastRun?.ok;
      if (ok) toast(`Backup finished${p.data.lastRun?.durationSec ? ` in ${duration(p.data.lastRun.durationSec)}` : ""}.`);
      else toast("The backup failed – see the log for details.", "error", "Backup failed");
    }
    wasRunning.current = p.data.running;
  }, [p.data, toast]);

  const start = () =>
    void run("run", () => api.post("/api/backups/run"), "Backup started.").then((ok) => {
      if (!ok) return;
      setFast(true);
      wasRunning.current = true;
      void p.refresh();
    });

  return (
    <div className="o-wrap d-page">
      <Loading data={p.data} error={p.error}>
        {(b) => {
          const newest = b.snapshots[0];
          const last = b.lastRun;
          const external = b.targets.find((t) => t.kind === "remote");
          const rows = byRun(b.snapshots, b.targets);
          const cols = b.targets.filter((t) => t.configured || rows.some((r) => r.ids.has(t.name)));
          return (
            <>
              <PageHero
                title={running ? "Backup running." : newest ? `Last backup ${ago(newest.time).replace(/\.$/, "")}.` : "No backup yet."}
                shine={2}
                lead={
                  <Chips>
                    {running ? (
                      <Pill tone="accent" dot>
                        running for {span(Date.now() / 1000 - (last?.startedAt ?? Date.now() / 1000))}
                      </Pill>
                    ) : last ? (
                      <>
                        <Pill tone={last.ok ? "ok" : last.ok === false ? "rose" : "neutral"}>{last.ok ? "succeeded" : last.ok === false ? "failed" : "result unknown"}</Pill>
                        {last.durationSec ? <Pill tone="neutral">{duration(last.durationSec)}</Pill> : null}
                      </>
                    ) : (
                      <Pill tone="neutral">never run</Pill>
                    )}
                    {b.nextRun && <Pill tone="neutral">next {shortDateTime(b.nextRun)}</Pill>}
                    {external && !external.configured && <Pill tone="sand">no off-site copy</Pill>}
                  </Chips>
                }
                aside={
                  <div className="flex items-center gap-3">
                    <Stale error={p.error} at={p.at} />
                    <Button variant="primary" disabled={running || !!busy} onClick={start}>
                      <Play className="h-4 w-4" />
                      {running ? "Running …" : "Back up now"}
                    </Button>
                  </div>
                }
              />
              {last && last.ok === false && !running && (
                <Callout tone="rose" className="mb-6" title="The last run failed">
                  The log below shows what went wrong.
                </Callout>
              )}
              <Targets b={b} />
              <p className="o-hint mt-2" title="Run on your computer: pulls new snapshots into a repository of its own and never deletes anything there.">
                Copy to your computer: <span className="d-mono">./keepwatch backup pull &lt;folder&gt;</span>
              </p>
              <Section title="Snapshots" aside={<Pill tone="neutral">{num(rows.length)}</Pill>}>
                <Panel className="!py-3">
                  {rows.length ? (
                    <div className="d-table-wrap">
                      <table className="d-table">
                        <thead>
                          <tr>
                            <th>Time</th>
                            {cols.map((t) => (
                              <th key={t.name}>{t.name}</th>
                            ))}
                            <th className="is-right" />
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r, i) => (
                            <tr key={r.time}>
                              <td className="is-main whitespace-nowrap" title={dateTime(r.time)}>
                                {i === 0 ? ago(r.time) : dateTime(r.time)}
                              </td>
                              {cols.map((t) => (
                                <td key={t.name} className="d-mono" title={r.paths.join("\n")}>
                                  {r.ids.get(t.name)?.slice(0, 8) ?? <span className="text-[var(--o-rose)]">—</span>}
                                </td>
                              ))}
                              <td className="is-right">{isManual(r.tags) && <Pill tone="accent">manual</Pill>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="d-empty">No snapshots yet. The first backup runs tonight – or now with "Back up now".</p>
                  )}
                </Panel>
              </Section>
              <Log b={b} />
            </>
          );
        }}
      </Loading>
    </div>
  );
}
