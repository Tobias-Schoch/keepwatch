import { Ban, ChevronDown, ExternalLink, Fingerprint, Globe2, LogIn, Network, RefreshCw, Send, ShieldCheck, Unlock } from "lucide-react";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, EVERY, usePoll } from "../api";
import { has } from "../config";
import { HourBars } from "../charts";
import { Chips, compare, Country, FoldToggle, ipKey, Loading, Meter, PageHero, Section, SortTh, Stale, useSort, type SortState } from "../common";
import { Button, Confirm, CopyButton, cx, Panel, Pill, Segmented } from "../design/ui";
import { agoShort, countryName, dayDate, num, plural, shortDateTime } from "../format";
import { useAction } from "../messages";
import { registerPalette, type PaletteCtx } from "../palette/registry";
import { on, type BanKind, type CountryCount, type LoginIps, type Security, type SecurityHistory } from "../types";
import "./security.css";
import { CtWatchCard } from "../ctwatch/CtWatchCard";
import { SecretsCard } from "../secrets/SecretsCard";
import { LYNIS_STALE, lynisLast, useLynis, type Lynis, type LynisFinding } from "../lynis/api";

type HistRange = "24h" | "7" | "30" | "90" | "0";
const RANGE_LABEL: Record<HistRange, string> = { "24h": "24 hr", "7": "7 days", "30": "30 days", "90": "90 days", "0": "all time" };
const RANGES: { id: HistRange; label: string }[] = [
  { id: "24h", label: "24 hr" },
  { id: "7", label: "7 d" },
  { id: "30", label: "30 d" },
  { id: "90", label: "90 d" },
  { id: "0", label: "All" },
];

/** Start of the range (Unix) or null for "All". History days start at midnight in the server's timezone; n × 24 hr is close enough. */
function rangeStart(r: HistRange): number | null {
  const now = Date.now() / 1000;
  return r === "0" ? null : r === "24h" ? now - 86400 : now - Number(r) * 86400;
}

const isKey = (method: string) => method.startsWith("publickey");
const methodLabel = (m: string) => (isKey(m) ? "key" : m);
const isTailnet = (c: { name: string } | null | undefined) => c?.name === "Tailnet";
/** Internal networks as the IP lookup names them. */
const isInternal = (c: { name: string }) => c.name === "internal";
/**
 * Outside the tailnet and internal networks = foreign. Only meaningful once port 22 is closed to the
 * internet (firewall + tailscale): while it is open, logins from the internet are normal.
 */
const isForeign = (i: { tailnet: boolean; country: { name: string } }) => has("tailscale") && !i.tailnet && !isInternal(i.country);
const recent = (t: number) => Date.now() / 1000 - t < 7 * 86400;

/* ---------- Entry via ⌘K: expand a row or pick a tab ------------------------------------------- */

type FactId = "logins" | "bans" | "ports" | "files" | "hardening";
/** "hardening:KRNL-6000" expands hardening and shows that recommendation. */
type Target = FactId | "senders" | "countries" | `hardening:${string}`;
type Req = { k: Target; n: number };

let pending: Req | null = null;
let reqSeq = 0;
const listeners = new Set<(r: Req) => void>();
function requestOpen(k: Target) {
  const r = { k, n: ++reqSeq };
  pending = r;
  listeners.forEach((f) => f(r));
}

/** Last request from the palette; the page shows the target, scrolls to it and flashes it briefly. */
function useOpenRequest() {
  const [req, setReq] = useState<Req | null>(pending);
  useEffect(() => {
    listeners.add(setReq);
    return () => void listeners.delete(setReq);
  }, []);
  useEffect(() => {
    if (!req) return;
    pending = null;
    let tries = 0;
    let timer = 0;
    const look = () => {
      const el = document.getElementById(`s-${req.k === "countries" ? "senders" : req.k}`);
      if (!el) {
        if (++tries < 40) timer = window.setTimeout(look, 100);
        return;
      }
      el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      el.classList.remove("d-flash");
      void el.offsetWidth;
      el.classList.add("d-flash");
      timer = window.setTimeout(() => el.classList.remove("d-flash"), 2000);
    };
    timer = window.setTimeout(look, 60);
    return () => clearTimeout(timer);
  }, [req]);
  return req;
}

const PALETTE: { k: Target; title: string; keywords: string; icon: typeof Ban; module?: Parameters<typeof has>[0] }[] = [
  { k: "logins", title: "Logins (SSH)", keywords: "login ssh tailscale access who root key", icon: LogIn },
  { k: "bans", title: "Banned addresses", keywords: "fail2ban ban jail unban ban history", icon: Ban, module: "fail2ban" },
  { k: "senders", title: "Top attackers", keywords: "attackers ip addresses attempts senders", icon: Send },
  { k: "countries", title: "Attacks by country", keywords: "country countries origin geo", icon: Globe2 },
  { k: "ports", title: "Open ports", keywords: "attack surface firewall docker lock listening", icon: Network },
  { k: "files", title: "File changes (auditd)", keywords: "audit accounts sudo passwd cron services", icon: Fingerprint, module: "auditd" },
  { k: "hardening", title: "Hardening (Lynis)", keywords: "lynis hardening index recommendations cisofy audit sysctl check now", icon: ShieldCheck, module: "lynis" },
];

registerPalette(() =>
  PALETTE.filter((p) => !p.module || has(p.module)).map((p) => ({
    id: `sec:${p.k}`,
    group: "pages" as const,
    title: p.title,
    hint: "Security",
    keywords: `security ${p.keywords}`,
    icon: p.icon,
    rank: -1,
    run: (ctx: PaletteCtx) => {
      ctx.go("security");
      requestOpen(p.k);
    },
  })),
);

