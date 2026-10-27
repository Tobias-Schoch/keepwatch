import { ArrowUpRight, ChevronDown, KeyRound, Plus, Rocket, Ship } from "lucide-react";
import { useEffect, useState } from "react";
import { EVERY, usePoll } from "../api";
import { useConfig } from "../config";
import { Chips, Loading, PageHero, Stale, StateDot } from "../common";
import { Button, Callout, cx, Panel, Pill, type Tone } from "../design/ui";
import { agoShort, bytes, duration, pct, plural, shortDateTime, span } from "../format";
import { LogsButton } from "../logs/LogsButton";
import { useNav } from "../nav";
import { openSetting } from "./settingsOpen";
import type { Container, Docker, Site, Sites, Stack, Stacks } from "../types";
import { useUpdates } from "../updates";
import { capitalize, INFRA_IMAGE, stackName, unmanagedName } from "../stackNames";
import { portainerStackPath, toolHref, useTool } from "../tools";
import { fmtUptime, useUptime, type UptimeSite, type UptimeSummary } from "../uptime";
import { Detail, HEALTH_LABEL, STATE_LABEL, stateTone } from "./Containers";
import { NewSiteWizard } from "./NewSite";
import { ServiceScore, SiteGradeProvider } from "./SiteGrade";
import { RenewDueButton, siteHost, SiteList, siteTone, useSiteActions } from "./Sites";
import { branch, EnvSheet, Redeploy, repoName } from "./Stacks";
import { BlockUpdates, gitText, Maintenance } from "./Updates";
import { setServiceOpen, takeWantedSite, useServiceOpen, useWantedSite } from "./servicesStore";
import { versionOf, type Updates } from "../updates";
import "./services.css";
import "./servicesPalette";

/**
 * Services: one quiet row per stack – status, name, "Security <score>/100" and "Uptime <value> %", logs. Both figures
 * cover all sites of the service together: deductions and downtime add up, they are not averaged. Problems show in the
 * status dot; the details are one click away.
 * Expanded (click the row, remembered in the browser) the summary in the header gives way to the rows below:
 * repo and deployed commit with variables and redeploy, sites (grade, problems, uptime, access),
 * images only with an update, vulnerabilities or "roll back", containers (problems, memory · CPU). Details in tooltips.
 * Site → service comes from the proxy target ("container:port"): the container belongs to the stack,
 * so the site does too. Compose projects Portainer does not manage are named by stackNames.ts: Keepwatch's own
 * ("Proxy Manager", "Portainer") sort after the services, hand-started ones show "not managed by Portainer".
 * Sites without a known container end up under "Other".
 *
 * Modules: the page needs docker. Stacks, variables and redeploy need portainer – without it, containers
 * are grouped by their compose project. Sites, certificates, grades and uptime need proxy – without it a row has no
 * Security/Uptime figures at all.
 */

interface Block {
  key: string;
  title: string;
  /** Small secondary text next to the title ("not managed by Portainer"), not part of the title (jumps match it exactly). */
  hint: string | null;
  stack: Stack | null;
  kind: "stack" | "infra" | "other";
  containers: Container[];
  sites: Site[];
  missing: string[];
}

const worst = (t: Tone[]): Tone => (t.includes("rose") ? "rose" : t.includes("sand") ? "sand" : "ok");
const isProblem = (c: Container) => stateTone(c) !== "ok";
const stateLabel = (c: Container) => (c.state === "running" && c.health ? HEALTH_LABEL[c.health] : STATE_LABEL[c.state]);

function blockTone(b: Block): Tone {
  if (b.missing.length) return "rose";
  return worst([...b.containers.map(stateTone), ...b.sites.filter((s) => s.enabled).map(siteTone)]);
}

