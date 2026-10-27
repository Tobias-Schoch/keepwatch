import { getConfig, useConfig, type Tool } from "./config";
import type { Stack } from "./types";

/**
 * Links to the admin UIs (Portainer, Proxy Manager, KW_EXTRA_UIS) – GET /api/config `tools`.
 *
 * Every UI listens on 127.0.0.1 on the server and reaches this computer through the SSH tunnel.
 * Local port as in `./keepwatch tunnel` and the macOS app (Ports in desktop/Sources/Tunnel.swift):
 * base = server port + 10000 (− 10000 near the top of the port range), plus the app's shift of
 * 0–900 in steps of 100 when ports are taken. The shift is read from where the dashboard itself is
 * served: location.port − base(ports.dashboard). Served on the server port itself (a hand-made
 * `-L 9004:127.0.0.1:9004`): the same ports. Anything else (no port, a shift that is not a multiple
 * of 100, e.g. a dev server): the standard tunnel.
 *
 * Plain links with target="_blank": a browser opens a new tab, the macOS app catches the tunnel
 * address (createWebViewWith → route) and shows that UI in its own window, deep links included.
 */

const validPort = (p: number) => Number.isInteger(p) && p > 0 && p <= 65_535;
const base = (remote: number) => (remote + 10_900 <= 65_535 ? remote + 10_000 : remote - 10_000);

/** Local port for a port on the server, as seen from this page. */
export function localPort(port: number): number {
  const here = Number(location.port);
  const dash = getConfig().ports.dashboard;
  if (!validPort(here) || !dash) return base(port);
  if (here === dash) return port;
  const shift = here - base(dash);
  const local = base(port) + shift;
  return shift % 100 === 0 && validPort(local) ? local : base(port);
}

/** Address of a server port (127.0.0.1:<port> on the server) as seen from this browser. */
export function toolUrl(port: number, path = "/"): string {
  const host = location.hostname.includes(":") ? `[${location.hostname}]` : location.hostname || "localhost";
  return `http://${host}:${localPort(port)}${path.startsWith("/") ? path : `/${path}`}`;
}

export const toolHref = (t: Tool, path?: string) => toolUrl(t.port, path ?? t.path);

/** Enabled tools (re-renders when the config arrives). */
export const useTools = (): Tool[] => useConfig().tools;

/** One tool by id ("portainer", "proxy", "extra-1", …) – null while its module is off. */
export const useTool = (id: string): Tool | null => useTools().find((t) => t.id === id) ?? null;
export const getTool = (id: string): Tool | null => getConfig().tools.find((t) => t.id === id) ?? null;

/** Opens a tool from code (quick search). Call it inside the user's click/keypress. */
export function openTool(href: string) {
  window.open(href, "_blank", "noopener");
}

/** Portainer 2.x page of a compose stack; null without stack id or environment. */
export function portainerStackPath(s: Stack): string | null {
  if (s.id === null || s.endpointId === null) return null;
  const q = `id=${s.id}&type=2&regular=true&orphaned=false&orphanedRunning=false`;
  return `/#!/${s.endpointId}/docker/stacks/${encodeURIComponent(s.name)}?${q}`;
}

/** The Proxy Manager has no stable address per host – its list of proxy hosts. */
export const PROXY_HOSTS_PATH = "/nginx/proxy";
