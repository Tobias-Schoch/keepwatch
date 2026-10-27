import { ArrowUpRight, LockKeyhole, RefreshCw, ShieldCheck, Waypoints } from "lucide-react";
import { useState } from "react";
import { api, type Poll } from "../api";
import { Button, Confirm, cx, type Tone } from "../design/ui";
import { dateTime, duration, LOCALE, num, plural } from "../format";
import { useAction, useToast } from "../messages";
import type { RenewResult, Site, Sites } from "../types";
import { AccessSheet } from "./Access";
import { UptimeDetailPanel, UptimeStrip } from "./Uptime";
import { GradeScore } from "./SiteGrade";
import { fmtUptime, type UptimeSite } from "../uptime";
import { PROXY_HOSTS_PATH, toolHref, useTool } from "../tools";

/** Above this the Proxy Manager renews on its own; below it the page offers "Renew due". */
const DUE_DAYS = 30;

function certTone(days: number | undefined): Tone {
  if (days === undefined) return "rose";
  if (days < 7) return "rose";
  if (days < 21) return "sand";
  return "ok";
}

/** A 404 on "/" is normal for some apps (e.g. only served under sub-paths) – neutral, not yellow. */
function checkTone(s: Site): Tone {
  if (!s.check) return "rose";
  const c = s.check.code;
  if (c >= 500 || c === 0) return "rose";
  if (c === 403 && s.allowlist > 0) return "ok";
  if (c >= 200 && c < 400) return "ok";
  if (c === 404) return "neutral";
  return "sand";
}

function checkLabel(s: Site): string {
  if (!s.check) return "no response";
  const c = s.check.code;
  if (c === 403 && s.allowlist > 0) return "403 blocked";
  return String(c);
}

const worst = (...t: Tone[]): Tone => (t.includes("rose") ? "rose" : t.includes("sand") ? "sand" : "ok");

function siteTone(s: Site): Tone {
  if (!s.enabled) return "neutral";
  return worst(checkTone(s), certTone(s.cert?.daysLeft));
}

const RENEW_NOTE = "Let's Encrypt allows 5 reissues per week – only needed when automatic renewal is stuck.";

const certText = (s: Site) => (s.cert ? (s.cert.daysLeft <= 0 ? "expired" : plural(s.cert.daysLeft, "day", "days")) : "no certificate");

/** What is wrong with a site – for a service header (the security grade is shown separately). Empty when all is well. */
export function siteIssues(s: Site, u: UptimeSite | null | undefined): { tone: Tone; text: string; title?: string }[] {
  if (!s.enabled) return [{ tone: "neutral", text: "off" }];
  const out: { tone: Tone; text: string; title?: string }[] = [];
  if (u?.down) out.push({ tone: "rose", text: `Down for ${duration(Date.now() / 1000 - (u.downSince ?? Date.now() / 1000))}`, title: u.downReason ?? undefined });
  const kt = checkTone(s);
  if (!u?.down && (kt === "rose" || kt === "sand")) out.push({ tone: kt, text: checkLabel(s), title: "Response on /" });
  const ct = certTone(s.cert?.daysLeft);
  if (ct !== "ok") out.push({ tone: ct, text: s.cert ? `Certificate: ${certText(s)}` : "no certificate", title: s.cert ? `Expires ${dateTime(s.cert.expiresAt)}` : undefined });
  if (!s.sslForced) out.push({ tone: "sand", text: "HTTPS not forced", title: "Also reachable unencrypted" });
  if (!u?.down && u?.uptime30 != null && u.uptime30 < 99) out.push({ tone: "sand", text: `${fmtUptime(u.uptime30)}% uptime`, title: "Uptime over the last 30 days" });
  return out;
}

