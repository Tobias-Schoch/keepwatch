import { BellRing, Check, ExternalLink, KeyRound, Pencil, RefreshCw, Undo2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { api } from "../api";
import { has } from "../config";
import { FoldToggle } from "../common";
import { Button, Callout, cx, DialogHead, Field, IconButton, Overlay, Panel, Pill, useCloseOverlay } from "../design/ui";
import { agoShort, dateTime, plural } from "../format";
import { useAction } from "../messages";
import { EnvSheet } from "../pages/Stacks";
import { registerPalette, type PaletteCtx } from "../palette/registry";
import type { Stack, Stacks } from "../types";
import { ageText, openFindings, secretsLast, useSecrets, type SecretItem, type Secrets, type SecretType } from "./api";
import "./secrets.css";

/**
 * Secrets check (backend: server/secrets_check.py). Quiet in the normal case – one line
 * "9 checked · nothing unusual"; variables with findings are listed below, with
 * "Rotate" (instructions + the existing variables dialog) and "Acknowledge".
 * The UI never sees a value – only name, stack, finding and age. Needs the portainer module.
 */

export const SECRETS_JUMP = { sel: ".sec-title", text: "Secrets", up: ".sec" } as const;

export function SecretsCard({ className }: { className?: string }) {
  const { data, error, refresh } = useSecrets();
  const [open, setOpen] = useState(false);
  const [replace, setReplace] = useState<SecretItem | null>(null);
  const [settings, setSettings] = useState(false);
  const { busy, run } = useAction();
  if (!data) return error ? <Panel className={cx("sec", className)}><Head sub={<span className="sec-warn">{error}</span>} /></Panel> : null;

  const flagged = data.items.filter((i) => openFindings(i).length > 0);
  const ack = (i: SecretItem, undo = false) =>
    void run(`ack:${i.id}`, () => api.post("/api/secrets/ack", { stackId: i.stackId, name: i.name, undo }), undo ? undefined : `${i.name} acknowledged.`).then((ok) => ok && void refresh());
  const check = () => void run("check", () => api.post("/api/secrets/check", {})).then(() => void refresh());

  return (
    <Panel className={cx("sec", flagged.length > 0 && "is-flagged", className)}>
      <Head
        sub={<Summary d={data} flagged={flagged.length} />}
        aside={
          <>
            {data.items.length > 0 && (
              <FoldToggle open={open} onToggle={() => setOpen((v) => !v)} className="sec-fold">
                All
              </FoldToggle>
            )}
            <IconButton label="Reminder settings" size="sm" onClick={() => setSettings(true)}>
              <BellRing className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton label={data.checking ? "Checking …" : "Check now"} size="sm" onClick={check} disabled={data.checking || busy === "check"}>
              <RefreshCw className={cx("h-3.5 w-3.5", data.checking && "o-spin")} />
            </IconButton>
          </>
        }
      />
      {flagged.length > 0 && (
        <div className="sec-list is-flagged">
          {flagged.map((i) => (
            <Row key={i.id} i={i} busy={busy} onReplace={() => setReplace(i)} onAck={() => ack(i)} />
          ))}
        </div>
      )}
      {open && (
        <div className="sec-list">
          {data.items
            .filter((i) => openFindings(i).length === 0)
            .map((i) => (
              <Row key={i.id} i={i} busy={busy} quiet onReplace={() => setReplace(i)} onUndo={i.acked ? () => ack(i, true) : undefined} />
            ))}
        </div>
      )}
      {replace && <ReplaceDialog item={replace} type={data.types.find((t) => t.id === replace.type)} onClose={() => setReplace(null)} />}
      {settings && <SettingsDialog d={data} onClose={() => setSettings(false)} onSaved={() => void refresh()} />}
    </Panel>
  );
}

function Head({ sub, aside }: { sub: ReactNode; aside?: ReactNode }) {
  return (
    <div className="sec-head">
      <span className="sec-icon">
        <KeyRound className="h-4 w-4" strokeWidth={1.8} />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="sec-title">Secrets</h3>
        <div className="sec-sub">{sub}</div>
      </div>
      {aside && <div className="sec-aside">{aside}</div>}
    </div>
  );
}

function Summary({ d, flagged }: { d: Secrets; flagged: number }) {
  if (d.portainer === false) return <span className="sec-warn">{d.error ?? "Portainer not connected"}</span>;
  if (d.checkedAt === null) return <>{d.checking ? "First check running …" : "Not checked yet."}</>;
  const oldest = d.items.reduce<SecretItem | null>((a, i) => (!a || i.since < a.since ? i : a), null);
  return (
    <>
      {flagged > 0 ? <b className="sec-loud">{flagged} flagged</b> : "nothing unusual"}
      {" · "}
      {plural(d.counts.secrets, "secret", "secrets")} in {plural(new Set(d.items.map((i) => i.stackId)).size, "stack", "stacks")}
      {flagged === 0 && oldest && <span className="sec-dim"> · oldest {ageText(oldest)}</span>}
      <span className="sec-dim"> · {agoShort(d.checkedAt)}</span>
    </>
  );
}

function Row({ i, busy, quiet, onReplace, onAck, onUndo }: { i: SecretItem; busy: string | null; quiet?: boolean; onReplace: () => void; onAck?: () => void; onUndo?: () => void }) {
  const open = openFindings(i);
  const notes = i.findings.filter((f) => f.level === "info");
  return (
    <div className={cx("sec-row", quiet && "is-quiet")}>
      <span className="sec-name" title={`${i.name} · ${i.typeLabel}`}>
        {i.name}
      </span>
      <span className="sec-stack" title={i.production ? "Production" : "Not a production stack"}>
        {i.stack}
      </span>
      <span className="sec-find">
        {open.map((f) => (
          <Pill key={f.kind} tone={f.kind === "due" ? "sand" : "rose"}>
            {f.text}
          </Pill>
        ))}
        {open.length === 0 && (
          <span className="sec-note" title={notes.map((f) => f.text).join("\n") || undefined}>
            {i.acked ? "acknowledged" : notes.length ? notes[0].text : i.typeLabel}
          </span>
        )}
      </span>
      <span
        className="sec-age"
        title={i.estimated ? `Unchanged since ${dateTime(i.since)} at the latest (when the stack was created – the check knows exactly only after the first change)` : `Unchanged since ${dateTime(i.since)}`}
      >
        {ageText(i)}
      </span>
      <span className="sec-acts">
        {quiet ? (
          <IconButton label="Rotate" size="sm" onClick={onReplace}>
            <Pencil className="h-3.5 w-3.5" />
          </IconButton>
        ) : (
          <Button size="sm" variant="secondary" onClick={onReplace}>
            Rotate
          </Button>
        )}
        {onAck && (
          <IconButton label="Acknowledge (until the next change)" size="sm" disabled={!!busy} onClick={onAck}>
            <Check className="h-3.5 w-3.5" />
          </IconButton>
        )}
        {onUndo && (
          <IconButton label="Undo acknowledge" size="sm" disabled={!!busy} onClick={onUndo}>
            <Undo2 className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </span>
    </div>
  );
}

/* ---------- Rotate: where to create a new one, then the existing variables dialog ------------- */

export function ReplaceDialog({ item, type, onClose }: { item: SecretItem; type?: SecretType; onClose: () => void }) {
  const [env, setEnv] = useState<{ s: Stack; canEdit: boolean } | null>(null);
  if (env) return <EnvSheet s={env.s} canEdit={env.canEdit} focus={item.name} onClose={onClose} />;
  return (
    <Overlay onClose={onClose} label={`Rotate ${item.name}`} size="md">
      <ReplaceBody item={item} type={type} onEnv={setEnv} />
    </Overlay>
  );
}

function ReplaceBody({ item, type, onEnv }: { item: SecretItem; type?: SecretType; onEnv: (e: { s: Stack; canEdit: boolean }) => void }) {
  const close = useCloseOverlay();
  const { busy, run } = useAction();
  const [err, setErr] = useState<string | null>(null);
  const open = openFindings(item);
  const next = () =>
    void run("env", async () => {
      const st = await api.get<Stacks>("/api/stacks");
      const s = st.stacks.find((x) => x.id === item.stackId);
      if (!s) {
        setErr(`Stack ${item.stack} no longer exists in Portainer.`);
        return;
      }
      onEnv({ s, canEdit: st.portainer.connected });
    });
  return (
    <>
      <DialogHead icon={KeyRound} title={`Rotate ${item.name}`} sub={<>Stack <b>{item.stack}</b> · {item.typeLabel} · unchanged for {ageText(item)}</>} />
      <div className="o-dialog-scroll">
        <div className="o-dialog-body sec-guide">
          {open.length > 0 && (
            <div className="sec-find mb-4">
              {open.map((f) => (
                <Pill key={f.kind} tone={f.kind === "due" ? "sand" : "rose"}>
                  {f.text}
                </Pill>
              ))}
            </div>
          )}
          {type && (
            <>
              <div className="sec-step">
                <span className="sec-num">1</span>
                <div className="min-w-0 flex-1">
                  <div className="sec-where">{type.where}</div>
                  {type.url && (
                    <a className="sec-link" href={type.url} target="_blank" rel="noreferrer noopener">
                      {type.url.replace(/^https:\/\//, "")} <ExternalLink className="inline h-3 w-3" />
                    </a>
                  )}
                </div>
              </div>
              <div className="sec-step">
                <span className="sec-num">2</span>
                <ul className="sec-steps">
                  {type.steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </div>
            </>
          )}
          {err && (
            <Callout tone="rose" className="mt-3">
              {err}
            </Callout>
          )}
        </div>
      </div>
      <div className="o-dialog-foot">
        <Button variant="ghost" onClick={() => close()}>
          Close
        </Button>
        <Button variant="primary" disabled={!!busy} onClick={next} data-autofocus>
          {busy ? <RefreshCw className="h-4 w-4 o-spin" /> : <Pencil className="h-4 w-4" />}
          Enter new value
        </Button>
      </div>
    </>
  );
}

/* ---------- Reminders: max age per type ----------------------------------------------------- */

function SettingsDialog({ d, onClose, onSaved }: { d: Secrets; onClose: () => void; onSaved: () => void }) {
  return (
    <Overlay onClose={onClose} label="Reminders" size="md">
      <SettingsBody d={d} onSaved={onSaved} />
    </Overlay>
  );
}

function SettingsBody({ d, onSaved }: { d: Secrets; onSaved: () => void }) {
  const close = useCloseOverlay();
  const { busy, run } = useAction();
  const [f, setF] = useState<Record<string, number>>(() => Object.fromEntries(d.types.map((t) => [t.id, t.maxAgeDays])));
  const [more, setMore] = useState(false);
  const used = useMemo(() => new Set(d.items.map((i) => i.type)), [d.items]);
  const shown = d.types.filter((t) => used.has(t.id));
  const rest = d.types.filter((t) => !used.has(t.id));
  const bad = Object.values(f).some((v) => !Number.isInteger(v) || v < 0 || v > 3650);
  const dirty = d.types.some((t) => f[t.id] !== t.maxAgeDays);
  const field = (t: SecretType) => (
    <Field key={t.id} label={t.label} htmlFor={`sec-${t.id}`} aside={f[t.id] === 0 ? "off" : "days"} hint={f[t.id] !== t.defaultDays ? `Default: ${t.defaultDays || "off"}` : undefined}>
      <input
        id={`sec-${t.id}`}
        type="number"
        inputMode="numeric"
        min={0}
        max={3650}
        step={1}
        className={cx("o-input", (!Number.isInteger(f[t.id]) || f[t.id] < 0 || f[t.id] > 3650) && "is-bad")}
        value={Number.isFinite(f[t.id]) ? f[t.id] : ""}
        onChange={(e) => setF({ ...f, [t.id]: e.target.value === "" ? NaN : Number(e.target.value) })}
      />
    </Field>
  );
  return (
    <>
      <DialogHead icon={BellRing} title="Reminders" sub="After this many days without a change, the check flags the secret. 0 = never." />
      <div className="o-dialog-scroll">
        <div className="o-dialog-body">
          <div className="sec-fields">{shown.map(field)}</div>
          {rest.length > 0 && (
            <div className="mt-4">
              <FoldToggle open={more} onToggle={() => setMore((v) => !v)}>
                {plural(rest.length, "more type", "more types")}
              </FoldToggle>
              {more && <div className="sec-fields mt-3">{rest.map(field)}</div>}
            </div>
          )}
        </div>
      </div>
      <div className="o-dialog-foot">
        <Button variant="ghost" onClick={() => close()}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!dirty || bad || !!busy}
          onClick={() =>
            void run("save", () => api.put("/api/secrets/settings", { maxAgeDays: f }), "Reminders saved.").then((ok) => {
              if (ok) {
                onSaved();
                close();
              }
            })
          }
        >
          Save
        </Button>
      </div>
    </>
  );
}

/* ⌘K */
registerPalette(() => {
  if (!has("portainer")) return [];
  const d = secretsLast();
  const flagged = (d?.items ?? []).filter((i) => openFindings(i).length > 0);
  return [
    {
      id: "sec:open",
      group: "pages" as const,
      title: "Secrets",
      hint: flagged.length ? `${flagged.length} flagged` : "Security",
      keywords: "secrets password token api key environment variables env rotate replace stripe resend",
      icon: KeyRound,
      rank: flagged.length ? 3 : -1,
      run: (ctx: PaletteCtx) => ctx.jump("security", SECRETS_JUMP),
    },
    ...(d?.items ?? []).map((i) => ({
      id: `sec:${i.id}`,
      group: "actions" as const,
      title: `Rotate ${i.name}`,
      hint: `${i.stack}${openFindings(i).length ? ` · ${openFindings(i)[0].text}` : ""}`,
      keywords: `secret rotate replace ${i.typeLabel} ${i.stack}`,
      icon: KeyRound,
      mono: true,
      rank: openFindings(i).length ? 2 : -2,
      run: (ctx: PaletteCtx) => ctx.dialog((close) => <ReplaceDialog item={i} type={d?.types.find((t) => t.id === i.type)} onClose={close} />),
    })),
  ];
});
