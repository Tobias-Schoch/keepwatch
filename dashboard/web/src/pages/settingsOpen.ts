import { getConfig, has, type ModuleId } from "../config";

/**
 * Settings: which rows exist and how to open one directly (⌘K, timeline).
 * The page may still be loading – `openSetting` remembers the request, the page picks it up when it loads.
 */
export type SettingKey = "tailscale" | "passkey" | "fail2ban" | "schedule" | "remote" | "password" | "updates" | "logArchive" | "portainer" | "npm" | "modules";

/** `module`: the row only exists when that module is installed. `passkey`: only with KW_DASHBOARD_PASSKEY. */
const ALL: { key: SettingKey; title: string; keywords: string; module?: ModuleId; passkey?: boolean }[] = [
  { key: "tailscale", title: "Remote access (Tailscale)", keywords: "tailscale vpn ssh port 22 tailnet login key", module: "tailscale" },
  { key: "passkey", title: "Passkey", keywords: "touch id face id windows hello passkey webauthn confirm dangerous device pair security key", passkey: true },
  { key: "fail2ban", title: "fail2ban", keywords: "fail2ban ban bantime maxretry ignoreip repeat offenders never ban exceptions", module: "fail2ban" },
  { key: "schedule", title: "Schedule & retention", keywords: "time backup schedule keep retention days weeks months", module: "backup" },
  { key: "remote", title: "Off-site backup", keywords: "off-site remote restic repository s3 b2 sftp rest rclone credentials", module: "backup" },
  { key: "password", title: "Backup password", keywords: "restic password key password manager", module: "backup" },
  { key: "updates", title: "Automatic updates", keywords: "unattended upgrades reboot security updates time", module: "auto-updates" },
  { key: "logArchive", title: "Log archive", keywords: "logs archive container archive retention mb", module: "log-archive" },
  { key: "portainer", title: "Portainer", keywords: "token access api stacks", module: "portainer" },
  { key: "npm", title: "Proxy Manager login", keywords: "nginx proxy manager npm email password new site", module: "proxy" },
  { key: "modules", title: "Modules", keywords: "modules enable disable installed keepwatch deploy" },
];

/**
 * Row ids the backend uses in problem targets ("settings/<row>") and timeline links (`link.setting`).
 */
export type SettingRow = "remote-access" | "passkey" | "fail2ban" | "backup-schedule" | "backup-remote" | "backup-password" | "updates" | "log-archive" | "portainer" | "proxy";

const ROW: Record<SettingRow, SettingKey> = {
  "remote-access": "tailscale",
  passkey: "passkey",
  fail2ban: "fail2ban",
  "backup-schedule": "schedule",
  "backup-remote": "remote",
  "backup-password": "password",
  updates: "updates",
  "log-archive": "logArchive",
  portainer: "portainer",
  proxy: "npm",
};

/** The settings row for a backend row id, if that row exists with the installed modules. */
export function settingOfRow(row: string | null | undefined): SettingKey | null {
  const key = row ? ROW[row as SettingRow] : undefined;
  return key && settingsIndex().some((s) => s.key === key) ? key : null;
}

/** Settings rows for the installed modules. */
export const settingsIndex = () => ALL.filter((s) => (!s.module || has(s.module)) && (!s.passkey || getConfig().passkey));

/** Title of a setting (also for rows that are hidden). */
export const settingTitle = (key: SettingKey) => ALL.find((s) => s.key === key)?.title ?? key;

const EVENT = "dash:setting";
let pending: SettingKey | null = null;

export function openSetting(key: SettingKey) {
  pending = key;
  window.dispatchEvent(new CustomEvent<SettingKey>(EVENT, { detail: key }));
}

/** Pending request at the page's first render; `onOpenSetting` (in an effect) clears it. */
export function pendingSetting(): SettingKey | null {
  return pending;
}

export function onOpenSetting(fn: (k: SettingKey) => void) {
  pending = null;
  const h = (e: Event) => {
    pending = null;
    fn((e as CustomEvent<SettingKey>).detail);
  };
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}

/** Map a link target to a row: a backend row id ("backup-remote"), a key ("remote"), or text matching its title. */
export function settingByText(text: string): SettingKey | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const rows = settingsIndex();
  return (
    settingOfRow(t) ??
    rows.find((s) => s.key.toLowerCase() === t)?.key ??
    rows.find((s) => s.title.toLowerCase().includes(t) || t.includes(s.title.toLowerCase()))?.key ??
    null
  );
}