/** One site in an expanded service: domain, security, problems only – uptime and access on the right. The rest is in the tooltip. */
function Row({ s, busy, onRenew, onAccess }: { s: Site; busy: string | null; onRenew: () => void; onAccess: () => void }) {
  const ct = certTone(s.cert?.daysLeft);
  const kt = checkTone(s);
  const [main, ...more] = s.domains;
  const mine = busy === `renew-${s.id}`;
  const only4xx = s.allowlist === 0 && s.requests24h > 0 && s.errors4xx24h === s.requests24h;
  const [upOpen, setUpOpen] = useState(false); // uptime expanded (Uptime.tsx)
  const err5 = s.errors5xx24h;
  const npm = useTool("proxy");
  const info = [
    `→ ${s.target}${more.length ? ` · also ${more.join(", ")}` : ""}`,
    s.cert ? `Certificate: ${certText(s)}, until ${dateTime(s.cert.expiresAt)} · ${s.cert.issuer}` : "no certificate",
    s.check ? `Check: ${checkLabel(s)} · ${num(s.check.ms)} ms` : "Check: no response",
    `24 h: ${num(s.requests24h)} requests · 4xx ${num(s.errors4xx24h)} · 5xx ${num(err5)} · blocked ${num(s.blocked24h)}${only4xx ? " · all ended in 4xx" : ""}`,
  ].join("\n");
  return (
    <>
      <div className={cx("svc-row", siteTone(s) === "rose" && "is-bad")}>
        <span className="svc-row-main">
          <a className="svc-row-name svc-link" href={`https://${main}`} target="_blank" rel="noreferrer" title={info}>
            {main} <ArrowUpRight className="inline h-3.5 w-3.5 align-[-2px] text-[var(--o-faint)]" />
          </a>
          {s.enabled ? <GradeScore id={s.id} domain={main} /> : <span className="svc-issue">disabled</span>}
          {s.enabled && (kt === "rose" || kt === "sand") && (
            <span className="svc-issue" data-tone={kt} title="Response on /">
              {checkLabel(s)}
            </span>
          )}
          {s.enabled && ct !== "ok" && (
            <>
              <span className="svc-issue" data-tone={ct} title={s.cert ? `Expires ${dateTime(s.cert.expiresAt)}` : undefined}>
                {s.cert ? `Certificate: ${certText(s)}` : "no certificate"}
              </span>
              {s.cert && (
                <Button size="sm" variant="ghost" className="d-renew" disabled={!!busy} onClick={onRenew} aria-label={`Renew certificate for ${main}`}>
                  <RefreshCw className={cx("h-3.5 w-3.5", mine && "o-spin")} />
                  {mine ? "Renewing…" : "Renew"}
                </Button>
              )}
            </>
          )}
          {s.enabled && !s.sslForced && (
            <span className="svc-issue" data-tone="sand" title="Also reachable unencrypted">
              HTTPS not forced
            </span>
          )}
          {s.enabled && err5 > 0 && (
            <span className="svc-issue" data-tone={err5 >= Math.max(5, s.requests24h * 0.01) ? "rose" : undefined} title={`${num(err5)} server errors out of ${num(s.requests24h)} requests in 24 h`}>
              {num(err5)} × 5xx
            </span>
          )}
        </span>
        <span className="svc-row-side">
          {s.enabled && <UptimeStrip domain={main} open={upOpen} onToggle={() => setUpOpen((v) => !v)} />}
          {npm && (
            <a className="svc-npm" href={toolHref(npm, PROXY_HOSTS_PATH)} target="_blank" rel="noopener" title="Open in Proxy Manager (proxy hosts)" aria-label={`Open ${main} in Proxy Manager`}>
              <Waypoints className="h-3.5 w-3.5" />
            </a>
          )}
          <button
            type="button"
            className="svc-access"
            data-on={s.allowlist > 0 || !!s.pathLock?.length || undefined}
            onClick={onAccess}
            title={s.allowlist === 0 && s.pathLock?.length ? `Manage access · ${s.pathLock.join(", ")} allow-list only` : "Manage access"}
          >
            {s.allowlist > 0 ? (
              <>
                <ShieldCheck className="h-3.5 w-3.5" /> Allow-list {s.allowlist}
              </>
            ) : s.pathLock?.length ? (
              <>
                <LockKeyhole className="h-3.5 w-3.5" /> Admin locked
              </>
            ) : (
              "public"
            )}
          </button>
        </span>
      </div>
      {upOpen && (
        <div className="svc-row-panel">
          <UptimeDetailPanel domain={main} />
        </div>
      )}
    </>
  );
}

