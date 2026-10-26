import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Circle,
  Globe,
  KeyRound,
  Lock,
  MinusCircle,
  Network,
  Plus,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Trash2,
  UserRound,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, MOCK, refreshAll } from "../api";
import { Button, Callout, CopyButton, cx, DialogHead, Field, IconButton, Overlay, Pill, Segmented, Toggle, useCloseOverlay } from "../design/ui";
import { num } from "../format";
import type { DomainCheck, HostJob, IpList, JobStepState, NewHostBody, SslFlags, SslKey, Target, WizardData } from "../hosts";
import { covers, isPrivateRelay, isValidEntry, normalize } from "../ip";
import { useNav } from "../nav";
import { openSetting } from "./settingsOpen";
import "./newsite.css";

/**
 * "New site" wizard: creates a proxy host in the Proxy Manager (module proxy).
 * Five steps – domain, target, SSL & security, access, review & create –
 * then live progress of the job (server/hosts.py). If the certificate
 * fails, the backend removes the host again.
 */

const STEPS = [
  { id: "domain", label: "Domain", icon: Globe },
  { id: "target", label: "Target", icon: Network },
  { id: "ssl", label: "SSL & security", icon: Lock },
  { id: "access", label: "Access", icon: ShieldCheck },
  { id: "review", label: "Review & create", icon: Rocket },
] as const;

/** Element id of the Proxy Manager login row in Settings. */
export const NPM_CARD_ID = "proxy-manager-login";

/** CSS state class per step state (independent of the wire values). */
const STATE_CLASS: Record<JobStepState, string> = {
  pending: "waiting",
  running: "running",
  ok: "ok",
  failed: "error",
  warning: "warning",
  skipped: "skip",
  cancelled: "skip",
};

/** Step states → labels. */
const STATE_LABEL: Record<JobStepState, string> = {
  pending: "waiting",
  running: "running",
  ok: "done",
  failed: "failed",
  warning: "warning",
  skipped: "skipped",
  cancelled: "cancelled",
};

interface Row {
  key: number;
  value: string;
  note: string;
}

const SSL_ROWS: { key: SslKey; label: string; desc: string; needs?: SslKey[] }[] = [
  { key: "certificate", label: "SSL certificate", desc: "Let's Encrypt, renewed by the Proxy Manager." },
  { key: "sslForced", label: "Force HTTPS", desc: "http:// redirects to https://.", needs: ["certificate"] },
  { key: "hsts", label: "HSTS", desc: "Browsers remember to open the site over HTTPS only.", needs: ["certificate", "sslForced"] },
  { key: "hstsSubdomains", label: "HSTS for subdomains", desc: "Also applies to everything under this domain.", needs: ["certificate", "sslForced", "hsts"] },
  { key: "http2", label: "HTTP/2", desc: "Faster with many small files.", needs: ["certificate"] },
  { key: "blockExploits", label: "Block common exploits", desc: "Typical attack patterns (SQL injection, path tricks) get a 403." },
  { key: "caching", label: "Cache assets", desc: "Cache images, CSS and JavaScript in the proxy." },
  { key: "websockets", label: "WebSockets", desc: "Only needed for live connections (e.g. Socket.IO)." },
];

const sameFlags = (a: SslFlags, b: SslFlags) => (Object.keys(a) as SslKey[]).every((k) => a[k] === b[k]);

/** Turn off dependent switches (as the Proxy Manager would on save anyway). */
function settle(f: SslFlags): SslFlags {
  const n = { ...f };
  if (!n.certificate) Object.assign(n, { sslForced: false, hsts: false, hstsSubdomains: false, http2: false });
  if (!n.sslForced) Object.assign(n, { hsts: false, hstsSubdomains: false });
  if (!n.hsts) n.hstsSubdomains = false;
  return n;
}

const looksLikeDomain = (s: string) => /\S+\.\S{2,}/.test(s.trim());

/* ========================================================================= */