// Open hardening recommendations one by one (state of the last fetch).
registerPalette(() =>
  (lynisLast()?.findings ?? [])
    .filter((f) => f.open)
    .map((f) => ({
      id: `sec:lynis:${f.id}`,
      group: "pages" as const,
      title: f.title,
      hint: `Hardening · ${f.id}`,
      keywords: `security hardening lynis ${f.id} ${f.items.map((i) => i.label).join(" ")}`,
      icon: ShieldCheck,
      rank: f.kind === "warning" ? 3 : -2,
      run: (ctx: PaletteCtx) => {
        ctx.go("security");
        requestOpen(`hardening:${f.id}`);
      },
    })),
);

/* ---------- Fact row: one line of summary, details behind a click -------------------------------- */

function useFold(id: FactId, auto: boolean, req: Req | null) {
  const [v, setV] = useState<boolean | null>(null);
  useEffect(() => {
    if (req?.k === id || req?.k.startsWith(`${id}:`)) setV(true);
  }, [req, id]);
  return [v ?? auto, () => setV((x) => !(x ?? auto))] as const;
}

function Fact({
  id,
  label,
  summary,
  status,
  tone,
  open,
  onToggle,
  children,
}: {
  id: FactId;
  label: string;
  summary: ReactNode;
  status?: ReactNode;
  tone?: "rose" | "sand";
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className={cx("s-fact", open && "is-open")} id={`s-${id}`} data-tone={tone}>
      <button type="button" className="s-fact-row" onClick={onToggle} aria-expanded={open}>
        <span className="s-fact-label">{label}</span>
        <span className="s-fact-sum">{summary}</span>
        <span className="s-fact-status">{status}</span>
        <ChevronDown className={cx("o-chev s-fact-chev h-4 w-4", open && "is-open")} />
      </button>
      {open && <div className="s-fact-body">{children}</div>}
    </div>
  );
}

/* ---------- Logins: per address; once port 22 is closed, only what came since counts ------------- */

const LOGIN_KEYS = ["ip", "country", "users", "count", "last"] as const;
type LoginKey = (typeof LOGIN_KEYS)[number];
type LoginRow = LoginIps["ips"][number];

