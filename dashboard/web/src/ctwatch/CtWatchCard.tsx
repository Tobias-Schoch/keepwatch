import { Check, ExternalLink, FileBadge, RefreshCw, Undo2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api } from "../api";
import { FoldToggle } from "../common";
import { Button, cx, IconButton, Panel, Pill } from "../design/ui";
import { has } from "../config";
import { agoShort, fmtDate, plural } from "../format";
import { useAction } from "../messages";
import { registerPalette, type PaletteCtx } from "../palette/registry";
import { certLabel, ctLast, OWN_LABEL, useCtWatch, type CtCert, type CtWatch } from "./api";
import "./ctwatch.css";

/**
 * Certificate watch (backend: server/ctwatch.py). Quiet normally – one line
 * "27 certificates · all from this server"; loud only when a foreign one shows up.
 * Self-contained: fetches its own data, needs no props. Renders nothing without the proxy module.
 */

const day = (t: number | null) => (t ? fmtDate(t, { day: "numeric", month: "short", year: "numeric" }) : "—");

export const CT_JUMP = { sel: ".ctw-title", text: "Certificates", up: ".ctw" } as const;

export function CtWatchCard({ className }: { className?: string }) {
  const { data, error, refresh } = useCtWatch();
  const [open, setOpen] = useState(false);
  const { busy, run } = useAction();
  if (!data) return error ? <Panel className={cx("ctw", className)}><Head sub={<span className="ctw-err">{error}</span>} /></Panel> : null;

  const alerts = data.certs.filter((c) => c.alert);
  const quiet = data.certs.filter((c) => !c.own && !c.known && !c.alert);
  const act = (key: string, body: object, msg?: string) => void run(key, () => api.post<{ message: string }>("/api/ctwatch/known", body), msg).then((ok) => ok && void refresh());
  const check = () => void run("check", () => api.post("/api/ctwatch/check", {})).then(() => void refresh());

  return (
    <Panel className={cx("ctw", alerts.length > 0 && "is-alert", className)} tone={alerts.length ? "danger" : undefined}>
      <Head
        sub={<Summary d={data} quiet={quiet.length} />}
        aside={
          <>
            {data.certs.length > 0 && (
              <FoldToggle open={open} onToggle={() => setOpen((v) => !v)} className="ctw-fold">
                List
              </FoldToggle>
            )}
            <IconButton label={data.checking ? "Checking…" : "Check now"} size="sm" onClick={check} disabled={data.checking || busy === "check"}>
              <RefreshCw className={cx("h-3.5 w-3.5", data.checking && "o-spin")} />
            </IconButton>
          </>
        }
      />
      {alerts.length > 0 && (
        <div className="ctw-list is-alerts">
          {alerts.map((c) => (
            <Row key={c.key} c={c} busy={busy} onKnown={() => act(c.key, { keys: [c.key] }, `${certLabel(c)} marked as known.`)} />
          ))}
        </div>
      )}
      {open && (
        <div className="ctw-list">
          {quiet.length > 1 && (
            <div className="ctw-bulk">
              <span>{plural(quiet.length, "unknown certificate", "unknown certificates")} from before the first run</span>
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act("all", { all: "baseline" })}>
                <Check className="h-3.5 w-3.5" /> Mark all known
              </Button>
            </div>
          )}
          {data.certs
            .filter((c) => !c.alert)
            .map((c) => (
              <Row
                key={c.key}
                c={c}
                busy={busy}
                onKnown={() => act(c.key, { keys: [c.key] })}
                onUndo={() => act(c.key, { keys: [c.key], undo: true })}
              />
            ))}
        </div>
      )}
    </Panel>
  );
}

function Head({ sub, aside }: { sub: ReactNode; aside?: ReactNode }) {
  return (
    <div className="ctw-head">
      <span className="ctw-icon">
        <FileBadge className="h-4 w-4" strokeWidth={1.8} />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="ctw-title">Certificates</h3>
        <div className="ctw-sub">{sub}</div>
      </div>
      {aside && <div className="ctw-aside">{aside}</div>}
    </div>
  );
}

