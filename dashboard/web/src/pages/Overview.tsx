import { ArrowRight, Boxes, DatabaseBackup, Globe, Layers, Settings2, ShieldAlert, type LucideIcon } from "lucide-react";
import { useRef, useState } from "react";
import { AreaChart, niceBytes, Spark } from "../charts";
import { Chips, FoldToggle, Loading, Meter, PageHero, Section, Stale, Tile } from "../common";
import { Reveal } from "../design/fx";
import { Counter } from "../design/rb/tiles/Counter";
import { Button, KeyValue, Panel, Pill, Segmented } from "../design/ui";
import { agoShort, bytes, clock, clockSec, dateTime, num, pct, plural, rate, span } from "../format";
import { useHas } from "../config";
import { followProblem, useNav, viewOfProblem } from "../nav";
import type { Area, Overview as O, Problem } from "../types";
import { useUpdates } from "../updates";
import { TimelineRecentSection } from "./Timeline";
import { UpdatesChip } from "./Updates";

const AREA_ICON: Record<Area, LucideIcon> = {
  security: ShieldAlert,
  docker: Boxes,
  sites: Globe,
  backups: DatabaseBackup,
  system: Settings2,
  stacks: Layers,
};

function Health({ list, onMachine }: { list: Problem[]; onMachine: () => void }) {
  const { go } = useNav();
  const sorted = [...list].sort((a, b) => (a.level === b.level ? 0 : a.level === "crit" ? -1 : 1));
  return (
    <div className="o-alist">
      <div className="o-alist-scroll">
        {sorted.map((p, i) => {
          const Icon = AREA_ICON[p.area];
          const target = viewOfProblem(p);
          return (
            <Reveal key={p.key + p.title} delay={120 + Math.min(i, 8) * 45} className="o-todo">
              <div className="o-todo-in" data-tone={p.level === "crit" ? "rose" : "sand"}>
                <span className="o-todo-icon">
                  <Icon className="h-4 w-4" strokeWidth={1.8} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="o-todo-name">{p.title}</span>
                    <Pill tone={p.level === "crit" ? "rose" : "sand"}>{p.level === "crit" ? "Critical" : "Warning"}</Pill>
                  </div>
                  <div className="o-todo-detail">{p.detail}</div>
                </div>
                <Button size="sm" variant={p.level === "crit" ? "primary" : "secondary"} className="o-todo-act" onClick={() => (target === "overview" && !p.target ? onMachine() : followProblem(go, p))}>
                  View
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </Reveal>
          );
        })}
      </div>
    </div>
  );
}

/** The fullest disk counts; all of them are in the tooltip and under "Machine". */
function fullestDisk(o: O) {
  return [...o.now.disks].sort((a, b) => b.used / Math.max(1, b.total) - a.used / Math.max(1, a.total))[0] ?? null;
}

function Kpis({ o, onMachine }: { o: O; onMachine: () => void }) {
  const memShare = o.now.mem.used / o.now.mem.total;
  const disk = fullestDisk(o);
  const diskShare = disk ? disk.used / disk.total : 0;
  const u = o.updates;
  const allDisks = o.now.disks.map((d) => `${d.mount}: ${pct((d.used / d.total) * 100)} · ${bytes(d.total - d.used, 0)} free`).join("\n");
  return (
    <section className="d-kpis" aria-label="Key metrics">
      <Tile label="CPU" delay={80} seed={1}>
        <div className="o-tile-value">
          <Counter value={Math.round(o.now.cpu)} delay={160} />
          <span className="d-unit">%</span>
        </div>
        <Spark values={o.live.cpu} max={100} />
        <div className="o-tile-sub o-num" title="Load average over 1, 5 and 15 minutes">
          Load {o.now.load.map((l) => num(l, 2)).join(" · ")}
        </div>
      </Tile>
      <Tile label="Memory" delay={120} seed={2}>
        <div className="o-tile-value">
          <Counter value={Math.round(memShare * 100)} delay={200} />
          <span className="d-unit">%</span>
        </div>
        <Meter share={memShare} />
        <div className="o-tile-sub">
          {bytes(o.now.mem.used)} of {bytes(o.now.mem.total, 0)}
        </div>
      </Tile>
      <Tile label={`Disk ${disk?.mount ?? ""}`} delay={160} seed={3} title={allDisks}>
        <div className="o-tile-value">
          <Counter value={Math.round(diskShare * 100)} delay={240} />
          <span className="d-unit">%</span>
        </div>
        <Meter share={diskShare} />
        <div className="o-tile-sub">{disk ? `${bytes(disk.total - disk.used, 0)} free` : "—"}</div>
      </Tile>
      <Tile label="Network" delay={200} seed={4}>
        <div className="d-net o-num">
          <span title="Out">↑ {rate(o.now.net.txBps)}</span>
          <span title="In">↓ {rate(o.now.net.rxBps)}</span>
        </div>
        <Spark values={o.live.tx} color="var(--d-s2)" />
      </Tile>
      <Tile label="Updates" delay={240} seed={5} onClick={onMachine} title="Details under Machine">
        <div className="o-tile-value">{u.pending === 0 ? <span className="d-tile-word">up to date</span> : <Counter value={u.pending} delay={280} />}</div>
        <div className="o-tile-sub">
          {u.rebootRequired ? <span className="text-[var(--o-sand)]">Reboot required</span> : u.pending ? `${u.security} security` : `last ${agoShort(u.lastUpgrade)}`}
        </div>
      </Tile>
    </section>
  );
}

