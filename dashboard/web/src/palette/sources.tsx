import { Boxes, DatabaseBackup, Globe, HardDrive, LayoutGrid, RefreshCw, Rocket, ScrollText, SlidersHorizontal, TerminalSquare, Unlock } from "lucide-react";
import { shortDateTime } from "../format";
import { has } from "../config";
import { dockViews } from "../nav";
import { HEALTH_LABEL, STATE_LABEL, stateTone } from "../pages/Containers";
import { siteHost } from "../pages/Sites";
import { Redeploy, repoName } from "../pages/Stacks";
import { setServiceOpen } from "../pages/servicesStore";
import type { Stack } from "../types";
import { registerPalette, stackContainers, type PaletteCtx } from "./registry";
import { BackupConfirm, UnbanConfirm } from "./dialogs";
import { openSetting, settingsIndex } from "../pages/settingsOpen";

/* Built-in palette sources. Template for more: registerPalette((d) => [...]). Every source checks its modules. */

/** Display name as on the Services page: repo name if it has capitals ("MyShop"), else the capitalized stack name ("Shop"). */
export function serviceTitle(s: Stack): string {
  if (!s.managed) return "Infrastructure";
  const repo = s.git ? repoName(s.git.url).split("/").pop() ?? "" : "";
  if (/[A-Z]/.test(repo)) return repo;
  return s.name.charAt(0).toUpperCase() + s.name.slice(1);
}

/** Jump to the service and expand it (details are collapsed on the page). */
const toBlock = (ctx: PaletteCtx, title: string, key: string) => {
  setServiceOpen(key, true);
  ctx.jump("services", { sel: ".d-block-title", text: title, exact: true, up: ".d-block" });
};

/* ---------- Actions -------------------------------------------------------------------------- */

registerPalette((d) => {
  const items = [];
  const containers = has("docker") ? d.docker?.containers ?? [] : [];
  const connected = d.stacks?.portainer?.connected ?? false;
  for (const s of has("portainer") ? d.stacks?.stacks ?? [] : []) {
    const title = serviceTitle(s);
    const cs = stackContainers(s, containers).map((c) => c.name);
    if (s.managed && s.id !== null && connected)
      items.push({
        id: `deploy:${s.name}`,
        group: "actions" as const,
        title: `Redeploy ${title}`,
        hint: s.name,
        keywords: `redeploy deploy portainer ${s.name}`,
        icon: Rocket,
        rank: 3,
        run: (ctx: PaletteCtx) => ctx.dialog((close) => <Redeploy s={s} onClose={close} />),
      });
    if (cs.length)
      items.push({
        id: `logs:${s.name}`,
        group: "actions" as const,
        title: `Live logs: ${title}`,
        hint: cs.length > 1 ? `${cs.length} Container` : cs[0],
        keywords: `log logs output tail ${s.name} ${cs.join(" ")}`,
        icon: ScrollText,
        rank: 2,
        run: (ctx: PaletteCtx) => ctx.openLogs(title, cs),
      });
  }
  for (const c of containers)
    items.push({
      id: `logs-c:${c.name}`,
      group: "actions" as const,
      title: `Live logs: ${c.name}`,
      hint: STATE_LABEL[c.state],
      keywords: "log logs output tail container",
      icon: ScrollText,
      run: (ctx: PaletteCtx) => ctx.openLogs(c.name, [c.name]),
    });
  for (const site of has("proxy") ? d.sites?.sites ?? [] : [])
    if (site.cert)
      items.push({
        id: `renew:${site.id}`,
        group: "actions" as const,
        title: `Renew certificate: ${site.domains[0]}`,
        hint: `${site.cert.daysLeft} days left`,
        keywords: `ssl tls https lets encrypt certificate cert ${site.domains.join(" ")}`,
        icon: RefreshCw,
        run: (ctx: PaletteCtx) => ctx.renew(site),
      });
  if (d.backups && has("backup"))
    items.push({
      id: "backup:run",
      group: "actions" as const,
      title: "Run backup now",
      hint: d.backups.running ? "running" : d.backups.lastRun ? `last ${shortDateTime(d.backups.lastRun.startedAt)}` : undefined,
      keywords: "backup restic snapshot now",
      icon: DatabaseBackup,
      rank: 3,
      run: (ctx: PaletteCtx) => ctx.dialog((close) => <BackupConfirm onClose={close} onStarted={() => ctx.go("backups")} />),
    });
  for (const b of has("fail2ban") ? d.security?.bans ?? [] : [])
    if (b.active)
      items.push({
        id: `unban:${b.jail}:${b.ip}`,
        group: "actions" as const,
        title: `Unban ${b.ip}`,
        hint: `${b.jail} · ${b.country?.name ?? ""}`,
        keywords: "unban lift ban fail2ban allow",
        icon: Unlock,
        mono: true,
        run: (ctx: PaletteCtx) => ctx.dialog((close) => <UnbanConfirm ip={b.ip} jail={b.jail} loggedIn={(d.security?.logins ?? []).some((l) => l.ip === b.ip)} onClose={close} />),
      });
  return items;
});

