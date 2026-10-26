import { AlertTriangle, Power, RotateCcw, Square, TerminalSquare } from "lucide-react";
import { useState } from "react";
import { api, refreshAll } from "../api";
import { Button, Confirm, cx, DialogHead, KeyValue, Overlay, Pill, type ConfirmCopy, type Tone } from "../design/ui";
import { ago, bytes, num, pct } from "../format";
import { LogView } from "../logs/LogView";
import { openLogs } from "../logs/open";
import { useAction } from "../messages";
import type { Container } from "../types";

export function stateTone(c: Pick<Container, "state" | "health">): Tone {
  if (c.state !== "running") return c.state === "restarting" ? "sand" : "rose";
  if (c.health === "unhealthy") return "rose";
  if (c.health === "starting") return "sand";
  return "ok";
}

export const STATE_LABEL: Record<Container["state"], string> = {
  running: "running",
  exited: "stopped",
  restarting: "restarting",
  paused: "paused",
  created: "created",
  dead: "dead",
};

export const HEALTH_LABEL = { healthy: "healthy", unhealthy: "unhealthy", starting: "checking …" } as const;

/** Containers whose restart affects more than themselves – matched by image, whatever the container is called. */
const CRITICAL: [RegExp, string][] = [
  [/(^|\/)nginx-proxy-manager(:|@|$)/, "The Proxy Manager serves every domain. While it is down, no site is reachable."],
  [/(^|\/)portainer-(ce|ee)(:|@|$)/, "Portainer runs the stacks and receives the deploy webhooks from GitHub. While it is down, no deploy gets through."],
];

const criticalOf = (c: Container): string | undefined => CRITICAL.find(([re]) => re.test(c.image))?.[1];

export function ContainerChips({ c }: { c: Container }) {
  return (
    <>
      {!c.user && (
        <Pill tone="neutral" title="The process runs as root inside the container">
          root
        </Pill>
      )}
      {c.readOnly && (
        <Pill tone="ok" title="Read-only file system">
          read-only
        </Pill>
      )}
      {c.dockerSock && (
        <Pill tone="sand" title="Has access to docker.sock – effectively root on the server">
          docker.sock
        </Pill>
      )}
      {c.privileged && (
        <Pill tone="rose" title="Runs privileged">
          privileged
        </Pill>
      )}
    </>
  );
}

/* ---------- Detail ------------------------------------------------------------------------- */

type Act = "start" | "stop" | "restart";

function actCopy(c: Container, a: Act): ConfirmCopy {
  const crit = criticalOf(c);
  const verb = a === "start" ? "Start" : a === "stop" ? "Stop" : "Restart";
  return {
    title: `${verb} ${c.name}?`,
    description:
      a === "start"
        ? "The container starts with its existing configuration."
        : a === "stop"
          ? "The container stops and stays off until you start it again – thanks to “unless-stopped” it won’t come back after a server reboot either."
          : "The container stops briefly and starts again with the same configuration. It’s usually back within seconds.",
    note: crit && a !== "start" ? <><b>Heads up:</b> {crit}</> : undefined,
    confirmLabel: verb,
    tone: a === "start" ? "accent" : "danger",
    requireTyping: crit && a === "stop" ? "stop" : undefined,
  };
}

export function Detail({ c, onClose }: { c: Container; onClose: () => void }) {
  const { busy, run } = useAction();
  const [ask, setAsk] = useState<Act | null>(null);
  const tone = stateTone(c);
  const running = c.state === "running";
  const crit = criticalOf(c);
  const doIt = (a: Act) =>
    void run(a, () => api.post(`/api/containers/${encodeURIComponent(c.name)}/${a}`), `${c.name} ${a === "start" ? "started" : a === "stop" ? "stopped" : "restarted"}.`).then(() => refreshAll());

  return (
    <Overlay onClose={onClose} label={c.name} size="xl" align="top">
      <DialogHead
        icon={TerminalSquare}
        title={c.name}
        sub={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <Pill tone={tone} dot>
              {running && c.health ? HEALTH_LABEL[c.health] : STATE_LABEL[c.state]}
            </Pill>
            <span className="o-mute">{c.status}</span>
          </span>
        }
      />
      <div className="o-dialog-scroll">
        <div className="o-dialog-body">
          {crit && (
            <div className="o-callout mb-5" data-tone="sand">
              <span className="o-callout-icon">
                <AlertTriangle className="h-4 w-4" />
              </span>
              <div className="o-callout-text">{crit}</div>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {running ? (
              <>
                <Button variant="secondary" disabled={!!busy} onClick={() => setAsk("restart")} className={cx(busy === "restart" && "is-busy")}>
                  <RotateCcw className={cx("h-4 w-4", busy === "restart" && "o-spin")} /> Restart
                </Button>
                <Button variant="danger" disabled={!!busy} onClick={() => setAsk("stop")}>
                  <Square className="h-4 w-4" /> Stop
                </Button>
              </>
            ) : (
              <Button variant="primary" disabled={!!busy} onClick={() => setAsk("start")}>
                <Power className="h-4 w-4" /> Start
              </Button>
            )}
          </div>

          <div className="mt-6 grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <KeyValue
              items={[
                ["Image", <span className="d-mono">{c.image}</span>],
                ["Stack", c.project ?? "—"],
                ["Started", running && c.startedAt ? ago(c.startedAt) : "—"],
                ["Restarts", num(c.restartCount)],
                ["User", c.user ?? "root"],
              ]}
            />
            <KeyValue
              items={[
                ["CPU", pct(c.cpuPct, 1)],
                ["Memory", c.memUsed ? `${bytes(c.memUsed)} of ${bytes(c.memLimit, 0)}` : "—"],
                ["Network in / out", `${bytes(c.netRx)} / ${bytes(c.netTx)}`],
                ["Ports", c.ports.length ? <span className="d-mono">{c.ports.join(", ")}</span> : "none published"],
                ["Networks", c.networks.join(", ") || "—"],
              ]}
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <ContainerChips c={c} />
          </div>

          <div className="o-dialog-section">
            <h3 className="o-h2 mb-3">Logs</h3>
            <LogView containers={[c.name]} title={c.name} compact onExpand={() => openLogs({ title: c.name, containers: [c.name] })} />
          </div>
        </div>
      </div>
      {ask && <Confirm copy={actCopy(c, ask)} icon={ask === "start" ? Power : ask === "stop" ? Square : RotateCcw} onClose={() => setAsk(null)} onConfirm={() => doIt(ask)} />}
    </Overlay>
  );
}