/** `portainer`: the module is on – only then is "not managed by Portainer" worth saying. */
function buildBlocks(stacks: Stack[], containers: Container[], sites: Site[], portainer: boolean): Block[] {
  const used = new Set<string>();
  const blocks: Block[] = stacks.map((s) => {
    const list = containers.filter((c) => s.containers.includes(c.name) || (c.project !== null && c.project === s.name));
    list.forEach((c) => used.add(c.name));
    const name = stackName(s, list);
    return {
      key: s.name,
      title: name.title,
      hint: portainer ? name.hint : null,
      stack: s,
      kind: s.managed ? "stack" : "infra",
      containers: list,
      sites: [],
      missing: containers.length ? s.containers.filter((n) => !list.some((c) => c.name === n)) : [],
    };
  });
  // Containers outside a known stack: grouped by compose project (all of them without Portainer).
  const projects = new Map<string, Container[]>();
  for (const c of containers) if (!used.has(c.name) && c.project) projects.set(c.project, [...(projects.get(c.project) ?? []), c]);
  for (const [project, list] of projects) {
    list.forEach((c) => used.add(c.name));
    const infra = list.some((c) => INFRA_IMAGE.test(c.image));
    const name = infra ? unmanagedName(project, list.map((c) => c.image)) : { title: capitalize(project), hint: null };
    blocks.push({ key: `~project:${project}`, title: name.title, hint: portainer ? name.hint : null, stack: null, kind: infra ? "infra" : "stack", containers: list, sites: [], missing: [] });
  }
  const loose = containers.filter((c) => !used.has(c.name));
  const other: Block = { key: "~other", title: "Other", hint: null, stack: null, kind: "other", containers: loose, sites: [], missing: [] };
  for (const site of sites) {
    const host = siteHost(site);
    const b = blocks.find((x) => x.containers.some((c) => c.name === host) || x.stack?.containers.includes(host));
    (b ?? other).sites.push(site);
  }
  const sortC = (a: Container, b: Container) => Number(isProblem(b)) - Number(isProblem(a)) || a.name.localeCompare(b.name);
  [...blocks, other].forEach((b) => b.containers.sort(sortC));
  const rank = (b: Block) => (blockTone(b) === "rose" ? 0 : blockTone(b) === "sand" ? 1 : 2) * 10 + (b.kind === "stack" ? 0 : b.kind === "infra" ? 1 : 2);
  return [...blocks, ...(other.containers.length || other.sites.length ? [other] : [])].sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
}

