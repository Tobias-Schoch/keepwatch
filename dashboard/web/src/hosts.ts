/**
 * "New site" wizard – types for /api/hosts/* and /api/settings/npm (API.md → "New site").
 * Backend: server/hosts.py, mock: mock-hosts.ts. Module proxy.
 */

export interface NpmStatus {
  configured: boolean;
  /** Email of the Proxy Manager user; the password is never returned. */
  email: string | null;
  connected: boolean;
  reason: string | null;
  checkedAt: number | null;
  url: string;
}

export interface ServerIps {
  v4: string[];
  v6: string[];
}

export type SslKey = "certificate" | "sslForced" | "hsts" | "hstsSubdomains" | "http2" | "blockExploits" | "caching" | "websockets";
export type SslFlags = Record<SslKey, boolean>;

export interface HostDefaults {
  /** What most active hosts have ("like your other sites"). */
  values: SslFlags;
  /** How many of the `basis` hosts have the switch on. */
  counts: Record<SslKey, number>;
  basis: number;
}

export interface Target {
  name: string;
  image: string;
  project: string | null;
  service: string | null;
  composeFile: string | null;
  networks: string[];
  /** Networks shared with the Proxy Manager (without "bridge" – Docker doesn't resolve names there). */
  shared: string[];
  reachable: boolean;
  hostNetwork: boolean;
  /** Ports something actually listens on inside the container (without loopback). */
  listening: number[];
  /** EXPOSE from the image. */
  exposed: number[];
  suggestedPort: number | null;
  /** Domains already pointing at this container. */
  sites: string[];
}

export interface Targets {
  npm: { name: string | null; networks: string[]; join: string | null };
  containers: Target[];
}

export interface IpListEntry {
  value: string;
  note: string;
  addresses: number;
}

export interface IpList {
  /** Note from the allow-list ("Home"), else the address itself. */
  name: string;
  named: boolean;
  entries: IpListEntry[];
  /** Sites that already use this entry. */
  sites: string[];
}

export interface WizardData {
  npm: NpmStatus;
  serverIps: ServerIps;
  defaults: HostDefaults;
  targets: Targets;
  ipLists: IpList[];
  myIps: string[];
}

export interface DnsResult {
  name: string;
  a: string[];
  aaaa: string[];
  cname: string | null;
  ok: boolean;
  problem: string | null;
}

export interface DomainCheck {
  domain: string;
  domains: string[];
  taken: { domain: string; kind: string; id: number }[];
  dns: DnsResult[];
  serverIps: ServerIps;
  ok: boolean;
}

export interface NewHostBody {
  domain: string;
  www: boolean;
  forwardHost: string;
  forwardPort: number;
  forwardScheme: "http" | "https";
  ssl: SslFlags;
  access: { mode: "open" | "list"; entries: { value: string; note: string }[] };
}

export type JobStepState = "pending" | "running" | "ok" | "failed" | "warning" | "skipped" | "cancelled";

export interface HostJob {
  id: string;
  state: "running" | "done" | "failed";
  domain: string;
  domains: string[];
  url: string | null;
  hostId: number | null;
  error: string | null;
  rollback: { label: string; ok: boolean }[];
  startedAt: number;
  finishedAt: number | null;
  steps: { key: "host" | "cert" | "https" | "test"; label: string; state: JobStepState; detail: string | null }[];
}
