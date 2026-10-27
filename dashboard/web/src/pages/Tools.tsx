import { AppWindow, ArrowUpRight, Ship, Waypoints, type LucideIcon } from "lucide-react";
import { EVERY, usePoll } from "../api";
import { Section, StateDot } from "../common";
import type { Tool } from "../config";
import { Reveal } from "../design/fx";
import type { Tone } from "../design/ui";
import { plural } from "../format";
import { toolHref, useTools } from "../tools";
import type { Docker, Sites, Stacks } from "../types";
import { stateTone } from "./Containers";
import "./tools.css";

/**
 * Overview → "Tools": one card per admin UI (Portainer, Proxy Manager, KW_EXTRA_UIS), each a plain link
 * into the tunnel (tools.ts). The state line uses data the dashboard already has (cached on the server):
 * Portainer – stacks, containers and whether all are healthy; Proxy Manager – sites and the nearest
 * certificate expiry; own UIs – just "Own admin UI". No section without tools.
 */

interface State {
  tone: Tone | null;
  text: string;
  title?: string;
}

const ICON: Record<string, LucideIcon> = { portainer: Ship, proxy: Waypoints };

function ToolCard({ t, state, delay }: { t: Tool; state: State; delay: number }) {
  const Icon = ICON[t.id] ?? AppWindow;
  const href = toolHref(t);
  return (
    <Reveal delay={delay} className="o-ccard-wrap">
      <a className="o-ccard d-tool" href={href} target="_blank" rel="noopener" data-tool={t.id} title={`Open ${t.name} · ${href.replace(/^https?:\/\//, "").replace(/\/$/, "")}`}>
        <span className="o-ccard-top">
          <span className="d-tool-icon" aria-hidden>
            <Icon className="h-[18px] w-[18px]" strokeWidth={1.7} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="o-ccard-name">{t.name}</span>
            <span className="d-tool-state" title={state.title}>
              {state.tone && <StateDot tone={state.tone} />}
              <span className="min-w-0">{state.text}</span>
            </span>
          </span>
          <ArrowUpRight className="o-ccard-go h-4 w-4" aria-hidden />
        </span>
      </a>
    </Reveal>
  );
}

function portainerState(st: Stacks | null, dk: Docker | null): State {
  if (!st) return { tone: null, text: "Docker stacks" };
  const stacks = st.stacks.filter((s) => s.managed).length;
  const parts = [plural(stacks, "stack", "stacks")];
  let tone: Tone = "ok";
  let title: string | undefined;
  if (dk) {
    const bad = dk.containers.filter((c) => stateTone(c) !== "ok");
    parts.push(plural(dk.containers.length, "container", "containers"));
    parts.push(bad.length ? `${bad.length} with issues` : "all healthy");
    if (bad.length) {
      tone = bad.some((c) => stateTone(c) === "rose") ? "rose" : "sand";
      title = bad.map((c) => c.name).join("\n");
    }
  }
  if (!st.portainer.connected) {
    parts.push("token missing");
    if (tone === "ok") tone = "sand";
    title = st.portainer.reason ?? undefined;
  }
  return { tone, text: parts.join(" · "), title };
}

function proxyState(s: Sites | null): State {
  if (!s) return { tone: null, text: "Sites and certificates" };
  const live = s.sites.filter((x) => x.enabled);
  const certs = live.filter((x) => x.cert).sort((a, b) => a.cert!.daysLeft - b.cert!.daysLeft);
  const next = certs[0];
  const parts = [plural(live.length, "site", "sites")];
  let tone: Tone = "ok";
  if (next?.cert) {
    const d = next.cert.daysLeft;
    parts.push(d <= 0 ? "a certificate expired" : `next certificate in ${plural(d, "day", "days")}`);
    tone = d < 7 ? "rose" : d < 21 ? "sand" : "ok";
  }
  return { tone, text: parts.join(" · "), title: next ? `Nearest certificate expiry: ${next.domains[0]}` : undefined };
}

export function ToolsSection() {
  const tools = useTools();
  const portainer = tools.some((t) => t.id === "portainer");
  const proxy = tools.some((t) => t.id === "proxy");
  // Cached on the server; slower than on Services – a state line only.
  const st = usePoll<Stacks>(portainer ? "/api/stacks" : null, EVERY.stacks);
  const dk = usePoll<Docker>(portainer ? "/api/docker" : null, 30_000);
  const sites = usePoll<Sites>(proxy ? "/api/sites" : null, EVERY.sites);
  if (!tools.length) return null;
  const stateOf = (t: Tool): State =>
    t.id === "portainer" ? portainerState(st.data, dk.data) : t.id === "proxy" ? proxyState(sites.data) : { tone: null, text: "Own admin UI" };
  return (
    <Section title="Tools" sub="Admin interfaces on your server, through the tunnel.">
      <div className="d-tools">
        {tools.map((t, i) => (
          <ToolCard key={t.id} t={t} state={stateOf(t)} delay={60 + i * 50} />
        ))}
      </div>
    </Section>
  );
}
