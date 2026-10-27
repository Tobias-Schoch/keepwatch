import type { Container, Stack } from "./types";

/*
 * Display names of compose projects that Portainer does not manage – Keepwatch's own (Proxy Manager, Portainer)
 * and anything started by hand (`docker compose -p myapp up`). Used by the Services page, the palette and the
 * mock timeline. The backend has a copy for timeline titles (timeline.py _unmanaged_title) – keep both in sync.
 *
 * Only the name comes from here. What is "infrastructure" (sorting, not counted as a service, not rated by the
 * vulnerability scan) still keys off `managed` and the image, never off this title.
 */

/** Keepwatch's own containers, recognized by image (also after a rename of the project). */
const PROXY_IMAGE = /(^|\/)nginx-proxy-manager(:|@|$)/;
const PORTAINER_IMAGE = /(^|\/)portainer-(ce|ee)(:|@|$)/;
export const INFRA_IMAGE = /(^|\/)(nginx-proxy-manager|portainer-(ce|ee))(:|@|$)/;

/** The compose project names Keepwatch's modules use (modules/proxy, modules/portainer). */
const PROJECT_NAMES: Record<string, string> = { proxy: "Proxy Manager", portainer: "Portainer" };

export const NOT_MANAGED_HINT = "not managed by Portainer";

export const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * Name of an unmanaged compose project. The images decide when they are known – a hand-started project that
 * happens to be called "proxy" stays "Proxy" – otherwise the project name. An old single project holding both
 * becomes "Proxy Manager & Portainer". `hint` is set only for projects that are not Keepwatch's own.
 */
export function unmanagedName(project: string, images: string[]): { title: string; hint: string | null } {
  const parts = images.length
    ? [images.some((i) => PROXY_IMAGE.test(i)) && "Proxy Manager", images.some((i) => PORTAINER_IMAGE.test(i)) && "Portainer"].filter((x): x is string => !!x)
    : PROJECT_NAMES[project]
      ? [PROJECT_NAMES[project]]
      : [];
  if (parts.length) return { title: parts.join(" & "), hint: null };
  return { title: capitalize(project), hint: NOT_MANAGED_HINT };
}

/** Containers of a stack: listed by name or carrying its compose project. */
const containersOf = (s: Stack, containers: Container[]) => containers.filter((c) => s.containers.includes(c.name) || (c.project !== null && c.project === s.name));

/**
 * Display name of a stack: the repo name if it has capitals ("MyShop"), else the capitalized stack name ("Shop");
 * unmanaged ones see unmanagedName(). Without `containers` (images unknown) the project name decides.
 */
export function stackName(s: Stack, containers: Container[] = []): { title: string; hint: string | null } {
  if (!s.managed) return unmanagedName(s.name, containersOf(s, containers).map((c) => c.image));
  const repo = s.git ? (s.git.url.replace(/\.git$/, "").replace(/\/+$/, "").split("/").pop() ?? "") : "";
  return { title: /[A-Z]/.test(repo) ? repo : capitalize(s.name), hint: null };
}