/* ---------- Services, sites, containers ------------------------------------------------------ */

registerPalette((d) => {
  const containers = has("docker") ? d.docker?.containers ?? [] : [];
  const sites = has("proxy") ? d.sites?.sites ?? [] : [];
  const items = [];
  for (const s of has("portainer") ? d.stacks?.stacks ?? [] : []) {
    const title = serviceTitle(s);
    const cs = stackContainers(s, containers);
    const bad = cs.filter((c) => stateTone(c) !== "ok").length;
    items.push({
      id: `svc:${s.name}`,
      group: "services" as const,
      title,
      hint: `${cs.length} ${cs.length === 1 ? "container" : "containers"} · ${bad ? `${bad} with issues` : cs.length ? "healthy" : "none running"}`,
      keywords: `${s.name} ${s.git ? repoName(s.git.url) : ""} ${cs.map((c) => c.name).join(" ")}`,
      icon: Boxes,
      rank: 2,
      run: (ctx: PaletteCtx) => toBlock(ctx, title, s.name),
    });
  }
  for (const site of sites) {
    const host = siteHost(site);
    items.push({
      id: `site:${site.id}`,
      group: "sites" as const,
      title: site.domains[0],
      hint: [site.enabled ? (site.check ? String(site.check.code) : "no response") : "off", site.cert ? `certificate ${site.cert.daysLeft} days` : "no certificate"].join(" · "),
      keywords: `${site.domains.slice(1).join(" ")} ${host}`,
      icon: Globe,
      mono: true,
      run: (ctx: PaletteCtx) => ctx.jump("services", { sel: ".d-block a", text: site.domains[0], up: ".svc-row, .svc-site" }),
    });
  }
  for (const c of containers)
    items.push({
      id: `ct:${c.name}`,
      group: "containers" as const,
      title: c.name,
      hint: `${c.state === "running" && c.health ? HEALTH_LABEL[c.health] : STATE_LABEL[c.state]} · ${c.image}`,
      keywords: `${c.project ?? ""} ${c.image}`,
      icon: TerminalSquare,
      mono: true,
      run: (ctx: PaletteCtx) => ctx.openContainer(c),
    });
  return items;
});

/* ---------- Backups -------------------------------------------------------------------------- */

registerPalette((d) => {
  const b = d.backups;
  if (!b || !has("backup") || !b.targets) return [];
  const items = b.targets.map((t) => ({
    id: `bt:${t.name}`,
    group: "backups" as const,
    title: `${t.name} (${t.kind === "remote" ? "off-site" : "local"})`,
    hint: t.configured ? (t.lastSnapshot ? `last backup ${shortDateTime(t.lastSnapshot)}` : "no backup yet") : "not set up",
    keywords: `${t.location} target repository restic`,
    icon: HardDrive,
    run: (ctx: PaletteCtx) => ctx.jump("backups", { sel: "main th, main td, main .o-h2, main h3", text: t.name }),
  }));
  const newest = b.snapshots[0];
  const paths = new Map<string, number>();
  for (const s of b.snapshots) for (const p of s.paths) if (!paths.has(p)) paths.set(p, s.time);
  for (const [p, time] of paths) {
    const base = p.replace(/\/+$/, "").split("/").pop() || p;
    items.push({
      id: `bp:${p}`,
      group: "backups" as const,
      title: base,
      hint: `last backup ${shortDateTime(time)}`,
      keywords: `${p} backup backed up path`,
      icon: DatabaseBackup,
      run: (ctx: PaletteCtx) => ctx.jump("backups", { sel: "main td, main li, main code, main span", text: newest ? base : p }),
    });
  }
  return items;
});

/* ---------- Settings and pages --------------------------------------------------------------- */

/* Settings: list and opening come from pages/settingsOpen.ts – a hit opens the dialog directly. */

registerPalette(() => [
  ...settingsIndex().map((s) => ({
    id: `set:${s.key}`,
    group: "settings" as const,
    title: s.title,
    keywords: `${s.keywords} setting server`,
    icon: SlidersHorizontal,
    run: (ctx: PaletteCtx) => {
      ctx.go("settings");
      openSetting(s.key);
    },
  })),
  ...dockViews().map((v) => ({
    id: `view:${v.id}`,
    group: "pages" as const,
    title: v.label,
    keywords: v.id,
    icon: v.id === "overview" ? LayoutGrid : v.icon,
    run: (ctx: PaletteCtx) => ctx.go(v.id),
  })),
]);