type Range = "live" | "24h";

function Charts({ o }: { o: O }) {
  const [range, setRange] = useState<Range>("24h");
  const src = range === "live" ? o.live : o.history;
  const tf = range === "live" ? clockSec : clock;
  return (
    <Section
      title="Load"
      aside={
        <Segmented<Range>
          ariaLabel="Time range"
          size="sm"
          value={range}
          onChange={setRange}
          options={[
            { id: "live", label: "15 min live" },
            { id: "24h", label: "24 hr" },
          ]}
        />
      }
    >
      <div className="d-grid d-grid-2">
        <Panel>
          <h3 className="o-h2 mb-3">CPU & RAM</h3>
          <AreaChart
            t={src.t}
            height={196}
            series={[
              { label: "CPU", values: src.cpu, color: "var(--d-mono)" },
              { label: "RAM", values: src.mem, color: "var(--d-s1)" },
            ]}
            yMax={100}
            format={(v) => `${num(v)}%`}
            timeFormat={tf}
          />
        </Panel>
        <Panel>
          <h3 className="o-h2 mb-3">Network</h3>
          <AreaChart
            t={src.t}
            height={196}
            series={[
              { label: "In", values: src.rx, color: "var(--d-s1)" },
              { label: "Out", values: src.tx, color: "var(--d-s2)" },
            ]}
            format={(v) => rate(v)}
            nice={niceBytes}
            timeFormat={tf}
          />
        </Panel>
      </div>
    </Section>
  );
}

/** Host details that are not already in the tiles. */
function Machine({ o, open, onToggle }: { o: O; open: boolean; onToggle: () => void }) {
  const u = o.updates;
  return (
    <Panel className="mt-8 d-fold-panel">
      <FoldToggle open={open} onToggle={onToggle}>
        Machine
        <span className="d-fold-meta">
          {u.release} · Kernel {o.host.kernel}
        </span>
        {u.newRelease && <Pill tone="accent">{u.newRelease} available</Pill>}
        {u.rebootRequired && <Pill tone="sand">Reboot required</Pill>}
      </FoldToggle>
      {open && (
        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <KeyValue
            items={[
              ["Release", u.newRelease ? <span className="inline-flex flex-wrap items-center justify-end gap-2">{u.release} <Pill tone="accent">{u.newRelease} available</Pill></span> : u.release],
              ["Kernel", <span className="d-mono">{o.host.kernel}</span>],
              ["Booted", `${dateTime(o.host.bootTime)}`],
              ["Disks", o.now.disks.map((d) => `${d.mount} ${pct((d.used / d.total) * 100)}`).join(" · ")],
            ]}
          />
          <KeyValue
            items={[
              ["Pending updates", u.pending ? <Pill tone="sand">{u.pending}</Pill> : "none"],
              ["Security updates", u.security ? <Pill tone="rose">{u.security}</Pill> : "0"],
              ["Reboot required", u.rebootRequired ? <Pill tone="sand">yes · sites down for ~1 min</Pill> : "no"],
              ["Last upgrade", dateTime(u.lastUpgrade)],
            ]}
          />
        </div>
      )}
    </Panel>
  );
}

/** Image updates (docker module): its own component, so /api/updates is only polled when Docker is installed. */
function ServiceUpdates({ onClick }: { onClick: () => void }) {
  const upd = useUpdates();
  return <UpdatesChip u={upd.data} services onClick={onClick} />;
}

export function OverviewPage() {
  const { overview, overviewError, overviewAt, go } = useNav();
  const docker = useHas("docker");
  const [machine, setMachine] = useState(false);
  const machineRef = useRef<HTMLDivElement>(null);
  const showMachine = () => {
    setMachine(true);
    requestAnimationFrame(() => machineRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };
  return (
    <div className="o-wrap d-page">
      <Loading data={overview} error={overviewError}>
        {(o) => {
          const crit = o.health.filter((h) => h.level === "crit").length;
          const u = o.updates;
          const title = o.health.length === 0 ? "All systems normal." : o.health.length === 1 ? "One thing needs you." : `${o.health.length} things need you.`;
          return (
            <>
              <PageHero
                big
                title={title}
                lead={
                  <Chips>
                    {crit > 0 && <Pill tone="rose">{crit} critical</Pill>}
                    <Pill tone="neutral" title={`Booted ${dateTime(o.host.bootTime)}`}>
                      up {span(o.host.uptimeSec)}
                    </Pill>
                    <Pill tone={u.pending ? "sand" : "neutral"}>{u.pending ? plural(u.pending, "system update", "system updates") : "System up to date"}</Pill>
                    {docker && <ServiceUpdates onClick={() => go("services")} />}
                    {u.rebootRequired && <Pill tone="sand">Reboot required</Pill>}
                  </Chips>
                }
                aside={<Stale error={overviewError} at={overviewAt} />}
              />
              {o.health.length > 0 && (
                <section className="mb-8" aria-label="Needs attention">
                  <Health list={o.health} onMachine={showMachine} />
                </section>
              )}
              <Kpis o={o} onMachine={showMachine} />
              <TimelineRecentSection />
              <Charts o={o} />
              <div ref={machineRef}>
                <Machine o={o} open={machine} onToggle={() => setMachine((v) => !v)} />
              </div>
            </>
          );
        }}
      </Loading>
    </div>
  );
}