/** Containers of a service: name, only problems, memory · CPU on the right. Click opens logs and actions. */
function ContainerList({ list, u, onOpen }: { list: Container[]; u: Updates | null; onOpen: (name: string) => void }) {
  return (
    <div className="svc-rows">
      {list.map((c) => {
        const tone = stateTone(c);
        const running = c.state === "running";
        const img = u?.images.find((i) => i.containers.includes(c.name));
        const info = [
          running && c.startedAt ? `up ${span(Date.now() / 1000 - c.startedAt)}` : c.status,
          img ? `${img.ref} · ${versionOf(img.local)}` : null,
          c.restartCount ? plural(c.restartCount, "restart", "restarts") : null,
        ]
          .filter(Boolean)
          .join("\n");
        return (
          <button key={c.name} type="button" className={cx("svc-row svc-row-btn", tone === "rose" && "is-bad")} onClick={() => onOpen(c.name)} title={info} aria-label={`${c.name} – logs and actions`}>
            <span className="svc-row-main">
              <span className="svc-row-name">{c.name}</span>
              {tone !== "ok" && (
                <span className="svc-issue" data-tone={tone}>
                  {stateLabel(c)}
                </span>
              )}
              {c.restartCount > 3 && (
                <span className="svc-issue" data-tone="sand">
                  {plural(c.restartCount, "restart", "restarts")}
                </span>
              )}
              {c.privileged && (
                <span className="svc-issue" data-tone="rose">
                  privileged
                </span>
              )}
              {c.dockerSock && (
                <span className="svc-issue" title="Has access to docker.sock – effectively root on the server">
                  docker.sock
                </span>
              )}
            </span>
            {running && (
              <span className="svc-row-side svc-num">
                {bytes(c.memUsed)} · {pct(c.cpuPct, 1)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * "Uptime 99.9988 %" in the header: the downtime of all enabled sites over the last 30 days added up, not averaged
 * (three sites with 8 minutes of downtime between them count 8 minutes, not 2.7). Nothing without uptime data.
 */
function ServiceUptime({ sites, uptime }: { sites: Site[]; uptime: UptimeSummary | null }) {
  const list = sites
    .filter((s) => s.enabled)
    .map((s) => uptime?.sites.find((u) => u.domain === s.domains[0]))
    .filter((u): u is UptimeSite & { uptime30: number } => u?.uptime30 != null);
  if (!list.length) return null;
  const value = Math.max(0, 100 - list.reduce((n, u) => n + (100 - u.uptime30), 0));
  const down = list.filter((u) => u.down);
  const tone: Tone = down.length ? "rose" : value < 99 ? "sand" : "ok";
  const now = Date.now() / 1000;
  const title = [
    ...down.map((u) => `${u.domain}: down for ${duration(now - (u.downSince ?? now))}${u.downReason ? ` – ${u.downReason}` : ""}`),
    ...list.map((u) => `${u.domain}: ${fmtUptime(u.uptime30)} %`),
    list.length > 1 ? "Last 30 days, downtime of all sites added up" : "Last 30 days",
  ].join("\n");
  return (
    <span className="svc-issue" data-tone={tone} title={title}>
      Uptime {fmtUptime(value)} %
    </span>
  );
}

interface RowProps {
  b: Block;
  open: boolean;
  u: Updates | null;
  uptime: UptimeSummary | null;
  connected: boolean;
  site: ReturnType<typeof useSiteActions>;
  onContainer: (name: string) => void;
  onEnv: (s: Stack) => void;
  onDeploy: (s: Stack) => void;
  onUpdated: () => void;
}

/** One service: a single row when collapsed, everything else when expanded. */
function ServiceRow({ b, open, u, uptime, connected, site, onContainer, onEnv, onDeploy, onUpdated }: RowProps) {
  const s = b.stack;
  const names = b.containers.map((c) => c.name);
  const tone = blockTone(b);
  const live = b.sites.filter((x) => x.enabled);
  const toggle = () => setServiceOpen(b.key, !open);
  return (
    <Panel className={cx("d-block svc-block", open && "is-open")} id={`service-${b.key}`}>
      <div
        className="d-block-head svc-head"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a, button:not(.svc-toggle)")) return;
          toggle();
        }}
      >
        <button type="button" className="svc-toggle" aria-expanded={open} aria-label={`${b.title}: ${open ? "collapse" : "expand"} details`}>
          <ChevronDown className={cx("o-chev h-4 w-4", open && "is-open")} />
        </button>
        <StateDot tone={tone} />
        <h2 className="d-block-title">{b.title}</h2>
        {b.hint && <span className="svc-issue -ml-2 whitespace-nowrap">{b.hint}</span>}
        {!open && (
          <span className="svc-info">
            <ServiceScore sites={live.map((x) => ({ id: x.id, domain: x.domains[0] }))} />
            <ServiceUptime sites={live} uptime={uptime} />
          </span>
        )}
        <LogsButton title={b.title} containers={names} className="ml-auto" />
      </div>
      {open && (
        <div className="svc-detail">
          <Meta b={b} u={u} connected={connected} onEnv={onEnv} onDeploy={onDeploy} />
          {b.sites.length > 0 && <SiteList sites={b.sites} busy={site.busy} onRenew={site.askRenew} onAccess={site.openAccess} />}
          <BlockUpdates stack={s?.name ?? null} containers={names} u={u} onDone={onUpdated} />
          {b.containers.length > 0 ? <ContainerList list={b.containers} u={u} onOpen={onContainer} /> : !b.sites.length && <p className="d-empty">No containers reported.</p>}
        </div>
      )}
    </Panel>
  );
}

/** First row of an expanded service: repo, deployed commit, auto-update – variables and redeploy on the right. */
function Meta({ b, u, connected, onEnv, onDeploy }: { b: Block; u: Updates | null; connected: boolean; onEnv: (s: Stack) => void; onDeploy: (s: Stack) => void }) {
  const s = b.stack;
  if (!s?.managed) return null;
  const can = connected && s.id !== null;
  const git = gitText(u, s.name);
  const portainer = useTool("portainer");
  const inPortainer = portainer && portainerStackPath(s);
  return (
    <div className="svc-meta">
      <span className="svc-meta-bits">
        {s.git ? (
          <a className="d-group-repo" href={s.git.url} target="_blank" rel="noreferrer" title={`${repoName(s.git.url)} · Branch ${branch(s.git.ref)}`}>
            <span className="d-mono">{s.name}</span>
            <span className="o-mute">@{branch(s.git.ref)}</span> <ArrowUpRight className="inline h-3 w-3 align-[-1px]" />
          </a>
        ) : (
          <span className="d-mono">{s.name}</span>
        )}
        {git ? <span title="Deployed commit">{git}</span> : s.updatedAt ? <span title={shortDateTime(s.updatedAt)}>changed {agoShort(s.updatedAt)}</span> : null}
        {s.autoUpdate && <span title="Portainer polls the repository and deploys new commits by itself">Auto-update every {s.autoUpdate}</span>}
      </span>
      <span className="svc-meta-act">
        {portainer && inPortainer && (
          <a className="o-btn o-btn-ghost o-btn-sm" href={toolHref(portainer, inPortainer)} target="_blank" rel="noopener" title={`Open the stack ${s.name} in Portainer`}>
            <Ship className="h-3.5 w-3.5" /> Portainer <ArrowUpRight className="h-3 w-3 text-[var(--o-faint)]" />
          </a>
        )}
        <Button size="sm" variant="ghost" onClick={() => onEnv(s)} disabled={s.id === null}>
          <KeyRound className="h-3.5 w-3.5" /> Variables{s.envCount !== null ? ` · ${s.envCount}` : ""}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onDeploy(s)} disabled={!can} title={can ? undefined : "Needs a Portainer token"}>
          <Rocket className="h-3.5 w-3.5" /> Redeploy
        </Button>
      </span>
    </div>
  );
}

export function ServicesPage() {
  const { modules } = useConfig();
  // Grades (/api/sitegrade) only exist with the proxy module.
  return modules.proxy !== false ? (
    <SiteGradeProvider>
      <ServicesBody />
    </SiteGradeProvider>
  ) : (
    <ServicesBody />
  );
}

/** Command palette → site: expand the service that holds it (collapsed rows have no domain links). */
function OpenWantedSite({ blocks, ready }: { blocks: Block[]; ready: boolean }) {
  const want = useWantedSite();
  useEffect(() => {
    // ready: stacks and sites are in – before that a service may still be keyed by its compose project
    if (!want || !ready) return;
    const b = blocks.find((x) => x.sites.some((s) => s.domains.some((d) => d.toLowerCase() === want)));
    if (!b) return; // sites not loaded yet – try again with the next data
    takeWantedSite();
    setServiceOpen(b.key, true);
  }, [want, blocks, ready]);
  return null;
}

/** Subscribes to /api/uptime only while mounted – i.e. only with the proxy module. */
function UptimeFeed({ onData }: { onData: (u: UptimeSummary | null) => void }) {
  const data = useUptime().data;
  useEffect(() => onData(data), [data, onData]);
  return null;
}

function ServicesBody() {
  const { go } = useNav();
  const { modules } = useConfig();
  const proxy = modules.proxy !== false;
  const portainer = modules.portainer !== false;
  const scanOn = modules["image-scan"] !== false;
  const dk = usePoll<Docker>("/api/docker", EVERY.docker);
  const st = usePoll<Stacks>(portainer ? "/api/stacks" : null, EVERY.stacks);
  const sitesPoll = usePoll<Sites>(proxy ? "/api/sites" : null, EVERY.sites);
  const site = useSiteActions(sitesPoll);
  const upd = useUpdates(true);
  const [uptime, setUptime] = useState<UptimeSummary | null>(null);
  const openSet = useServiceOpen();
  const [open, setOpen] = useState<string | null>(null);
  const [env, setEnv] = useState<Stack | null>(null);
  const [deploy, setDeploy] = useState<Stack | null>(null);
  const [newSite, setNewSite] = useState(false);

  return (
    <div className="o-wrap d-page">
      <Loading data={dk.data} error={dk.error}>
        {(d) => {
          const list = d.containers;
          const stacks = (portainer && st.data?.stacks) || [];
          const sd = proxy ? sitesPoll.data : null;
          const blocks = buildBlocks(stacks, list, sd?.sites ?? [], portainer);
          const services = blocks.filter((b) => b.kind === "stack");
          const bad = blocks.filter((b) => blockTone(b) !== "ok");
          const connected = st.data?.portainer.connected ?? false;
          const cur = list.find((c) => c.name === open);
          const sc = scanOn ? upd.data?.scan : undefined;
          return (
            <>
              <OpenWantedSite blocks={blocks} ready={(!portainer || !!st.data) && (!proxy || !!sd)} />
              <PageHero
                title={bad.length ? `${plural(bad.length, "service needs", "services need")} you.` : `${plural(services.length, "service", "services")} running.`}
                shine={bad.length ? 2 : 1}
                lead={
                  (sc?.running || upd.data?.checking) && (
                    <Chips>
                      {sc?.running && <Pill tone="accent">Security scan running</Pill>}
                      {upd.data?.checking && <Pill tone="accent">Checking for updates …</Pill>}
                    </Chips>
                  )
                }
                aside={
                  <div className="flex items-center gap-3">
                    <Stale error={dk.error ?? st.error ?? sitesPoll.error} at={dk.at} />
                    {sd && <RenewDueButton d={sd} busy={site.busy} onClick={site.renewDue} />}
                    {proxy && (
                      <Button variant="primary" onClick={() => setNewSite(true)}>
                        <Plus className="h-4 w-4" /> New site
                      </Button>
                    )}
                  </div>
                }
              />
              {portainer && st.data?.portainer && !st.data.portainer.connected && (
                <Callout
                  tone="sand"
                  className="mb-6"
                  title="Portainer isn’t connected – actions are locked"
                  action={
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => {
                        go("settings");
                        openSetting("portainer");
                      }}
                    >
                      Add token
                    </Button>
                  }
                >
                  {st.data.portainer.reason ?? "An access token from Portainer is missing."}
                </Callout>
              )}
              {sd?.defaultSite === "congratulations" && (
                <Callout tone="sand" className="mb-6" title="The bare IP shows the Proxy Manager’s welcome page">
                  In the Proxy Manager: Settings → Default Site → “444”.
                </Callout>
              )}
              <div className="svc-list">
                {blocks.map((b) => (
                  <ServiceRow
                    key={b.key}
                    b={b}
                    open={openSet.has(b.key)}
                    u={upd.data}
                    uptime={uptime}
                    connected={connected}
                    site={site}
                    onContainer={setOpen}
                    onEnv={setEnv}
                    onDeploy={setDeploy}
                    onUpdated={upd.refresh}
                  />
                ))}
              </div>
              <Maintenance p={upd} onCleaned={() => void dk.refresh()} />
              {proxy && <UptimeFeed onData={setUptime} />}
              {site.dialogs}
              {proxy && newSite && <NewSiteWizard onClose={() => (setNewSite(false), void sitesPoll.refresh())} />}
              {cur && <Detail key={cur.name} c={cur} onClose={() => setOpen(null)} />}
              {portainer && env && <EnvSheet s={env} canEdit={connected} onClose={() => setEnv(null)} />}
              {portainer && deploy && <Redeploy s={deploy} onClose={() => setDeploy(null)} />}
            </>
          );
        }}
      </Loading>
    </div>
  );
}
