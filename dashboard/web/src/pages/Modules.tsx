import { CheckCircle2, Loader2, Lock, Power, PowerOff, XCircle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useConfig, type Config } from "../config";
import { Button, Callout, Confirm, CopyButton, cx, Pill, Toggle, type ConfirmCopy } from "../design/ui";
import { ago, nowSec } from "../format";
import { useAction } from "../messages";
import { clearModuleFocus, peekModuleFocus, RECENT, runStep, runTitle, switchModule, type ModuleInfo, type ModulesResponse, type useModules } from "../modules";
import { Elapsed, Log } from "./SelfUpdate";
import { DBody, DFoot } from "./settingsUi";
import "./modules.css";

/*
 * Settings → Modules: every module with what it does and whether it is on. The add-ons get a
 * switch (the server applies it right away, with a passkey); everything else shows the command
 * for your computer. A switch made here is an override until keepwatch.conf has it too.
 */

type Mods = ReturnType<typeof useModules>;

/** What switching off costs, for the confirmation. Security add-ons get a red one. */
const OFF: Partial<Record<string, { text: string; danger?: boolean }>> = {
  auditd: { text: "Logins, sudo and changes to SSH keys, cron and other sensitive files are no longer recorded.", danger: true },
  backup: { text: "No new backups are made from now on – data that changes after this is not protected.", danger: true },
  "auto-updates": { text: "Security updates are no longer installed by themselves – you have to run them by hand.", danger: true },
  "ban-history": { text: "Past SSH attackers are no longer banned again after a reboot." },
  lynis: { text: "The weekly hardening audit stops; the last score stays visible until then." },
  "image-scan": { text: "Container images are no longer scanned for known vulnerabilities." },
  "log-archive": { text: "Container logs are no longer archived; a recreated container loses its old logs." },
};

const overrideText = (m: ModuleInfo) =>
  `Switched ${m.override} here – not yet in keepwatch.conf; the next ./keepwatch deploy asks to take it over.`;

function confirmCopy(m: ModuleInfo, on: boolean): ConfirmCopy {
  const back = m.override && (m.override === "on") !== on; // switching an override back = keepwatch.conf again
  const note = back ? (
    <>That is what keepwatch.conf on your computer says, so nothing is left to take over.</>
  ) : (
    <>
      Only on the server: keepwatch.conf on your computer still has it {on ? "off" : "on"} – the next <span className="d-mono">./keepwatch deploy</span> asks whether to take this over.
    </>
  );
  if (on)
    return {
      title: `Switch on ${m.name}?`,
      description: <>The server sets it up now, like <span className="d-mono">./keepwatch deploy</span> would – usually within a minute or two. The dashboard may restart on the way; this page reconnects by itself.</>,
      note,
      confirmLabel: "Switch on",
      tone: "accent",
    };
  const off = OFF[m.id];
  return {
    title: `Switch off ${m.name}?`,
    description: <>{off?.text ?? "Keepwatch takes its setup off the server now."} Switching it on again sets it up again.</>,
    note,
    confirmLabel: "Switch off",
    tone: off?.danger ? "danger" : "accent",
  };
}

/** A finished switch to talk about (recent, not dismissed in this view). */
function shownRun(m: ModulesResponse | null | undefined, dismissed: number | null): "done" | "failed" | null {
  const r = m?.run;
  if (!r || (r.state !== "done" && r.state !== "failed") || !r.endedAt || r.endedAt === dismissed) return null;
  if (r.state === "done" && nowSec() - r.endedAt > RECENT) return null;
  return r.state;
}

/* ---------- Row in Settings → System ------------------------------------------------------------- */

export function modulesRowValue(mods: Mods, cfg: Config): ReactNode {
  const ids = Object.keys(cfg.modules) as (keyof Config["modules"])[];
  const on = ids.filter((k) => cfg.modules[k] !== false).length;
  const m = mods.m;
  const r = m?.run;
  if (r?.state === "running") return <>{runTitle(r)} …</>;
  return (
    <>
      <b>{on}</b> of {ids.length} on
      {m && m.overrides > 0 ? <> · {m.overrides} switched here</> : null}
      {cfg.version ? <> · Keepwatch {cfg.version}</> : null}
    </>
  );
}

