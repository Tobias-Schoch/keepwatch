import { deriveTools, MODULES, type Config, type ModuleId } from "./config";
import { applyMockModules } from "./mock-modules";

/**
 * Mock /api/config. All modules are on by default. Simulate a smaller install with
 *
 *   ?mock&modules=-proxy,-portainer      everything except these
 *   ?mock&modules=docker,backup          only these (plus base and dashboard)
 *   ?mock&modules=-passkey               no passkey confirmation
 *   ?mock&modules=-extras                no own admin UIs (KW_EXTRA_UIS, Overview "Tools")
 *   ?mock&update=off                     no updates from the dashboard (more in mock-selfupdate.ts)
 *   ?mock&mods=…                         switching modules from the dashboard (mock-modules.ts)
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

  const conf = {} as Record<ModuleId, boolean>;
  for (const m of MODULES) {
    const always = m.id === "base" || m.id === "dashboard";
    conf[m.id] = always || ((only.size === 0 || only.has(m.id)) && !off.has(m.id));
  }
  // Dependencies: a module whose requirement is off is off too.
  for (const m of MODULES) if ("requires" in m && m.requires.some((r) => !conf[r as ModuleId])) conf[m.id] = false;
  // keepwatch.conf above, what was switched in the dashboard on top (like config.modules() on the server).
  const modules = applyMockModules(conf);

  const ports = { dashboard: 9004, proxyAdmin: modules.proxy ? 9001 : null, portainer: modules.portainer ? 9002 : null };
  // KW_EXTRA_UIS="License_admin=9003/admin/" (underscores become spaces); ?mock&modules=-extras hides it
  const extraUis = off.has("extras") ? [] : [{ name: "License admin", port: 9003, path: "/admin/" }];
  return {
    hostname: "keep",
    modules,
    localTz: "Europe/Amsterdam",
    ports,
    extraUis,
    tools: deriveTools({ modules, ports, extraUis }),
    passkey: !off.has("passkey"),
    version: "0.1.0-mock",
    selfUpdate: new URLSearchParams(location.search).get("update") !== "off",
  };
}
