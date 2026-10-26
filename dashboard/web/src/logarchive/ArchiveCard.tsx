import { useState } from "react";
import { api } from "../api";
import { FoldToggle, Meter } from "../common";
import { Callout, cx, Field, Pill } from "../design/ui";
import { bytes, num, plural } from "../format";
import { openLogs } from "../logs/open";
import { useAction } from "../messages";
import { DBody, SaveFoot } from "../pages/settingsUi";
import { shortDay, type ArchiveContainer, type ArchiveOverview, type ArchiveSettings } from "./api";
import "./logarchive.css";

const LIMITS = { days: [1, 90], maxPerContainerMb: [10, 50000], maxTotalMb: [50, 200000] } as const;
const ok = (v: number, [lo, hi]: readonly [number, number]) => Number.isInteger(v) && v >= lo && v <= hi;
const MB = 1_000_000;

/** State of the archive service – only when it isn't writing. */
export function archiveState(o: ArchiveOverview) {
  if (!o.installed)
    return (
      <Pill tone="neutral" title="systemd service keepwatch-log-archive; installed by ./keepwatch deploy">
        not deployed
      </Pill>
    );
  if (!o.running)
    return (
      <Pill tone="rose" title="systemctl status keepwatch-log-archive">
        stopped
      </Pill>
    );
  return null;
}

/** Row at rest: "14 days · 816 KB of 2,000 MB". */
export function ArchiveSummary({ o }: { o: ArchiveOverview }) {
  return (
    <>
      <b>{o.settings.days}</b> days · <b>{bytes(o.bytes)}</b> of {num(o.settings.maxTotalMb)} MB
    </>
  );
}

/**
 * Settings → "Log archive" (dialog): retention and limits of the archive service,
 * and every container in the archive – including removed ones (opens the logs).
 */
export function ArchiveBody({ o, reload, close }: { o: ArchiveOverview; reload: () => void; close: () => void }) {
  const { busy, run } = useAction();
  const [f, setF] = useState<ArchiveSettings>(o.settings);
  const [list, setList] = useState(false);
  const s = o.settings;
  const dirty = f.days !== s.days || f.maxPerContainerMb !== s.maxPerContainerMb || f.maxTotalMb !== s.maxTotalMb;
  const valid = ok(f.days, LIMITS.days) && ok(f.maxPerContainerMb, LIMITS.maxPerContainerMb) && ok(f.maxTotalMb, LIMITS.maxTotalMb) && f.maxTotalMb >= f.maxPerContainerMb;
  const gone = o.containers.filter((c) => c.exists === false).length;
  const stacks = new Map<string, ArchiveContainer[]>();
  for (const c of o.containers) stacks.set(c.stack, [...(stacks.get(c.stack) ?? []), c]);

  return (
    <>
      <DBody>
        <div className="d-fields is-3">
          <Num id="la-days" label="Keep" unit="days" value={f.days} lim={LIMITS.days} onChange={(days) => setF({ ...f, days })} />
          <Num id="la-je" label="Per container" unit="MB" value={f.maxPerContainerMb} lim={LIMITS.maxPerContainerMb} onChange={(maxPerContainerMb) => setF({ ...f, maxPerContainerMb })} />
          <Num id="la-ges" label="In total" unit="MB" value={f.maxTotalMb} lim={LIMITS.maxTotalMb} onChange={(maxTotalMb) => setF({ ...f, maxTotalMb })} />
        </div>
        {f.maxTotalMb < f.maxPerContainerMb && <p className="o-field-error mt-2">The total limit must be at least the limit per container.</p>}
        {o.installed && (
          <div className="d-la-meter" title={`${bytes(o.bytes)} of ${num(s.maxTotalMb)} MB used`}>
            <Meter share={o.bytes / (s.maxTotalMb * MB)} thin />
          </div>
        )}
        {o.notes.length > 0 && (
          <Callout tone="sand" className="mt-4">
            {o.notes.map((n) => (
              <div key={n}>{n}</div>
            ))}
          </Callout>
        )}
        {Object.keys(o.skipped).length > 0 && (
          <p className="o-hint mt-3">
            Not archived: {Object.entries(o.skipped).map(([n, why]) => `${n} (${why})`).join(", ")}
          </p>
        )}
        {o.containers.length > 0 ? (
          <div className="mt-5">
            <FoldToggle open={list} onToggle={() => setList((v) => !v)}>
              {plural(o.containers.length, "container", "containers")} in the archive
              <span className="d-fold-meta">
                {bytes(o.bytes)}
                {gone ? ` · ${gone} removed` : ""}
              </span>
            </FoldToggle>
            {list && (
              <div className="d-la-list !mt-2">
                {[...stacks.entries()].map(([stack, items]) => (
                  <div key={stack}>
                    <div className="d-la-stack">{stack === "no-stack" ? "No stack" : stack}</div>
                    {items.map((c) => (
                      <button key={c.key} type="button" className={cx("d-la-row", c.exists === false && "is-gone")} onClick={() => openLogs({ title: c.name, containers: [c.name] })} title="Open logs">
                        <span className="d-la-name">
                          <span>{c.name}</span>
                          {c.exists === false && <Pill tone="sand">removed</Pill>}
                          {c.dropped > 0 && <Pill tone="rose">{num(c.dropped)} dropped today</Pill>}
                          {c.trimmed && <Pill tone="sand">trimmed to {shortDay(c.trimmed)}</Pill>}
                        </span>
                        <span className="d-la-num d-la-days">
                          {shortDay(c.from)}–{shortDay(c.to)}
                        </span>
                        <span className="d-la-num">{bytes(c.bytes)}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="o-hint mt-4">{o.installed ? "Nothing archived yet." : "Installed by ./keepwatch deploy."}</p>
        )}
      </DBody>
      <SaveFoot
        dirty={dirty}
        valid={valid}
        busy={!!busy}
        onCancel={close}
        onSave={() =>
          void run("save", () => api.put("/api/logarchive/settings", f), "Log archive saved – applies within a minute.").then((done) => {
            if (done) {
              reload();
              close();
            }
          })
        }
      />
    </>
  );
}

function Num({ id, label, unit, value, lim, onChange }: { id: string; label: string; unit: string; value: number; lim: readonly [number, number]; onChange: (v: number) => void }) {
  const bad = !ok(value, lim);
  return (
    <Field label={label} htmlFor={id} aside={unit} error={bad ? `Whole number from ${num(lim[0])} to ${num(lim[1])}` : undefined}>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        className={cx("o-input d-num", bad && "is-bad")}
        value={Number.isFinite(value) ? value : ""}
        min={lim[0]}
        max={lim[1]}
        step={1}
        onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))}
      />
    </Field>
  );
}