export function modulesRowState(mods: Mods, fallback: boolean | undefined): ReactNode {
  const m = mods.m;
  if (m?.run.state === "running")
    return (
      <Pill tone="accent" dot>
        switching
      </Pill>
    );
  if (m?.run.state === "failed" && shownRun(m, null)) return <Pill tone="rose" dot>switch failed</Pill>;
  if (m && m.overrides > 0) return <Pill tone="sand" title="Switched in the dashboard, not yet in keepwatch.conf on your computer.">not in keepwatch.conf</Pill>;
  if (fallback) return <Pill tone="sand">not reported</Pill>;
  return null;
}

/* ---------- Dialog --------------------------------------------------------------------------------- */

export function ModulesBody({ mods, close }: { mods: Mods; close: () => void }) {
  const cfg = useConfig();
  const { busy, run } = useAction();
  const [ask, setAsk] = useState<{ m: ModuleInfo; on: boolean } | null>(null);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const m = mods.m;

  // ⌘K "Switch on Lynis audit": open that confirmation once the list is there.
  const [focus] = useState(peekModuleFocus);
  useEffect(() => {
    if (!focus || !m) return;
    clearModuleFocus();
    const it = m.modules.find((x) => x.id === focus.id);
    if (it && it.toggleable && it.enabled !== focus.enabled && !it.blocked && !m.busy) setAsk({ m: it, on: focus.enabled });
    document.getElementById(`mod-${focus.id}`)?.scrollIntoView({ block: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!m]);

  if (!m)
    return (
      <DBody>
        <p className="o-hint">{mods.error ?? "Loading …"}</p>
      </DBody>
    );

  const r = m.run;
  const running = r.state === "running";
  const endedAt = r.endedAt === null ? null : Math.min(r.endedAt, nowSec());
  const shown = shownRun(m, dismissed);
  const addons = m.modules.filter((x) => x.toggleable);
  const others = m.modules.filter((x) => !x.toggleable);
  const locked = !!busy || !!m.busy;

  const doSwitch = (it: ModuleInfo, on: boolean) =>
    void run(`mod:${it.id}`, async () => {
      await switchModule(it.id, on);
      mods.fast(true);
      await mods.refresh();
    });

  return (
    <>
      <DBody>
        <div className="flex flex-col gap-5">
          {running && (
            <Callout tone="accent" icon={Loader2} title={runTitle(r)} className="mod-run">
              {mods.error ? "The dashboard is restarting – this page reconnects by itself." : runStep(r)} · <Elapsed from={r.startedAt === null ? null : Math.floor(Math.min(r.startedAt, nowSec()))} />
              <Log lines={r.log} />
            </Callout>
          )}
          {shown === "done" && (
            <Callout tone="ok" icon={CheckCircle2} title={`${r.name ?? r.module} is ${r.action} – done ${ago(endedAt)}`} onDismiss={() => setDismissed(r.endedAt)}>
              {(() => {
                const it = m.modules.find((x) => x.id === r.module);
                return it?.override ? overrideText(it) : "The rest of the dashboard follows the new set of modules.";
              })()}
            </Callout>
          )}
          {shown === "failed" && (
            <Callout tone="rose" icon={XCircle} title={`${runTitle(r)} didn't work (${ago(endedAt)})`} onDismiss={() => setDismissed(r.endedAt)}>
              {r.error ?? "The server stopped with an error."}
              {r.rolledBack && !/switched back/i.test(r.error ?? "") && <> The previous state was put back – {r.name ?? r.module} is {r.action === "on" ? "off" : "on"} again.</>}
              {r.log.length > 0 && <pre className="su-log mod-tail">{r.log.slice(-8).join("\n")}</pre>}
              {r.log.length > 8 && <Log lines={r.log} label="Show the whole log" />}
            </Callout>
          )}
          {!running && m.busy && m.busy !== "modules" && (
            <Callout tone="sand" title={m.busy === "deploy" ? "A deploy is running on the server" : "A Keepwatch update is being installed"}>
              Switching is paused until it is done.
            </Callout>
          )}
          {!m.available && (
            <Callout tone="sand" title="Switching here needs a newer Keepwatch on the server">
              Run <span className="d-mono">./keepwatch deploy</span> once from your computer; until then the commands below do it.
            </Callout>
          )}

          {addons.length > 0 && (
            <section>
              <h3 className="d-set-subhead">Add-ons – switch here</h3>
              <ul className="d-mod-list">
                {addons.map((it) => (
                  <ModRow key={it.id} it={it} all={m.modules}>
                    {running && r.module === it.id ? (
                      <span className="mod-busy">
                        <Loader2 className="h-4 w-4 o-spin" aria-hidden /> {r.action === "on" ? "switching on" : "switching off"}
                      </span>
                    ) : (
                      <span title={it.blocked ?? undefined} className="inline-flex">
                        <Toggle
                          checked={it.enabled}
                          disabled={locked || running || !!it.blocked}
                          onChange={(on) => setAsk({ m: it, on })}
                          label={`${it.enabled ? "Switch off" : "Switch on"} ${it.name}`}
                        />
                      </span>
                    )}
                  </ModRow>
                ))}
              </ul>
              <p className="o-hint mt-2">Switching needs a passkey. The server sets the module up (or removes it) right away.</p>
            </section>
          )}

          <section>
            <h3 className="d-set-subhead">From your computer</h3>
            <p className="o-hint mb-2">
              These change how you reach or run the server. Run the command in your Keepwatch folder, then <span className="d-mono">./keepwatch deploy</span>.
            </p>
            <ul className="d-mod-list">
              {others.map((it) => (
                <ModRow key={it.id} it={it} all={m.modules} locked>
                  {it.command ? (
                    <span className="mod-cmd">
                      <code className="d-mono">{it.command.replace(/ && \.\/keepwatch deploy$/, "")}</code>
                      <CopyButton text={it.command} label={`Copy: ${it.command}`} />
                    </span>
                  ) : (
                    <Pill tone="neutral">always on</Pill>
                  )}
                </ModRow>
              ))}
            </ul>
          </section>
          {cfg.version && <p className="o-hint">Keepwatch {cfg.version}.</p>}
        </div>
      </DBody>
      <DFoot>
        <Button variant="ghost" onClick={close}>
          Close
        </Button>
      </DFoot>
      {ask && (
        <Confirm
          icon={ask.on ? Power : PowerOff}
          copy={confirmCopy(ask.m, ask.on)}
          onClose={() => setAsk(null)}
          onConfirm={() => doSwitch(ask.m, ask.on)}
        />
      )}
    </>
  );
}

function ModRow({ it, all, locked, children }: { it: ModuleInfo; all: ModuleInfo[]; locked?: boolean; children: ReactNode }) {
  const name = (id: string) => all.find((x) => x.id === id)?.name ?? id;
  const needs = it.requires.length ? `needs ${it.requires.map(name).join(", ")}` : null;
  const usedBy = it.requiredBy.length ? `needed by ${it.requiredBy.map(name).join(", ")}` : null;
  return (
    <li id={`mod-${it.id}`} className={cx("d-mod-row mod-row", !it.enabled && "is-off")}>
      <div className="min-w-0">
        <div className="d-mod-name">
          {locked && <Lock className="mod-lock" aria-label="Set up from your computer" />}
          {it.name} <span className="d-mono d-mod-id">{it.id}</span>
        </div>
        {it.summary && <div className="d-mod-sum">{it.summary}</div>}
        <div className="mod-meta">
          <Pill tone={it.enabled ? "ok" : "neutral"} dot={it.enabled}>
            {it.enabled ? "on" : "off"}
          </Pill>
          {it.override && (
            <Pill tone="sand" title={overrideText(it)}>
              switched here
            </Pill>
          )}
          {needs && <span>{needs}</span>}
          {usedBy && <span>{usedBy}</span>}
        </div>
        {it.override && <div className="mod-note">{overrideText(it)}</div>}
        {it.blocked && <div className="mod-note is-blocked">{it.blocked}</div>}
        {locked && it.why && <div className="mod-note">{it.why}</div>}
      </div>
      <div className="mod-ctl">{children}</div>
    </li>
  );
}