/** Site figures for the header of the Services page. */
export function siteStats(d: Sites) {
  const on = d.sites.filter((s) => s.enabled);
  const ok = on.filter((s) => s.check && s.check.code > 0 && s.check.code < 500);
  const stuck = on.filter((s) => (s.cert?.daysLeft ?? 0) < 21);
  const due = on.filter((s) => s.cert && s.cert.daysLeft < DUE_DAYS);
  return { on, ok, stuck, due };
}

/** Container behind a site: target "container:port" → container name. */
export const siteHost = (s: Site) => s.target.replace(/:\d+$/, "");

export { siteTone };

/**
 * Site actions (renew, renew due, access) with their dialogs.
 * Render `dialogs` once on the page.
 */
export function useSiteActions(p: Poll<Sites>) {
  const [access, setAccess] = useState<number | null>(null);
  const [ask, setAsk] = useState<Site | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();

  const renew = (s: Site) =>
    void run(`renew-${s.id}`, async () => {
      const r = await api.post<RenewResult>(`/api/sites/${s.id}/renew`, { force: true });
      toast(r.message, r.renewed ? "success" : "warn", r.renewed ? undefined : "Not renewed");
    }).then(() => p.refresh());

  const renewDue = () =>
    void run("renew-due", async () => {
      const r = await api.post<{ ok: boolean; renewed: number; message: string }>("/api/sites/renew-due");
      toast(r.message, r.renewed > 0 ? "success" : "warn");
    }).then(() => p.refresh());

  const dialogs = (
    <>
      {access !== null && <AccessSheet siteId={access} onClose={() => setAccess(null)} />}
      {ask && (
        <Confirm
          icon={RefreshCw}
          copy={{
            title: `Renew the certificate for ${ask.domains[0]}?`,
            description: RENEW_NOTE,
            note: ask.cert ? `Still valid for ${plural(ask.cert.daysLeft, "day", "days")}. This can take a few minutes.` : undefined,
            confirmLabel: "Renew",
            tone: "accent",
          }}
          onClose={() => setAsk(null)}
          onConfirm={() => renew(ask)}
        />
      )}
    </>
  );
  return { busy, askRenew: setAsk, openAccess: setAccess, renewDue, dialogs };
}

/** "Renew n due" – only shown when a certificate expires in less than 30 days. */
export function RenewDueButton({ d, busy, onClick }: { d: Sites; busy: string | null; onClick: () => void }) {
  const { due, stuck } = siteStats(d);
  if (!due.length) return null;
  return (
    <Button variant={stuck.length ? "primary" : "secondary"} disabled={!!busy} onClick={onClick} title={due.map((s) => s.domains[0]).join(", ")}>
      <RefreshCw className={cx("h-4 w-4", busy === "renew-due" && "o-spin")} />
      {busy === "renew-due" ? "Renewing…" : `Renew ${due.length} due`}
    </Button>
  );
}

/** Sites of a service as quiet rows (problems first). */
export function SiteList({ sites, busy, onRenew, onAccess }: { sites: Site[]; busy: string | null; onRenew: (s: Site) => void; onAccess: (id: number) => void }) {
  const order = (s: Site) => ({ rose: 0, sand: 1 } as Record<string, number>)[siteTone(s)] ?? 2;
  return (
    <div className="svc-rows">
      {[...sites]
        .sort((a, b) => order(a) - order(b) || a.domains[0].localeCompare(b.domains[0], LOCALE))
        .map((s) => (
          <Row key={s.id} s={s} busy={busy} onRenew={() => onRenew(s)} onAccess={() => onAccess(s.id)} />
        ))}
    </div>
  );
}