function Summary({ d, quiet }: { d: CtWatch; quiet: number }) {
  const n = d.counts;
  if (d.checkedAt === null) return <>{d.checking ? "First look at the CT logs…" : "Not checked yet."}</>;
  return (
    <>
      {n.alerts > 0 ? (
        <b className="ctw-loud">{n.alerts === 1 ? "One foreign certificate" : `${n.alerts} foreign certificates`}</b>
      ) : (
        <>
          {plural(n.total, "certificate", "certificates")} in the CT logs · {n.unknown === 0 ? "all from this server" : `${n.own} from this server`}
        </>
      )}
      {quiet > 0 && n.alerts === 0 && <> · {quiet} older, unknown</>}
      <span className="ctw-dim" title={d.bases.join(", ")}>
        {" "}
        · {agoShort(d.checkedAt)}
      </span>
      {d.error && (
        <span className="ctw-err" title={d.error}>
          {" "}
          · lookup failing
        </span>
      )}
    </>
  );
}

function Row({ c, busy, onKnown, onUndo }: { c: CtCert; busy: string | null; onKnown: () => void; onUndo?: () => void }) {
  return (
    <div className={cx("ctw-row", c.alert && "is-alert", (c.own || c.known) && "is-quiet", c.expired && "is-expired")}>
      <span className="ctw-name" title={c.names.join("\n")}>
        {certLabel(c)}
      </span>
      <span className="ctw-issuer" title={c.issuerCn ? `${c.issuer} · ${c.issuerCn}` : (c.issuer ?? "")}>
        {c.issuer ?? "?"}
      </span>
      <span className="ctw-date" title={c.notAfter ? `valid until ${day(c.notAfter)}` : undefined}>
        {day(c.notBefore)}
      </span>
      <span className="ctw-own">
        {c.own ? (
          <span className="ctw-yes" title={c.ownNote ?? (c.ownBy ? OWN_LABEL[c.ownBy] : "")}>
            Server
          </span>
        ) : c.known ? (
          <Pill tone="neutral">known</Pill>
        ) : (
          <Pill tone={c.alert ? "rose" : "sand"}>foreign</Pill>
        )}
      </span>
      <span className="ctw-acts">
        <a className="o-icon-btn is-sm" href={c.crtsh} target="_blank" rel="noreferrer noopener" title="View on crt.sh" aria-label="View on crt.sh">
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
        {!c.own && !c.known && (
          <Button size="sm" variant={c.alert ? "secondary" : "ghost"} disabled={!!busy} onClick={onKnown}>
            Known
          </Button>
        )}
        {c.known && onUndo && (
          <IconButton label="Mark as unknown again" size="sm" disabled={!!busy} onClick={onUndo}>
            <Undo2 className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </span>
    </div>
  );
}

/* ⌘K */
registerPalette(() => {
  if (!has("proxy")) return [];
  const d = ctLast();
  const go = (ctx: PaletteCtx) => ctx.jump("security", CT_JUMP);
  return [
    {
      id: "ctw:open",
      group: "pages" as const,
      title: "Certificate watch",
      hint: d?.counts.alerts ? `${d.counts.alerts} foreign` : "Security",
      keywords: "certificates ct certificate transparency crt.sh phishing foreign dns takeover watch tls ssl",
      icon: FileBadge,
      rank: d?.counts.alerts ? 3 : -1,
      run: go,
    },
    ...(d?.certs ?? [])
      .filter((c) => c.alert)
      .map((c) => ({
        id: `ctw:${c.key}`,
        group: "actions" as const,
        title: `Foreign certificate: ${certLabel(c)}`,
        hint: `${c.issuer ?? "?"} · ${day(c.notBefore)}`,
        keywords: `certificate foreign ${c.names.join(" ")}`,
        icon: FileBadge,
        rank: 4,
        run: go,
      })),
  ];
});