function LoginTable({ rows, sort, onSort, countOf, countTitle, quiet, flag }: { rows: LoginRow[]; sort: SortState<LoginKey>; onSort: (k: LoginKey, d: "asc" | "desc") => void; countOf: (i: LoginRow) => number; countTitle: string; quiet?: boolean; flag?: boolean }) {
  const th = (k: LoginKey, label: string, right?: boolean, first: "asc" | "desc" = "desc") => (
    <SortTh k={k} sort={sort} onSort={onSort} right={right} first={first}>
      {label}
    </SortTh>
  );
  return (
    <div className="d-table-wrap">
      <table className="d-table s-narrow">
        <thead>
          <tr>
            {th("ip", "Address", false, "asc")}
            {th("country", "Country", false, "asc")}
            {th("users", "User", false, "asc")}
            {th("count", "Count", true)}
            {th("last", "Last", true)}
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => {
            // Keys are normal and stay quiet; anything else (password …) stands out.
            const odd = [...new Set(i.methods.filter((m) => !isKey(m)).map(methodLabel))];
            return (
              <tr key={i.ip} className={cx(quiet ? "is-dim" : flag && isForeign(i) && (recent(i.last) ? "is-foreign" : "is-foreign-old"))}>
                <td className="is-main">
                  <span className="inline-flex items-center gap-1">
                    <span className="d-mono">{i.ip}</span>
                    <CopyButton text={i.ip} label="Copy address" />
                  </span>
                </td>
                <td>
                  <Country c={i.country} />
                </td>
                <td title={`Method: ${[...new Set(i.methods.map(methodLabel))].join(", ")}`}>
                  <span className="inline-flex flex-wrap items-center gap-1">
                    {i.users.join(", ")}
                    {odd.map((m) => (
                      <Pill key={m} tone="sand">
                        {m}
                      </Pill>
                    ))}
                  </span>
                </td>
                <td className="is-right" title={countTitle}>
                  {num(countOf(i))}
                </td>
                <td className="is-right whitespace-nowrap" title={`First seen ${shortDateTime(i.first)}`}>
                  {shortDateTime(i.last)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Logins({ d, error, range, req }: { d: LoginIps | null; error: string | null; range: HistRange; req: Req | null }) {
  const [sort, onSort] = useSort<LoginKey>("logins", { key: "last", dir: "desc" }, LOGIN_KEYS);
  const [all, setAll] = useState(false);
  const [older, setOlder] = useState(false);
  const since = d?.since ?? null;
  const from = since ?? rangeStart(range);
  const countOf = (i: LoginRow) => (since !== null ? (i.countSince ?? 0) : i.count);
  const val = (i: LoginRow, k: LoginKey): string | number => {
    switch (k) {
      case "ip":
        return ipKey(i.ip);
      case "country":
        return i.tailnet ? " Tailnet" : countryName(i.country.cc, i.country.name);
      case "users":
        return i.users.join(", ");
      case "count":
        return countOf(i);
      default:
        return i[k];
    }
  };
  const sorted = d ? [...d.ips].sort((a, b) => compare(val(a, sort.key), val(b, sort.key), sort.dir) || b.last - a.last) : [];
  const rows = sorted.filter((i) => from === null || i.last >= from);
  const earlier = since !== null ? sorted.filter((i) => i.last < since) : [];
  // Port 22 closed: a login from outside the tailnet is an alarm. Open: just information.
  const closed = since !== null && has("firewall");
  const outside = rows.filter(isForeign);
  const foreign = closed ? outside : [];
  // Foreign in the last 24 hr: red; in the last 7 days: sand; older: just mentioned.
  const hot = foreign.some((f) => recent(f.last));
  const fresh = foreign.some((f) => Date.now() / 1000 - f.last < 86400);
  const [open, toggle] = useFold("logins", hot, req);

  const summary = !d
    ? (error ?? "Loading …")
    : since !== null
      ? plural(rows.length, "address", "addresses")
      : `${plural(rows.length, "address", "addresses")} · ${RANGE_LABEL[range]}`;
  const status = !d
    ? null
    : outside.length
      ? `${num(outside.length)} outside the tailnet`
      : !d.complete
        ? "reading …"
        : rows.length && has("tailscale") && rows.every((i) => i.tailnet || isInternal(i.country))
          ? "all from the tailnet"
          : null;

  return (
    <Fact id="logins" label="Logins" summary={summary} status={status} tone={fresh ? "rose" : hot ? "sand" : undefined} open={open} onToggle={toggle}>
      {!d ? null : rows.length === 0 ? (
        <p className="d-empty">{!d.complete ? "Still reading the journal …" : since !== null ? "No successful login since then." : "No successful logins in this period."}</p>
      ) : (
        <>
          <LoginTable rows={all ? rows : rows.slice(0, 10)} sort={sort} onSort={onSort} countOf={countOf} countTitle={since !== null ? "Logins since port 22 was closed" : "Logins since the journal began"} flag={closed} />
          {rows.length > 10 && (
            <FoldToggle open={all} onToggle={() => setAll((v) => !v)} className="mt-1">
              {all ? "Show less" : `Show all ${num(rows.length)}`}
            </FoldToggle>
          )}
        </>
      )}
      {earlier.length > 0 && (
        <>
          <FoldToggle open={older} onToggle={() => setOlder((v) => !v)} className="mt-1">
            earlier ({num(earlier.length)})<span className="d-fold-meta">while port 22 was still open</span>
          </FoldToggle>
          {older && <LoginTable rows={earlier} sort={sort} onSort={onSort} countOf={(i) => i.count - (i.countSince ?? 0)} countTitle="Logins before port 22 was closed" quiet />}
        </>
      )}
    </Fact>
  );
}

/* ---------- Banned addresses (fail2ban, ban history) ---------------------------------------------- */

function Bans({ s, refresh, req }: { s: Security; refresh: () => Promise<void>; req: Req | null }) {
  const { busy, run } = useAction();
  const [ask, setAsk] = useState<Security["bans"][number] | null>(null);
  const [open, toggle] = useFold("bans", false, req);
  const jails = s.jails ?? [];
  // fail2ban sometimes reports the same ban twice – show each address and jail once.
  const active = [...new Map((s.bans ?? []).filter((b) => b.active).map((b) => [`${b.ip}|${b.jail}`, b])).values()];
  const past = has("ban-history") ? on(s.pastAttackers) : null;
  const alt = past?.active && past.banned > 0 ? past : null;
  const jailTip = jails.map((j) => `${j.name}: ${j.currentlyBanned} banned (since start ${num(j.totalFailed)} failed attempts, ${num(j.totalBanned)} bans)`).join("\n");
  const altTip = alt ? `Banned again from history: past SSH attackers, each for a while after its last attempt${alt.until ? ` · until ${shortDateTime(alt.until)}` : ""} · ${num(alt.dropped)} packets dropped` : "";

  return (
    <Fact
      id="bans"
      label="Banned addresses"
      summary={
        <>
          <span title={jailTip}>{active.length ? plural(active.length, "address", "addresses") : "nobody right now"}</span>
          {alt && <span title={altTip}> · history {num(alt.banned)}</span>}
        </>
      }
      open={open}
      onToggle={toggle}
    >
      <div className="s-jails">
        {jails
          .filter((j) => j.currentlyBanned > 0)
          .map((j) => (
            <span key={j.name} title={`Since fail2ban started: ${num(j.totalFailed)} failed attempts, ${num(j.totalBanned)} bans`}>
              {j.name} <b>{j.currentlyBanned}</b>
            </span>
          ))}
        {alt && (
          <span title={altTip}>
            history <b>{num(alt.banned)}</b>
          </span>
        )}
      </div>
      {active.length > 0 && (
        <div className="d-table-wrap s-scroll">
          <table className="d-table s-narrow">
            <thead>
              <tr>
                <th>Address</th>
                <th>Country</th>
                <th>Jail</th>
                <th className="is-right">Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {active.map((b) => (
                <tr key={b.ip + b.jail}>
                  <td className="is-main">
                    <span className="inline-flex items-center gap-1">
                      <span className="d-mono">{b.ip}</span>
                      {b.banCount > 1 && (
                        <span className="s-times" title="Times banned so far">
                          {b.banCount}×
                        </span>
                      )}
                      <CopyButton text={b.ip} label="Copy address" />
                    </span>
                  </td>
                  <td>
                    <Country c={b.country} />
                  </td>
                  <td className="o-mute">{b.jail}</td>
                  <td className="is-right whitespace-nowrap" title={`Banned ${shortDateTime(b.bannedAt)}`}>
                    {b.expiresAt ? agoShort(b.expiresAt) : "never"}
                  </td>
                  <td className="is-right">
                    <Button size="sm" variant="ghost" disabled={busy === b.ip} onClick={() => setAsk(b)}>
                      <Unlock className="h-3.5 w-3.5" /> Unban
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {ask && (
        <Confirm
          icon={Unlock}
          copy={{
            title: `Unban ${ask.ip}?`,
            description: "The address can connect again right away. If it fails again, fail2ban bans it again.",
            note: (s.logins ?? []).some((l) => l.ip === ask.ip) ? "There was a recent successful login from this address – probably you." : undefined,
            confirmLabel: "Unban",
          }}
          onClose={() => setAsk(null)}
          onConfirm={() =>
            void run(ask.ip, () => api.post("/api/security/unban", { jail: ask.jail, ip: ask.ip }), `${ask.ip} is unbanned.`).then((ok) => {
              if (ok) void refresh();
            })
          }
        />
      )}
    </Fact>
  );
}

/* ---------- Attack surface: ports ----------------------------------------------------------------- */

type Exposure = Security["ports"][number]["exposure"];
const EXPOSURE_ORDER = { public: 0, local: 1, internal: 2 } as const;
const EXPOSURE_LABEL: Record<Exposure, string> = { public: "public", local: "local only", internal: "internal" };
const EXPOSURE_HINT: Record<Exposure, string> = { public: "Reachable from the internet", local: "Only on the server itself", internal: "Only from internal networks (Docker, tailnet)" };

interface PortRow {
  proto: string;
  port: number;
  process: string;
  exposure: Exposure;
  addrs: string[];
  /** listens publicly, but the firewall blocks it */
  blocked: boolean;
  /** public, but neither allowed in the firewall nor Tailscale */
  odd: boolean;
}

function portRows(s: Security): PortRow[] {
  const m = new Map<string, PortRow>();
  for (const p of s.ports ?? []) {
    const k = `${p.proto}|${p.port}|${p.process}`;
    const e = m.get(k);
    if (!e) m.set(k, { proto: p.proto, port: p.port, process: p.process, exposure: p.exposure, addrs: [p.addr], blocked: false, odd: false });
    else {
      e.addrs.push(p.addr);
      if (EXPOSURE_ORDER[p.exposure] < EXPOSURE_ORDER[e.exposure]) e.exposure = p.exposure;
    }
  }
  // Without the firewall module nothing is blocked or "unexpected" – every public port is simply open.
  const fw = has("firewall") ? on(s.firewall) : null;
  const allowed = fw?.allowedTcp ?? [];
  for (const r of m.values()) {
    const pub = r.exposure === "public" && !!fw;
    r.blocked = pub && r.proto === "tcp" && !allowed.includes(r.port);
    r.odd = pub && !r.blocked && !allowed.includes(r.port) && !r.process.startsWith("tailscale");
  }
  return [...m.values()].sort((a, b) => EXPOSURE_ORDER[a.exposure] - EXPOSURE_ORDER[b.exposure] || a.port - b.port);
}

function Ports({ s, rows, req }: { s: Security; rows: PortRow[]; req: Req | null }) {
  const odd = rows.filter((p) => p.odd);
  const fw = has("firewall") ? on(s.firewall) : null;
  // DOCKER-USER lock: only relevant when Docker publishes ports past ufw.
  const bad = !!fw && has("docker") && fw.dockerUserActive === false;
  const [open, toggle] = useFold("ports", bad || odd.length > 0, req);
  const [more, setMore] = useState(false);
  const visible = rows.filter((p) => p.exposure === "public");
  const hidden = rows.filter((p) => p.exposure !== "public");
  const row = (p: PortRow) => (
    <tr key={`${p.proto}${p.port}${p.process}`} className={cx(p.odd && "is-foreign-old")}>
      <td className="is-main o-num whitespace-nowrap">
        {p.port}
        <span className="o-mute ml-1 text-[11px] uppercase">{p.proto}</span>
      </td>
      <td className="d-mono s-addr max-w-[320px] truncate" title={p.addrs.join(", ")}>
        {p.addrs.join(", ")}
      </td>
      <td className="max-w-[260px] truncate">{p.process}</td>
      <td className="is-right whitespace-nowrap">
        {p.odd ? (
          <Pill tone="sand" title="Neither allowed in the firewall nor Tailscale">
            public
          </Pill>
        ) : (
          <span className="o-mute" title={p.blocked ? "Listens publicly, but the firewall blocks it" : EXPOSURE_HINT[p.exposure]}>
            {p.blocked ? "blocked" : EXPOSURE_LABEL[p.exposure]}
          </span>
        )}
      </td>
    </tr>
  );
  return (
    <Fact
      id="ports"
      label="Attack surface"
      summary={
        fw ? (
          <span title="The firewall only lets these TCP ports in from outside">open to the internet: {fw.allowedTcp.join(", ")}</span>
        ) : (
          <span title="No firewall module – listening ports as seen by the server">{plural(visible.length, "public port", "public ports")}</span>
        )
      }
      status={!fw ? null : bad ? "Docker lock missing" : odd.length ? `Port ${odd.map((p) => p.port).join(", ")} unexpectedly open` : has("docker") ? "Docker lock active" : null}
      tone={bad ? "rose" : odd.length ? "sand" : undefined}
      open={open}
      onToggle={toggle}
    >
      <div className="d-table-wrap">
        <table className="d-table">
          <tbody>
            {visible.map(row)}
            {more && hidden.map(row)}
          </tbody>
        </table>
      </div>
      {hidden.length > 0 && (
        <FoldToggle open={more} onToggle={() => setMore((v) => !v)} className="mt-1">
          {hidden.length} local/internal
        </FoldToggle>
      )}
    </Fact>
  );
}

/* ---------- File changes (auditd) ----------------------------------------------------------------- */

/** auditd rule keys worth a sand color. */
const warnKey = (k: string) => k === "accounts" || k === "sudo";

function Audit({ s, req }: { s: Security; req: Req | null }) {
  const a = on(s.audit) ?? { total24h: 0, byKey: [], recent: [] };
  const [open, toggle] = useFold("files", false, req);
  const groups = useMemo(() => {
    const out: { at: number; key: string; exe: string; paths: string[] }[] = [];
    for (const r of a.recent) {
      const exe = r.exe?.split("/").pop() ?? "";
      const minute = Math.floor(r.at / 60);
      const g = out.find((x) => Math.floor(x.at / 60) === minute && x.key === r.key && x.exe === exe);
      if (g) {
        if (r.path && !g.paths.includes(r.path)) g.paths.push(r.path);
      } else out.push({ at: r.at, key: r.key, exe, paths: r.path ? [r.path] : [] });
    }
    return out;
  }, [a.recent]);
  return (
    <Fact id="files" label="File changes" summary={`${num(a.total24h)} in 24 hr`} open={open} onToggle={toggle}>
      {a.byKey.length > 0 && (
        <div className="s-jails">
          {a.byKey.map((k) => (
            <span key={k.key} className={cx(warnKey(k.key) && "is-sand")}>
              {k.key} <b>{num(k.count)}</b>
            </span>
          ))}
        </div>
      )}
      {groups.length > 0 ? (
        <div className="d-table-wrap">
          <table className="d-table">
            <tbody>
              {groups.map((g, i) => {
                const names = g.paths.map((p) => p.replace(/\/$/, "").split("/").pop() || p);
                return (
                  <tr key={i}>
                    <td className="whitespace-nowrap">{shortDateTime(g.at)}</td>
                    <td className={cx(warnKey(g.key) && "text-[var(--o-sand)]")}>{g.key}</td>
                    <td className="d-mono o-mute">{g.exe}</td>
                    <td className="d-mono max-w-[420px] truncate" title={g.paths.join("\n")}>
                      {g.paths.length > 1 ? `${g.paths.length} files (${names[0]} …)` : (g.paths[0] ?? "—")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="d-empty">No changes in the last 24 hours.</p>
      )}
    </Fact>
  );
}

/* ---------- Hardening (Lynis): index, open recommendations, what is accepted on purpose ------------ */

function DocLink({ f }: { f: LynisFinding }) {
  return f.url ? (
    <a className="s-ly-id" href={f.url} target="_blank" rel="noreferrer" title="CISOfy docs">
      {f.id}
      <ExternalLink className="h-3 w-3" />
    </a>
  ) : (
    <span className="s-ly-id">{f.id}</span>
  );
}

function Recommendation({ f }: { f: LynisFinding }) {
  const items = f.items.filter((i) => i.open || i.key.endsWith(":…"));
  return (
    <li className="s-ly" id={`s-hardening:${f.id}`}>
      <div className="s-ly-top">
        <span className="s-ly-title" title={f.text ?? undefined}>
          {f.title}
        </span>
        {f.kind === "warning" && <Pill tone="rose">Warning</Pill>}
        {f.new && <Pill tone="sand">new</Pill>}
        <DocLink f={f} />
      </div>
      {f.hint && <p className="s-ly-hint">{f.hint}</p>}
      {items.length > 0 && (
        <div className="s-ly-items">
          {items.map((i) => (
            <span key={i.key} title={i.label}>
              <span className="d-mono">{i.label}</span>
              {i.detail && <span className="s-ly-detail"> {i.detail}</span>}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

/** Accepted on purpose: whole tests with their reason, or per part for partial findings (sysctl, SSH option …). */
function Accepted({ f }: { f: LynisFinding }) {
  const parts = f.items.filter((i) => !i.open && i.reason);
  const whole = !f.open && !!f.reason && parts.every((i) => i.reason === f.reason);
  return (
    <li className="s-ly is-accepted">
      <div className="s-ly-top">
        <span className="s-ly-title">{f.title}</span>
        <DocLink f={f} />
      </div>
      {whole || !parts.length ? (
        <p className="s-ly-hint">{f.reason}</p>
      ) : (
        <ul className="s-ly-parts">
          {parts.map((i) => (
            <li key={i.key}>
              <span className="d-mono">{i.label}</span> {i.reason}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function hardeningState(d: Lynis) {
  const r = d.run;
  const warnings = d.findings.filter((f) => f.open && f.kind === "warning").length;
  const dropped = r?.index != null && d.previous?.index != null && r.index < d.previous.index;
  const stale = !!r?.finishedAt && Date.now() / 1000 - r.finishedAt > LYNIS_STALE;
  const tone: "rose" | "sand" | undefined = d.error || warnings ? "rose" : dropped || stale || !d.installed ? "sand" : undefined;
  const status = d.running
    ? "checking …"
    : !d.installed
      ? "not set up"
      : d.error
        ? "run failed"
        : warnings
          ? plural(warnings, "warning", "warnings")
          : dropped
            ? `index dropped (${d.previous?.index} → ${r?.index})`
            : stale
              ? `no run since ${shortDateTime(r?.finishedAt)}`
              : d.counts.new
                ? `${num(d.counts.new)} new`
                : r?.finishedAt
                  ? agoShort(r.finishedAt)
                  : null;
  return { tone, status };
}

function Hardening({ req }: { req: Req | null }) {
  const { data: d, error, refresh } = useLynis();
  const { busy, run } = useAction();
  const st = d ? hardeningState(d) : null;
  const [open, toggle] = useFold("hardening", !!st?.tone, req);
  const [showAccepted, setShowAccepted] = useState(false);
  const r = d?.run ?? null;
  const recs = d?.findings.filter((f) => f.open) ?? [];
  const accepted = (d?.findings ?? []).filter((f) => !f.open || f.items.some((i) => !i.open && i.reason)).sort((a, b) => a.id.localeCompare(b.id));
  const check = () => void run("lynis", () => api.post("/api/lynis/run", {})).then(() => void refresh());
  const running = !!d?.running || busy === "lynis";
  const button = (
    <Button size="sm" variant="ghost" className="s-ly-run" onClick={check} disabled={running || !d?.installed}>
      <RefreshCw className={cx("h-3.5 w-3.5", running && "o-spin")} /> {running ? "Checking …" : "Check now"}
    </Button>
  );

  const summary = !d
    ? (error ?? "Loading …")
    : !r
      ? "not checked yet"
      : `Index ${r.index ?? "?"} · ${recs.length ? plural(recs.length, "recommendation", "recommendations") : "no open recommendations"}`;

  return (
    <Fact id="hardening" label="Hardening" summary={summary} status={st?.status} tone={st?.tone} open={open} onToggle={toggle}>
      {!d ? null : !r ? (
        <div className="s-ly-head">
          <span>{!d.installed ? "Not set up on the server yet." : d.running ? "First run, takes 2–3 minutes." : `No run yet. Next one: ${d.schedule}${d.timezone ? ` (${d.timezone})` : ""}.`}</span>
          {button}
        </div>
      ) : (
        <>
          <div className="s-ly-head">
            <span title={d.previous?.finishedAt ? `Previously ${d.previous.index} on ${shortDateTime(d.previous.finishedAt)}` : undefined}>
              Index <b>{r.index ?? "?"}</b>
              {d.previous?.index != null && d.previous.index !== r.index && ` (was ${d.previous.index})`}
            </span>
            <span>
              <b>{num(r.tests ?? 0)}</b> Tests
            </span>
            <span title={`Lynis ${r.lynisVersion ?? "?"} · every ${d.schedule}${d.timezone ? ` (${d.timezone})` : ""}`}>{shortDateTime(r.finishedAt)}</span>
            {button}
          </div>
          {d.error && <p className="s-ly-error">{d.error}</p>}
          {recs.length > 0 && (
            <ul className="s-ly-list">
              {recs.map((f) => (
                <Recommendation key={f.id} f={f} />
              ))}
            </ul>
          )}
          {accepted.length > 0 && (
            <>
              <FoldToggle open={showAccepted} onToggle={() => setShowAccepted((v) => !v)} className="mt-1">
                accepted <span className="d-fold-meta">{num(accepted.length)}</span>
              </FoldToggle>
              {showAccepted && (
                <ul className="s-ly-list">
                  {accepted.map((f) => (
                    <Accepted key={f.id} f={f} />
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </Fact>
  );
}

/* ---------- Login attempts: bars per hour or day ------------------------------------------------- */

// Bans count every jail, the bars only SSH. So bans are always broken down by kind.
const BAN_KINDS: { key: BanKind; label: string }[] = [
  { key: "ssh", label: "SSH" },
  { key: "web", label: "Web" },
  { key: "repeat", label: "Repeat" },
];
const BAN_TIP = "SSH: failed SSH logins are banned right away · Web: scanners and failed admin logins on your sites · Repeat: banned several times, longer and on all ports";

function banSplit(by: Partial<Record<BanKind, number>> | undefined) {
  if (!by) return "";
  const parts = BAN_KINDS.filter((k) => (by[k.key] ?? 0) > 0).map((k) => `${num(by[k.key] ?? 0)} ${k.label}`);
  return parts.length > 1 || (parts.length === 1 && !(by.ssh ?? 0)) ? parts.join(" · ") : "";
}

const Attempts = memo(function Attempts({ att, banHist, range, h, histError }: { att: Security["sshAttempts"]; banHist: Security["banHistory"] | null; range: HistRange; h: SecurityHistory | null; histError: string | null }) {
  // New arrays only when the history changes – otherwise HourBars recomputes on every poll.
  const days = useMemo(
    () =>
      h
        ? {
            t: h.days.map((d) => d.t),
            attempts: h.days.map((d) => d.attempts ?? 0),
            blocked: h.days.map((d) => d.blocked ?? 0),
            bans: h.days.map((d) => d.bans ?? 0),
            banParts: BAN_KINDS.map((k) => ({ label: k.label, values: h.days.map((d) => d.bansByKind?.[k.key] ?? 0) })),
          }
        : null,
    [h],
  );
  const hourParts = useMemo(
    () => (banHist?.byKind ? BAN_KINDS.map((k) => ({ label: k.label, values: banHist.byKind![k.key] ?? [] })) : undefined),
    [banHist],
  );
  const hourly = range === "24h";
  const since = dayDate(h?.firstDay);
  const total = hourly
    ? {
        attempts: att.total24h,
        ips: att.uniqueIps24h,
        bans: banHist ? (banHist.count.reduce((n, v) => n + v, 0) as number | null) : null,
        byKind: banHist?.byKind ? (Object.fromEntries(BAN_KINDS.map((k) => [k.key, (banHist.byKind![k.key] ?? []).reduce((n, v) => n + v, 0)])) as Partial<Record<BanKind, number>>) : undefined,
        blocked: undefined as number | undefined,
        blockedIps: 0,
      }
    : h
      ? { attempts: h.total.attempts, ips: h.total.uniqueIps, bans: banHist ? h.total.bans : null, byKind: h.total.bansByKind, blocked: banHist ? h.total.blocked : undefined, blockedIps: h.total.blockedIps ?? 0 }
      : null;
  const split = total ? banSplit(total.byKind) : "";
  return (
    <Panel>
      {total && (
        <div className="s-totals" title={!hourly && since ? `Data since ${since}` : undefined}>
          <span>
            <b>{num(total.attempts)}</b> SSH attempts
          </span>
          <span>
            <b>{num(total.ips)}</b> addresses
          </span>
          {total.bans !== null && (
            <span title={BAN_TIP}>
              <b>{num(total.bans)}</b> bans{split && ` (${split})`}
            </span>
          )}
          {total.blocked !== undefined && total.attempts > 0 && (
            <span className="s-key" title={`${num(total.blockedIps)} of ${num(total.ips)} addresses are banned today (${has("ban-history") ? "ban history + " : ""}fail2ban)`}>
              <i />
              <b>{Math.round((total.blocked / total.attempts) * 100)}%</b> from addresses banned today
            </span>
          )}
          {!hourly && h?.building && <span>Building history …</span>}
        </div>
      )}
      {hourly ? (
        <HourBars t={att.t} values={att.count} label="SSH attempts" strip={banHist ? { label: "Bans", values: banHist.count, parts: hourParts } : undefined} height={170} />
      ) : days ? (
        <HourBars
          unit="day"
          t={days.t}
          values={days.attempts}
          label="SSH attempts"
          part={banHist ? { label: "from addresses banned today", values: days.blocked } : undefined}
          strip={banHist ? { label: "Bans", values: days.bans, parts: days.banParts } : undefined}
          height={170}
        />
      ) : (
        <p className="d-empty">{histError ?? "Loading history …"}</p>
      )}
    </Panel>
  );
});

/* ---------- Origin: top attackers | countries in one card ---------------------------------------- */

type Tab = "senders" | "countries";

const TOP_KEYS = ["ip", "country", "count", "status"] as const;
type TopKey = (typeof TOP_KEYS)[number];
type TopRow = { ip: string; count: number; banned: boolean; country: Security["topIps"][number]["country"]; lastSeen: number | null };

function TopIps({ top }: { top: TopRow[] }) {
  const [sort, onSort] = useSort<TopKey>("top", { key: "count", dir: "desc" }, TOP_KEYS);
  const max = Math.max(...top.map((i) => i.count), 1);
  const val = (i: TopRow, k: TopKey) =>
    k === "ip" ? ipKey(i.ip) : k === "country" ? countryName(i.country.cc, i.country.name) : k === "count" ? i.count : i.banned ? Number.MAX_SAFE_INTEGER : (i.lastSeen ?? null);
  const rows = [...top].sort((a, b) => compare(val(a, sort.key), val(b, sort.key), sort.dir) || b.count - a.count);
  return (
    <div className="d-table-wrap">
      <table className="d-table s-narrow">
        <thead>
          <tr>
            <SortTh k="ip" sort={sort} onSort={onSort} first="asc">
              Address
            </SortTh>
            <SortTh k="country" sort={sort} onSort={onSort} first="asc">
              Country
            </SortTh>
            <SortTh k="count" sort={sort} onSort={onSort} right>
              Attempts
            </SortTh>
            <SortTh k="status" sort={sort} onSort={onSort} right>
              Status
            </SortTh>
          </tr>
        </thead>
        <tbody>
          {rows.map((ip) => (
            <tr key={ip.ip}>
              <td className="is-main w-[38%]">
                <span className="d-mono">{ip.ip}</span>
                <Meter share={ip.count / max} thin tone="neutral" />
              </td>
              <td>
                <Country c={ip.country} />
              </td>
              <td className="is-right">{num(ip.count)}</td>
              <td className="is-right whitespace-nowrap o-mute">{ip.banned && has("fail2ban") ? "banned" : ip.lastSeen ? agoShort(ip.lastSeen) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const COUNTRY_KEYS = ["name", "attempts", "ips"] as const;
type CountryKey = (typeof COUNTRY_KEYS)[number];

function Countries({ list }: { list: CountryCount[] }) {
  const [sort, onSort] = useSort<CountryKey>("countries", { key: "ips", dir: "desc" }, COUNTRY_KEYS);
  const [all, setAll] = useState(false);
  // Bar and share show the sorted metric (when sorting by name: addresses).
  const metric: "attempts" | "ips" = sort.key === "attempts" ? "attempts" : "ips";
  const name = (c: CountryCount) => countryName(c.cc, c.name);
  const sorted = [...list].sort((a, b) => compare(sort.key === "name" ? name(a) : a[sort.key], sort.key === "name" ? name(b) : b[sort.key], sort.dir) || b.attempts - a.attempts);
  const rows = all ? sorted : sorted.slice(0, 10);
  const max = Math.max(...sorted.map((c) => c[metric]), 1);
  const total = sorted.reduce((n, c) => n + c[metric], 0);
  return (
    <>
      <div className="d-table-wrap">
        <table className="d-table s-narrow">
          <thead>
            <tr>
              <SortTh k="name" sort={sort} onSort={onSort} first="asc">
                Country
              </SortTh>
              <SortTh k="attempts" sort={sort} onSort={onSort} right>
                Attempts
              </SortTh>
              <SortTh k="ips" sort={sort} onSort={onSort} right>
                Addresses
              </SortTh>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.cc ?? c.name} title={total ? `${num((c[metric] / total) * 100)}% of ${metric === "ips" ? "addresses" : "attempts"}` : undefined}>
                <td className="is-main w-[56%]">
                  <Country c={c} />
                  <Meter share={c[metric] / max} thin tone="neutral" />
                </td>
                <td className="is-right">{num(c.attempts)}</td>
                <td className="is-right">{num(c.ips)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sorted.length > 10 && (
        <FoldToggle open={all} onToggle={() => setAll((v) => !v)} className="mt-1">
          {all ? "Show less" : `Show all ${sorted.length} countries`}
        </FoldToggle>
      )}
    </>
  );
}

const Origin = memo(function Origin({ topIps, countries24h, range, h, req }: { topIps: Security["topIps"]; countries24h: CountryCount[] | undefined; range: HistRange; h: SecurityHistory | null; req: Req | null }) {
  const [tab, setTab] = useState<Tab>("senders");
  useEffect(() => {
    if (req?.k === "senders" || req?.k === "countries") setTab(req.k);
  }, [req]);
  const live = range === "24h";
  const top = useMemo<TopRow[] | null>(() => (live ? (topIps ?? []) : (h?.topIps.map((i) => ({ ...i, lastSeen: null })) ?? null)), [live, topIps, h]);
  const countries = live ? (countries24h ?? []) : (h?.countries ?? null);
  const list = tab === "senders" ? top : countries;
  return (
    <Panel id="s-senders" className="s-origin">
      <Segmented<Tab>
        tabs
        size="sm"
        ariaLabel="Origin of attempts"
        value={tab}
        onChange={setTab}
        className="mb-3"
        options={[
          { id: "senders", label: "Top attackers" },
          { id: "countries", label: "Countries" },
        ]}
      />
      {!list ? (
        <p className="d-empty">Loading …</p>
      ) : !list.length ? (
        <p className="d-empty">No attempts.</p>
      ) : tab === "senders" ? (
        <TopIps top={top ?? []} />
      ) : (
        <Countries list={countries ?? []} />
      )}
    </Panel>
  );
});

/* ---------- Page ----------------------------------------------------------------------------------- */

export function SecurityPage() {
  const p = usePoll<Security>("/api/security", EVERY.security);
  const all = usePoll<SecurityHistory>("/api/security/history?days=0", 5 * 60_000);
  const [range, setRange] = useState<HistRange>("0");
  const hist = usePoll<SecurityHistory>(range === "24h" || range === "0" ? null : `/api/security/history?days=${range}`, 60_000);
  const h = range === "24h" ? null : range === "0" ? all.data : hist.data;
  const histError = range === "0" ? all.error : hist.error;
  // Every address with a successful login; check more often while the journal is still being read.
  const [loginsFast, setLoginsFast] = useState(true);
  const logins = usePoll<LoginIps>("/api/security/logins", loginsFast ? 10_000 : EVERY.logins);
  useEffect(() => {
    if (logins.data?.complete) setLoginsFast(false);
  }, [logins.data?.complete]);
  const req = useOpenRequest();
  const ports = useMemo(() => (p.data ? portRows(p.data) : []), [p.data]);

  return (
    <div className="o-wrap d-page">
      <Loading data={p.data} error={p.error}>
        {(s) => {
          // Foreign logins in the last 24 hr – only while port 22 is closed, and not from before it closed.
          const closed = logins.data?.since != null && has("firewall") && has("tailscale");
          const day = Math.max(Date.now() / 1000 - 86400, logins.data?.since ?? 0);
          const strangers = closed
            ? [
                ...new Set([
                  ...(logins.data?.ips ?? []).filter((i) => i.last >= day && isForeign(i)).map((i) => i.ip),
                  ...(s.logins ?? []).filter((l) => l.at >= day && !isTailnet(l.country) && !isInternal(l.country)).map((l) => l.ip),
                ]),
              ]
            : [];
          const odd = ports.filter((x) => x.odd);
          const issues: { tone: "rose" | "sand"; text: string }[] = [];
          // Older foreign logins (up to 7 days) stay a hint until they drop out of the window.
          const week = Math.max(Date.now() / 1000 - 7 * 86400, logins.data?.since ?? 0);
          const lately = closed ? (logins.data?.ips ?? []).filter((i) => i.last >= week && isForeign(i) && !strangers.includes(i.ip)).map((i) => i.ip) : [];
          if (strangers.length) issues.push({ tone: "rose", text: strangers.length === 1 ? `Foreign login from ${strangers[0]}` : `${strangers.length} foreign logins` });
          else if (lately.length) issues.push({ tone: "sand", text: lately.length === 1 ? `Login from ${lately[0]} this week` : `${lately.length} foreign logins this week` });
          if (has("firewall") && has("docker") && on(s.firewall)?.dockerUserActive === false) issues.push({ tone: "rose", text: "Docker lock missing" });
          if (odd.length) issues.push({ tone: "sand", text: odd.length === 1 ? `Port ${odd[0].port} unexpectedly open` : `${odd.length} ports unexpectedly open` });
          const title = issues.length === 0 ? "All locked down." : issues.length === 1 ? `${issues[0].text}.` : `${issues.length} things need you.`;
          return (
            <>
              <PageHero
                title={title}
                shine={issues.length ? undefined : 1}
                lead={
                  issues.length > 1 ? (
                    <Chips>
                      {issues.map((i) => (
                        <Pill key={i.text} tone={i.tone}>
                          {i.text}
                        </Pill>
                      ))}
                    </Chips>
                  ) : undefined
                }
                aside={<Stale error={p.error} at={p.at} />}
              />
              <Panel className="s-facts">
                <Logins d={logins.data} error={logins.error} range={range} req={req} />
                {has("fail2ban") && <Bans s={s} refresh={p.refresh} req={req} />}
                <Ports s={s} rows={ports} req={req} />
                {has("auditd") && <Audit s={s} req={req} />}
                {has("lynis") && <Hardening req={req} />}
              </Panel>
              <Section title="Login attempts" aside={<Segmented<HistRange> size="sm" ariaLabel="Period" value={range} onChange={setRange} options={RANGES} />}>
                <div className="o-stack">
                  <Attempts att={s.sshAttempts} banHist={has("fail2ban") ? on(s.banHistory) : null} range={range} h={h} histError={histError} />
                  <Origin topIps={s.topIps} countries24h={s.countries24h} range={range} h={h} req={req} />
                </div>
              </Section>
              {(has("proxy") || has("portainer")) && (
                <Section title={has("proxy") && has("portainer") ? "Certificates & secrets" : has("proxy") ? "Certificates" : "Secrets"}>
                  <div className="o-stack">
                    {has("proxy") && <CtWatchCard />}
                    {has("portainer") && <SecretsCard />}
                  </div>
                </Section>
              )}
              <p className="d-attrib">
                IP countries:{" "}
                <a href="https://db-ip.com" target="_blank" rel="noreferrer">
                  DB-IP
                </a>{" "}
                (CC BY 4.0)
              </p>
            </>
          );
        }}
      </Loading>
    </div>
  );
}
