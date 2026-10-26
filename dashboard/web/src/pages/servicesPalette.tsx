import { KeyRound, Plus, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { api, refreshAll } from "../api";
import { has } from "../config";
import { Confirm } from "../design/ui";
import { useAction } from "../messages";
import { registerPalette, type PaletteCtx, type PaletteItem } from "../palette/registry";
import { serviceTitle } from "../palette/sources";
import { NewSiteWizard } from "./NewSite";
import { setMaintenanceOpen } from "./servicesStore";
import { EnvSheet } from "./Stacks";

/**
 * Palette entries for everything on Services that sits behind a click:
 * new site, check for updates, security scan, clean up, variables per service.
 * Actions always go through a confirmation dialog, never directly.
 * Only with the docker module (the whole page needs it); new site with proxy, scan with image-scan.
 */

function CheckConfirm({ onClose }: { onClose: () => void }) {
  const { run } = useAction();
  return (
    <Confirm
      icon={RefreshCw}
      copy={{
        title: "Check for updates?",
        description: "Asks the registries for new versions of every image. Nothing gets installed.",
        confirmLabel: "Check",
        tone: "accent",
      }}
      onClose={onClose}
      onConfirm={() => void run("check", () => api.post("/api/updates/check"), "Checking for updates.").then(() => refreshAll())}
    />
  );
}

function ScanConfirm({ onClose }: { onClose: () => void }) {
  const { run } = useAction();
  return (
    <Confirm
      icon={ShieldAlert}
      copy={{
        title: "Run a security scan?",
        description: "Trivy checks every image for known vulnerabilities. This takes a few minutes; your services keep running.",
        confirmLabel: "Start scan",
        tone: "accent",
      }}
      onClose={onClose}
      onConfirm={() => void run("scan", () => api.post("/api/updates/scan"), "Security scan started – this takes a few minutes.").then(() => refreshAll())}
    />
  );
}

const toMaintenance = (ctx: PaletteCtx) => {
  setMaintenanceOpen(true);
  ctx.jump("services", { sel: ".svc-maint .d-fold", text: "Maintenance", up: ".svc-maint" });
};

registerPalette((d) => {
  if (!has("docker")) return [];
  const connected = d.stacks?.portainer.connected ?? false;
  const items: PaletteItem[] = [];
  if (has("proxy"))
    items.push({
      id: "svc:new-site",
      group: "actions",
      title: "Add a new site",
      keywords: "website site domain proxy host add create new",
      icon: Plus,
      rank: 3,
      run: (ctx: PaletteCtx) => ctx.dialog((close) => <NewSiteWizard onClose={close} />),
    });
  items.push({
    id: "svc:check-updates",
    group: "actions",
    title: "Check for updates",
    keywords: "update image registry version check",
    icon: RefreshCw,
    rank: 2,
    run: (ctx: PaletteCtx) => ctx.dialog((close) => <CheckConfirm onClose={close} />),
  });
  if (has("image-scan"))
    items.push({
      id: "svc:scan",
      group: "actions",
      title: "Run security scan",
      keywords: "trivy cve vulnerabilities scan security images",
      icon: ShieldAlert,
      run: (ctx: PaletteCtx) => ctx.dialog((close) => <ScanConfirm onClose={close} />),
    });
  items.push(
    {
      id: "svc:cleanup",
      group: "actions",
      title: "Clean up: free Docker disk space",
      hint: "Maintenance",
      keywords: "clean up cleanup prune build cache images disk space",
      icon: Trash2,
      run: toMaintenance,
    },
    {
      id: "svc:maintenance",
      group: "pages",
      title: "Maintenance (Services)",
      keywords: "updates scan clean up",
      icon: Trash2,
      run: toMaintenance,
    },
  );
  if (has("portainer"))
    for (const s of d.stacks?.stacks ?? [])
      if (s.managed && s.id !== null)
        items.push({
          id: `env:${s.name}`,
          group: "actions",
          title: `Variables: ${serviceTitle(s)}`,
          hint: s.envCount !== null ? `${s.envCount}` : undefined,
          keywords: `env environment variables secrets ${s.name}`,
          icon: KeyRound,
          rank: 1,
          run: (ctx: PaletteCtx) => ctx.dialog((close) => <EnvSheet s={s} canEdit={connected} onClose={close} />),
        });
  return items;
});
