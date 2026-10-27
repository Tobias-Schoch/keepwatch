import { MODULES, type Config, type ModuleId } from "./config";

/**
 * Mock /api/config. All modules are on by default. Simulate a smaller install with
 *
 *   ?mock&modules=-proxy,-portainer      everything except these
 *   ?mock&modules=docker,backup          only these (plus base and dashboard)
 *   ?mock&modules=-passkey               no passkey confirmation
 *   ?mock&update=off                     no updates from the dashboard (more in mock-selfupdate.ts)
 *
 * or the same list in VITE_MOCK_MODULES. Dependencies follow: without docker
 * there is no proxy, portainer, image-scan or log-archive.
 */
export function mockConfig(): Config {
  const spec = new URLSearchParams(location.search).get("modules") ?? (import.meta.env.VITE_MOCK_MODULES as string | undefined) ?? "";
  const tokens = spec
    .split(/[\s,]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const off = new Set(tokens.filter((t) => t.startsWith("-")).map((t) => t.slice(1)));
  const only = new Set(tokens.filter((t) => !t.startsWith("-")));

  const modules = {} as Record<ModuleId, boolean>;
  for (const m of MODULES) {
    const always = m.id === "base" || m.id === "dashboard";
    modules[m.id] = always || ((only.size === 0 || only.has(m.id)) && !off.has(m.id));
  }
  // Dependencies: a module whose requirement is off is off too.
  for (const m of MODULES) if ("requires" in m && m.requires.some((r) => !modules[r as ModuleId])) modules[m.id] = false;

  return {
    hostname: "keep",
    modules,
    localTz: "Europe/Amsterdam",
    ports: { dashboard: 9004, proxyAdmin: modules.proxy ? 9001 : null, portainer: modules.portainer ? 9002 : null },
    extraUis: [{ name: "Grafana", port: 9010 }],
    passkey: !off.has("passkey"),
    version: "0.1.0-mock",
    selfUpdate: new URLSearchParams(location.search).get("update") !== "off",
  };
}