export function NewSiteWizard({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<WizardData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);

  // 1 Domain
  const [domain, setDomain] = useState("");
  const [www, setWww] = useState(false);
  const [check, setCheck] = useState<{ key: string; res: DomainCheck } | null>(null);
  const [checkErr, setCheckErr] = useState<{ key: string; msg: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const seq = useRef(0);
  // 2 Target
  const [target, setTarget] = useState<string | null>(null);
  const [port, setPort] = useState("");
  const [scheme, setScheme] = useState<"http" | "https">("http");
  // 3 SSL
  const [ssl, setSsl] = useState<SslFlags | null>(null);
  // 4 Access
  const [mode, setMode] = useState<"open" | "list">("open");
  const [rows, setRows] = useState<Row[]>([]);
  const nextKey = useRef(1);
  // 5 Job
  const [job, setJob] = useState<HostJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [startErr, setStartErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.get<WizardData>("/api/hosts/new");
      setData(d);
      setLoadError(null);
      setSsl((s) => s ?? d.defaults.values);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  /* ---- check the domain, shortly after typing ---- */
  const key = `${domain.trim().toLowerCase()}|${www ? 1 : 0}`;
  const runCheck = useCallback(async (d: string, w: boolean) => {
    const k = `${d.trim().toLowerCase()}|${w ? 1 : 0}`;
    const n = ++seq.current;
    setChecking(true);
    try {
      const res = await api.get<DomainCheck>(`/api/hosts/check?domain=${encodeURIComponent(d.trim())}&www=${w ? 1 : 0}`);
      if (n !== seq.current) return;
      setCheck({ key: k, res });
      setCheckErr(null);
    } catch (e) {
      if (n !== seq.current) return;
      setCheck(null);
      setCheckErr({ key: k, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      if (n === seq.current) setChecking(false);
    }
  }, []);
  useEffect(() => {
    if (!looksLikeDomain(domain)) {
      seq.current++;
      setChecking(false);
      return;
    }
    const t = setTimeout(() => void runCheck(domain, www), 650);
    return () => clearTimeout(t);
  }, [domain, www, runCheck]);

  const cur = check?.key === key ? check.res : null;
  const curErr = checkErr?.key === key ? checkErr.msg : null;
  const names = cur?.domains ?? [];
  const target_ = data?.targets.containers.find((c) => c.name === target) ?? null;
  const portNum = Number(port);
  const portOk = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;

  const valid = [
    !!cur && cur.ok,
    !!target_ && target_.reachable && portOk,
    !!ssl,
    mode === "open" || rows.length > 0,
    true,
  ];

  const running = job?.state === "running" || starting;
  const finished = job?.state === "done";
  const go = (i: number) => {
    if (running || finished) return;
    setStep(i);
    setReached((r) => Math.max(r, i));
    setStartErr(null);
  };
  const next = () => valid[step] && go(step + 1);

  /* ---- start the job and follow it ---- */
  const body = (): NewHostBody | null =>
    cur && target_ && ssl
      ? {
          domain: cur.domain,
          www,
          forwardHost: target_.name,
          forwardPort: portNum,
          forwardScheme: scheme,
          ssl: settle(ssl),
          access: { mode, entries: mode === "list" ? rows.map((r) => ({ value: normalize(r.value), note: r.note.trim() })) : [] },
        }
      : null;

  const start = async () => {
    const b = body();
    if (!b) return;
    setStarting(true);
    setStartErr(null);
    setJob(null);
    try {
      const r = await api.post<{ ok: true; job: string }>("/api/hosts", b);
      setJob(await api.get<HostJob>(`/api/hosts/jobs/${r.job}`));
    } catch (e) {
      setStartErr(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => {
    if (!job || job.state !== "running") return;
    const t = setTimeout(async () => {
      try {
        setJob(await api.get<HostJob>(`/api/hosts/jobs/${job.id}`));
      } catch (e) {
        setStartErr(e instanceof Error ? e.message : String(e));
      }
    }, 900);
    return () => clearTimeout(t);
  }, [job]);

  useEffect(() => {
    if (job && job.state !== "running") refreshAll();
  }, [job?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const npmOk = data?.npm.connected ?? true;

  return (
    <Overlay onClose={onClose} label="New site" size="xl" align="top" className="ns-dialog" onEscape={() => running}>
      <DialogHead
        icon={Globe}
        title="New site"
        sub={cur ? <span className="d-mono">{cur.domains.join(" · ")}</span> : "Create a proxy host in the Proxy Manager, step by step."}
      />
      <Progress step={step} reached={reached} valid={valid} locked={running || finished} onGo={go} />
      <div className="o-dialog-scroll">
        <div className="o-dialog-body ns-body">
          {data && !data.npm.connected && <NpmMissing npm={data.npm} />}
          {loadError ? (
            <Callout tone="rose" title="Couldn't load the wizard data" action={<Button size="sm" onClick={() => void load()}>Retry</Button>}>
              {loadError}
            </Callout>
          ) : step === 0 ? (
            <DomainStep domain={domain} setDomain={setDomain} www={www} setWww={setWww} checking={checking} res={cur} err={curErr} onRecheck={() => looksLikeDomain(domain) && void runCheck(domain, www)} onEnter={next} />
          ) : !data || !ssl ? (
            <div className="o-empty !py-10">Loading…</div>
          ) : step === 1 ? (
            <TargetStep
              data={data}
              target={target}
              onPick={(t) => {
                setTarget(t.name);
                setPort(t.suggestedPort ? String(t.suggestedPort) : "");
              }}
              port={port}
              setPort={setPort}
              portOk={portOk}
              scheme={scheme}
              setScheme={setScheme}
            />
          ) : step === 2 ? (
            <SslStep data={data} ssl={ssl} setSsl={setSsl} names={names} />
          ) : step === 3 ? (
            <AccessStep
              data={data}
              mode={mode}
              setMode={setMode}
              rows={rows}
              add={(value, note) => {
                if (rows.some((r) => normalize(r.value) === normalize(value))) return false;
                setRows((rs) => [...rs, { key: nextKey.current++, value: normalize(value), note }]);
                return true;
              }}
              remove={(values) => setRows((rs) => rs.filter((r) => !values.includes(normalize(r.value))))}
              setNote={(k, note) => setRows((rs) => rs.map((r) => (r.key === k ? { ...r, note } : r)))}
            />
          ) : (
            <ReviewStep
              data={data}
              names={names}
              target={target_}
              port={portNum}
              scheme={scheme}
              ssl={settle(ssl)}
              mode={mode}
              rows={rows}
              job={job}
              startErr={startErr}
              onEdit={go}
            />
          )}
        </div>
      </div>
      <Foot
        step={step}
        valid={valid[step]}
        canCreate={npmOk && valid.every(Boolean)}
        withCert={!!ssl?.certificate}
        running={running}
        job={job}
        onBack={() => go(step - 1)}
        onNext={next}
        onStart={() => void start()}
        onRetry={() => {
          setJob(null);
          setStartErr(null);
        }}
      />
    </Overlay>
  );
}

/* ---------- header: progress -------------------------------------------------------------------- */

function Progress({ step, reached, valid, locked, onGo }: { step: number; reached: number; valid: boolean[]; locked: boolean; onGo: (i: number) => void }) {
  return (
    <nav className="ns-progress" aria-label="Steps">
      <div className="ns-bar" aria-hidden>
        <i style={{ width: `${(step / (STEPS.length - 1)) * 100}%` }} />
      </div>
      <ol>
        {STEPS.map((s, i) => {
          const done = i < step || (i <= reached && i !== step && valid.slice(0, i + 1).every(Boolean));
          const can = !locked && i <= reached && valid.slice(0, i).every(Boolean);
          return (
            <li key={s.id}>
              <button type="button" className={cx("ns-step", i === step && "is-on", done && i !== step && "is-done")} disabled={!can || i === step} onClick={() => onGo(i)} aria-current={i === step ? "step" : undefined}>
                <span className="ns-step-dot">{done && i !== step ? <Check className="h-3 w-3" /> : i + 1}</span>
                <span className="ns-step-label">{s.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function NpmMissing({ npm }: { npm: WizardData["npm"] }) {
  const { go } = useNav();
  const close = useCloseOverlay();
  return (
    <Callout
      tone="sand"
      icon={KeyRound}
      className="mb-5"
      title={npm.configured ? "The Proxy Manager rejects the saved login" : "The Proxy Manager login is missing"}
      action={
        <Button
          size="sm"
          variant="primary"
          onClick={() =>
            close(() => {
              go("settings");
              openSetting("npm");
            })
          }
        >
          Open setting
        </Button>
      }
    >
      {npm.reason ?? "Without the email and password of a Proxy Manager user the wizard can't create anything. You can still click through."}
    </Callout>
  );
}

/* ---------- 1 Domain --------------------------------------------------------------------------- */

function DomainStep({
  domain,
  setDomain,
  www,
  setWww,
  checking,
  res,
  err,
  onRecheck,
  onEnter,
}: {
  domain: string;
  setDomain: (v: string) => void;
  www: boolean;
  setWww: (v: boolean) => void;
  checking: boolean;
  res: DomainCheck | null;
  err: string | null;
  onRecheck: () => void;
  onEnter: () => void;
}) {
  const ip4 = res?.serverIps.v4[0];
  return (
    <div className="flex flex-col gap-5">
      <Field label="Domain" htmlFor="ns-domain" hint="Without https:// – e.g. app.example.com. The domain must already point to this server at your DNS provider.">
        <div className="ns-domain-row">
          <input
            id="ns-domain"
            data-autofocus
            className={cx("o-input d-mono", (err || (res && !res.ok)) && "is-bad")}
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), onEnter())}
            placeholder="app.example.com"
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
          />
          <label className="ns-www">
            <Toggle checked={www} onChange={setWww} label="also www." />
            <span>
              also <b className="d-mono">www.</b>
            </span>
          </label>
        </div>
      </Field>

      {checking && !res && !err ? (
        <div className="ns-checking">
          <RefreshCw className="h-4 w-4 o-spin" /> Checking DNS and existing hosts…
        </div>
      ) : err ? (
        <Callout tone="rose" title="That won't work">
          {err}
        </Callout>
      ) : res ? (
        <div className="flex flex-col gap-3">
          {res.taken.map((t) => (
            <Callout key={t.domain} tone="rose" title={`${t.domain} already exists`}>
              In the Proxy Manager as {t.kind} #{t.id}. A domain can only exist once – under Services it is listed with its container.
            </Callout>
          ))}
          <div className="ns-dns">
            <div className="ns-dns-head">
              <span className="o-micro">DNS</span>
              <span className="o-hint">
                Server: <span className="d-mono">{[...res.serverIps.v4, ...res.serverIps.v6].join(" · ")}</span>
              </span>
              <IconButton label="Check again" size="sm" onClick={onRecheck} className="ml-auto">
                <RefreshCw className={cx("h-3.5 w-3.5", checking && "o-spin")} />
              </IconButton>
            </div>
            {res.dns.map((d) => (
              <div key={d.name} className={cx("ns-dns-row", !d.ok && "is-bad")}>
                {d.ok ? <CheckCircle2 className="ns-ok h-4 w-4" /> : <XCircle className="ns-bad h-4 w-4" />}
                <div className="min-w-0 flex-1">
                  <div className="d-mono ns-dns-name">{d.name}</div>
                  <div className="ns-dns-recs">
                    <span>
                      A <b className="d-mono">{d.a.length ? d.a.join(", ") : "—"}</b>
                    </span>
                    <span>
                      AAAA <b className="d-mono">{d.aaaa.length ? d.aaaa.join(", ") : "—"}</b>
                    </span>
                    {d.cname && (
                      <span>
                        via <b className="d-mono">{d.cname}</b>
                      </span>
                    )}
                  </div>
                  {d.problem && <p className="ns-problem">{d.problem}</p>}
                </div>
              </div>
            ))}
          </div>
          {res.ok && (
            <Callout tone="ok" title={`${res.domains.length > 1 ? "Both point" : "Points"} to this server${ip4 ? ` (${ip4})` : ""}`}>
              Let's Encrypt will be able to issue the certificate.
            </Callout>
          )}
        </div>
      ) : (
        <p className="o-hint">As you type, the server checks whether A and AAAA point here and whether the domain already exists.</p>
      )}
      {MOCK && (
        <p className="ns-mock">
          Mock: <b>example.com</b> already exists · <b>…wrong…</b> A elsewhere · <b>…v6…</b> wrong AAAA · <b>…no-dns…</b> no record · <b>…fail…</b> certificate fails · anything else works
          (e.g. <b>api.example.com</b> → shop-api).
        </p>
      )}
    </div>
  );
}

/* ---------- 2 Target ---------------------------------------------------------------------------- */

function composeSnippet(t: Target, join: string): string {
  const own = t.networks.filter((n) => n !== join).map((n) => (t.project && n.startsWith(`${t.project}_`) ? n.slice(t.project.length + 1) : n));
  const svc = t.service ?? t.name;
  return [
    "services:",
    `  ${svc}:`,
    "    networks:",
    ...own.map((n) => `      - ${n}`),
    `      - ${join}`,
    "",
    "networks:",
    ...own.filter((n) => n !== "default").map((n) => `  ${n}: {}`),
    `  ${join}:`,
    "    external: true",
  ].join("\n");
}

function TargetStep({
  data,
  target,
  onPick,
  port,
  setPort,
  portOk,
  scheme,
  setScheme,
}: {
  data: WizardData;
  target: string | null;
  onPick: (t: Target) => void;
  port: string;
  setPort: (v: string) => void;
  portOk: boolean;
  scheme: "http" | "https";
  setScheme: (v: "http" | "https") => void;
}) {
  const list = data.targets.containers;
  const groups = useMemo(() => {
    const m = new Map<string, Target[]>();
    for (const c of list.filter((x) => x.sites.length === 0)) m.set(c.project ?? "No stack", [...(m.get(c.project ?? "No stack") ?? []), c]);
    return [...m.entries()];
  }, [list]);
  const withSite = list.filter((x) => x.sites.length > 0);
  const t = list.find((c) => c.name === target) ?? null;
  const npm = data.targets.npm;
  const portChips = t ? [...new Set([...t.listening, ...t.exposed])].sort((a, b) => a - b) : [];

  const item = (c: Target) => (
    <button
      key={c.name}
      type="button"
      role="radio"
      aria-checked={c.name === target}
      className={cx("ns-target", c.name === target && "is-on", c.sites.length > 0 && "is-used", !c.reachable && "is-cut")}
      onClick={() => onPick(c)}
    >
      <span className="ns-radio" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="ns-target-name d-mono">{c.name}</span>
        <span className="ns-target-meta">
          {c.image}
          {c.listening.length > 0 && <> · listens on {c.listening.join(", ")}</>}
        </span>
      </span>
      <span className="ns-target-pills">
        {c.sites.length > 0 && <Pill tone="neutral">{c.sites[0]}{c.sites.length > 1 ? ` +${c.sites.length - 1}` : ""}</Pill>}
        {!c.reachable && <Pill tone="rose">no shared network</Pill>}
      </span>
    </button>
  );

  return (
    <div className="flex flex-col gap-5">
      <p className="o-hint !mt-0">
        Running containers. Reachable are those that share a network with the Proxy Manager ({npm.networks.map((n, i) => <span key={n}>{i > 0 && ", "}<span className="d-mono">{n}</span></span>)}).
      </p>
      <div className="ns-targets" role="radiogroup" aria-label="Target container">
        {groups.map(([project, cs]) => (
          <div key={project} className="ns-group">
            <div className="ns-group-title">{project}</div>
            {cs.map(item)}
          </div>
        ))}
        {withSite.length > 0 && (
          <div className="ns-group is-used">
            <div className="ns-group-title">Already have a site</div>
            {withSite.map(item)}
          </div>
        )}
      </div>

      {t && !t.reachable && npm.join && (
        <Callout tone="rose" icon={Network} title={`${t.name} shares no network with the Proxy Manager`}>
          <p>
            It is only on <span className="d-mono">{t.networks.join(", ") || "no network"}</span>, the Proxy Manager on <span className="d-mono">{npm.networks.join(", ")}</span>. For the Proxy
            Manager to reach it, add <span className="d-mono">{npm.join}</span> to the compose file of the stack <b>{t.project ?? "?"}</b>
            {t.composeFile && (
              <>
                {" "}
                (<span className="d-mono">{t.composeFile}</span>)
              </>
            )}{" "}
            – then redeploy it under Services:
          </p>
          <div className="ns-code">
            <pre>{composeSnippet(t, npm.join)}</pre>
            <CopyButton text={composeSnippet(t, npm.join)} label="Copy" />
          </div>
          <p className="o-hint">There is deliberately no "connect" button: a manual docker network connect only lasts until the next redeploy – then the site would silently break.</p>
        </Callout>
      )}

      {t && t.reachable && (
        <div className="ns-port">
          <Field label="Port in the container" htmlFor="ns-port" error={port && !portOk ? "A number from 1 to 65535" : undefined} hint={t.listening.length ? `Listens on ${t.listening.join(", ")}.` : "No listening port found – suggestion from EXPOSE."}>
            <div className="flex flex-wrap items-center gap-2">
              <Segmented<"http" | "https"> size="sm" ariaLabel="Scheme to the container" value={scheme} onChange={setScheme} options={[{ id: "http", label: "http" }, { id: "https", label: "https" }]} />
              <span className="d-mono o-mute">{t.name}:</span>
              <input id="ns-port" className={cx("o-input d-mono ns-port-input", port && !portOk && "is-bad")} value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" placeholder="3000" />
              {portChips.map((p) => (
                <button key={p} type="button" className={cx("o-chip", String(p) === port && "is-on")} onClick={() => setPort(String(p))} title={t.listening.includes(p) ? "listening" : "EXPOSE only – not listening right now"}>
                  {p}
                  {!t.listening.includes(p) && <span className="o-mute"> · EXPOSE</span>}
                </button>
              ))}
            </div>
          </Field>
          {t.sites.length > 0 && <p className="o-hint">{t.sites.join(", ")} already points to this container. A second domain works too.</p>}
          {port && portOk && t.listening.length > 0 && !t.listening.includes(Number(port)) && (
            <Callout tone="sand" title={`Nothing listens on ${port} in the container right now`}>
              The Proxy Manager would get a 502. This is the port inside the container, not on the server.
            </Callout>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- 3 SSL & security --------------------------------------------------------------------- */

function SslStep({ data, ssl, setSsl, names }: { data: WizardData; ssl: SslFlags; setSsl: (f: SslFlags) => void; names: string[] }) {
  const d = data.defaults;
  const eff = settle(ssl);
  const isDefault = sameFlags(eff, settle(d.values));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {isDefault ? (
          <Pill tone="accent" dot>
            like your other sites
          </Pill>
        ) : (
          <>
            <Pill tone="sand">custom</Pill>
            <Button size="sm" variant="ghost" onClick={() => setSsl(d.values)}>
              Like your other sites
            </Button>
          </>
        )}
        <span className="o-hint">Default: what most of your {d.basis} sites have.</span>
      </div>
      <div className="ns-switches">
        {SSL_ROWS.map((r) => {
          const blocked = (r.needs ?? []).some((k) => !eff[k]);
          const on = eff[r.key];
          const differs = on !== settle(d.values)[r.key];
          return (
            <div key={r.key} className={cx("ns-switch", blocked && "is-off")}>
              <div className="min-w-0 flex-1">
                <div className="ns-switch-label">
                  {r.label}
                  {differs && <i className="o-seg-dot ml-2 inline-block align-middle" title="differs from your other sites" />}
                </div>
                <div className="ns-switch-desc">
                  {r.key === "certificate" && names.length ? <>For <span className="d-mono">{names.join(", ")}</span>. {r.desc}</> : r.desc}
                </div>
              </div>
              <span className="ns-switch-count" title={`${d.counts[r.key]} of ${d.basis} sites have this on`}>
                {d.counts[r.key]}/{d.basis}
              </span>
              <Toggle checked={on} disabled={blocked} label={r.label} onChange={(v) => setSsl({ ...ssl, [r.key]: v, ...(v ? Object.fromEntries((r.needs ?? []).map((k) => [k, true])) : {}) })} />
            </div>
          );
        })}
      </div>
      {!eff.certificate && (
        <Callout tone="sand" title="Without a certificate">
          The site is only reachable over http://. Browsers warn on forms.
        </Callout>
      )}
    </div>
  );
}

/* ---------- 4 Access ----------------------------------------------------------------------------- */

function AccessStep({
  data,
  mode,
  setMode,
  rows,
  add,
  remove,
  setNote,
}: {
  data: WizardData;
  mode: "open" | "list";
  setMode: (m: "open" | "list") => void;
  rows: Row[];
  add: (value: string, note: string) => boolean;
  remove: (values: string[]) => void;
  setNote: (key: number, note: string) => void;
}) {
  const [value, setValue] = useState("");
  const [note, setNoteIn] = useState("");
  const [bad, setBad] = useState<string | null>(null);
  const inList = (v: string) => rows.some((r) => normalize(r.value) === normalize(v));
  const listOn = (l: IpList) => l.entries.every((e) => inList(e.value));
  const toggleList = (l: IpList) => {
    if (listOn(l)) remove(l.entries.map((e) => normalize(e.value)));
    else l.entries.forEach((e) => !inList(e.value) && add(e.value, e.note || (l.named ? l.name : "")));
  };
  const submit = () => {
    const v = value.trim();
    if (!isValidEntry(v)) return setBad("That's not an IP address or range (e.g. 198.51.100.23 or 198.51.100.0/24).");
    if (!add(v, note.trim())) return setBad(`${normalize(v)} is already on the list.`);
    setValue("");
    setNoteIn("");
    setBad(null);
  };
  const missing = mode === "list" ? data.myIps.find((ip) => !rows.some((r) => covers(r.value, ip))) : undefined;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented<"open" | "list">
          ariaLabel="Who can open the site"
          value={mode}
          onChange={setMode}
          options={[
            { id: "open", label: <><Globe className="h-3.5 w-3.5" /> Public</> },
            { id: "list", label: <><ShieldCheck className="h-3.5 w-3.5" /> Allow-listed IPs only</> },
          ]}
        />
        <span className="o-hint">{mode === "open" ? "Anyone on the internet can open the site." : "Everyone else gets a 403. Same as \"Manage access\" – you can change it later."}</span>
      </div>

      {mode === "list" && (
        <>
          {data.ipLists.length > 0 && (
            <div>
              <div className="o-micro mb-2">Allow-lists of your other sites</div>
              <div className="ns-lists">
                {data.ipLists.map((l) => {
                  const on = listOn(l);
                  return (
                    <button key={l.name} type="button" role="checkbox" aria-checked={on} className={cx("ns-list", on && "is-on")} onClick={() => toggleList(l)}>
                      <span className="ns-check" aria-hidden>{on && <Check className="h-3 w-3" />}</span>
                      <span className="min-w-0 flex-1">
                        <span className="ns-list-name">{l.name}</span>
                        <span className="ns-list-meta d-mono">{l.entries.map((e) => e.value).join(", ")}</span>
                        <span className="ns-list-meta">on {l.sites.join(", ")}</span>
                      </span>
                      {l.entries.some((e) => isPrivateRelay(e.value)) && <Pill tone="sand">iCloud Private Relay?</Pill>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {missing && (
            <Callout
              tone="sand"
              icon={UserRound}
              title={`Your current IP (${missing}) isn't on the list – you couldn't open the site yourself.`}
              action={
                <Button size="sm" variant="secondary" onClick={() => add(missing, "my IP")}>
                  <Plus className="h-3.5 w-3.5" /> Add
                </Button>
              }
            />
          )}

          {rows.length > 0 ? (
            <div className="d-table-wrap">
              <table className="d-table">
                <thead>
                  <tr>
                    <th>Address</th>
                    <th>Name</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <td className="is-main whitespace-nowrap">
                        <span className="d-mono">{r.value}</span>
                      </td>
                      <td className="w-full min-w-[160px]">
                        <input className="d-note-input" value={r.note} onChange={(e) => setNote(r.key, e.target.value)} placeholder="Name, e.g. Office" aria-label={`Name for ${r.value}`} spellCheck={false} />
                      </td>
                      <td className="is-right">
                        <IconButton label={`Remove ${r.value}`} size="sm" onClick={() => remove([normalize(r.value)])}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </IconButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Callout tone="rose" title="No address yet">
              Nobody could open the site like this. Pick an allow-list above or add an address below – or switch to "Public".
            </Callout>
          )}

          <form
            className="ns-add"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="o-micro">IP or range</div>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              <input
                className={cx("o-input d-mono", bad && "is-bad")}
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setBad(null);
                }}
                placeholder="198.51.100.23 or 198.51.100.0/24"
                aria-label="IP or range"
                spellCheck={false}
                autoComplete="off"
              />
              <input className="o-input" value={note} onChange={(e) => setNoteIn(e.target.value)} placeholder="Name (optional)" aria-label="Name" autoComplete="off" />
              <Button type="submit" variant="secondary" disabled={!value.trim()}>
                <Plus className="h-4 w-4" /> Add
              </Button>
            </div>
            {bad && <p className="o-field-error">{bad}</p>}
            {data.myIps.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {data.myIps.map((ip) => (
                  <Button key={ip} size="sm" variant="ghost" disabled={rows.some((r) => covers(r.value, ip))} onClick={() => add(ip, "my IP")}>
                    <UserRound className="h-3.5 w-3.5" /> My IP <span className="d-mono o-mute">{ip}</span>
                  </Button>
                ))}
              </div>
            )}
          </form>
        </>
      )}
    </div>
  );
}

/* ---------- 5 Review & create -------------------------------------------------------------------- */

const STEP_ICON: Record<JobStepState, LucideIcon> = {
  pending: Circle,
  running: RefreshCw,
  ok: CheckCircle2,
  failed: XCircle,
  warning: AlertTriangle,
  skipped: MinusCircle,
  cancelled: MinusCircle,
};

const FLAG_LABEL: Partial<Record<SslKey, string>> = {
  certificate: "Certificate",
  sslForced: "HTTPS forced",
  hsts: "HSTS",
  hstsSubdomains: "+ subdomains",
  http2: "HTTP/2",
  blockExploits: "Exploits blocked",
  caching: "Cache",
  websockets: "WebSockets",
};

function ReviewStep({
  data,
  names,
  target,
  port,
  scheme,
  ssl,
  mode,
  rows,
  job,
  startErr,
  onEdit,
}: {
  data: WizardData;
  names: string[];
  target: Target | null;
  port: number;
  scheme: string;
  ssl: SslFlags;
  mode: "open" | "list";
  rows: Row[];
  job: HostJob | null;
  startErr: string | null;
  onEdit: (i: number) => void;
}) {
  const isDefault = sameFlags(ssl, settle(data.defaults.values));
  const on = (Object.keys(FLAG_LABEL) as SslKey[]).filter((k) => ssl[k]);
  const lines: [ReactNode, ReactNode, number][] = [
    ["Address", <span className="d-mono">{names.map((n) => `${ssl.certificate ? "https" : "http"}://${n}`).join("  ·  ")}</span>, 0],
    [
      "Target",
      <>
        <span className="d-mono">
          {scheme}://{target?.name}:{port}
        </span>
        {target?.project && <span className="o-mute"> · stack {target.project}</span>}
      </>,
      1,
    ],
    [
      "SSL & security",
      <span className="flex flex-wrap gap-1.5">
        {isDefault && <Pill tone="accent">like your other sites</Pill>}
        {on.map((k) => (
          <Pill key={k} tone="neutral">
            {FLAG_LABEL[k]}
          </Pill>
        ))}
      </span>,
      2,
    ],
    [
      "Access",
      mode === "open" ? (
        "Public"
      ) : (
        <span>
          {num(rows.length)} {rows.length === 1 ? "address" : "addresses"}: <span className="d-mono">{rows.map((r) => (r.note ? `${r.value} (${r.note})` : r.value)).join(", ")}</span>
        </span>
      ),
      3,
    ],
  ];

  if (!job) {
    return (
      <div className="flex flex-col gap-4">
        <dl className="ns-summary">
          {lines.map(([k, v, i]) => (
            <div key={i}>
              <dt>{k}</dt>
              <dd>{v}</dd>
              <button type="button" className="ns-edit" onClick={() => onEdit(i)}>
                Edit
              </button>
            </div>
          ))}
        </dl>
        <p className="o-hint">
          Then: create host → {ssl.certificate ? "get certificate → force HTTPS → " : ""}test request. {ssl.certificate && "If the certificate fails, the host is removed again – nothing is left half-done."}
        </p>
        {startErr && (
          <Callout tone="rose" title="Not created">
            {startErr}
          </Callout>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ol className="ns-run">
        {job.steps.map((s) => {
          const Icon = STEP_ICON[s.state];
          return (
            <li key={s.key} className={cx("ns-run-step", `is-${STATE_CLASS[s.state]}`)}>
              <span className="ns-run-icon">
                <Icon className={cx("h-[18px] w-[18px]", s.state === "running" && "o-spin")} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="ns-run-label">
                  {s.label}
                  {(s.state === "skipped" || s.state === "cancelled") && <span className="o-mute"> · {STATE_LABEL[s.state]}</span>}
                </div>
                {s.detail && <div className="ns-run-detail">{s.detail}</div>}
              </div>
            </li>
          );
        })}
      </ol>
      {job.state === "failed" && (
        <Callout tone="rose" title={job.rollback.every((r) => r.ok) ? "Not created – everything was rolled back" : "Not created – rollback incomplete"}>
          <p>{job.error}</p>
          {job.rollback.length > 0 && (
            <ul className="ns-rollback">
              {job.rollback.map((r) => (
                <li key={r.label} className={cx(!r.ok && "is-bad")}>
                  {r.ok ? <Check className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />} {r.label}
                </li>
              ))}
            </ul>
          )}
          {job.steps.find((s) => s.key === "cert")?.state === "failed" && <p className="o-hint">Usually DNS hasn't propagated everywhere yet, or port 80 isn't reachable. Let's Encrypt allows 5 failed attempts per hour and domain.</p>}
        </Callout>
      )}
      {job.state === "done" && job.url && (
        <Callout
          tone="ok"
          title={`${job.domain} is live`}
          action={
            <a className="o-btn o-btn-secondary o-btn-sm" href={job.url} target="_blank" rel="noreferrer">
              Open <ArrowUpRight className="h-3.5 w-3.5" />
            </a>
          }
        >
          It now shows under Services, next to its container
          {target?.project ? <> (stack <b>{target.project}</b>)</> : null}.{" "}
          <a className="ns-link d-mono" href={job.url} target="_blank" rel="noreferrer">
            {job.url}
          </a>
        </Callout>
      )}
    </div>
  );
}

/* ---------- footer ------------------------------------------------------------------------------- */

function Foot({
  step,
  valid,
  canCreate,
  withCert,
  running,
  job,
  onBack,
  onNext,
  onStart,
  onRetry,
}: {
  step: number;
  valid: boolean;
  canCreate: boolean;
  withCert: boolean;
  running: boolean;
  job: HostJob | null;
  onBack: () => void;
  onNext: () => void;
  onStart: () => void;
  onRetry: () => void;
}) {
  const close = useCloseOverlay();
  const last = step === STEPS.length - 1;
  return (
    <div className="o-dialog-foot">
      <span className="o-hint mr-auto">
        {job?.state === "running" ? "Running – keep this open…" : `Step ${step + 1} of ${STEPS.length}`}
      </span>
      {job?.state === "done" ? (
        <Button variant="primary" onClick={() => close()}>
          <Check className="h-4 w-4" /> Done
        </Button>
      ) : job?.state === "failed" ? (
        <>
          <Button variant="ghost" onClick={() => close()}>
            Close
          </Button>
          <Button variant="secondary" onClick={onRetry}>
            <ArrowLeft className="h-4 w-4" /> Back to review
          </Button>
        </>
      ) : (
        <>
          {step > 0 && (
            <Button variant="ghost" onClick={onBack} disabled={running}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
          )}
          {last ? (
            <Button variant="primary" onClick={onStart} disabled={!canCreate || running} title={canCreate ? undefined : "Save the Proxy Manager login first"}>
              {running ? <RefreshCw className="h-4 w-4 o-spin" /> : <Rocket className="h-4 w-4" />}
              {running ? "Creating…" : withCert ? "Create & get certificate" : "Create"}
            </Button>
          ) : (
            <Button variant="primary" onClick={onNext} disabled={!valid}>
              Next <ArrowRight className="h-4 w-4" />
            </Button>
          )}
        </>
      )}
    </div>
  );
}
