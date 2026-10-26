/** Certificate watch – types and polling (backend: server/ctwatch.py, API.md → "Certificate watch"). Module proxy. */
import { useEffect, useState } from "react";
import { api, usePoll, type Poll } from "../api";
import { has } from "../config";

export type OwnBy = "serial" | "fingerprint" | "run";

export interface CtCert {
  key: string;
  names: string[];
  issuer: string | null;
  issuerCn: string | null;
  notBefore: number | null;
  notAfter: number | null;
  expired: boolean;
  revoked: boolean;
  firstSeen: number | null;
  /** Issued for this server (rule in ctwatch.py / API.md). */
  own: boolean;
  ownBy: OwnBy | null;
  ownNote: string | null;
  /** Marked as known by hand (old server, previous host, …). */
  known: boolean;
  knownAt: number | null;
  /** Newly seen, unknown, not marked → loud. */
  alert: boolean;
  /** Already there on the first run (baseline). */
  baseline: boolean;
  src: "certspotter" | "crt.sh" | null;
  crtsh: string;
}

export interface CtWatch {
  checkedAt: number | null;
  checking: boolean;
  error: string | null;
  every: number;
  source: string | null;
  baselineAt: number | null;
  bases: string[];
  hosts: string[];
  counts: { total: number; own: number; known: number; unknown: number; alerts: number };
  certs: CtCert[];
}

/* Last state for the command palette (⌘K) – the source there is synchronous. */
let last: CtWatch | null = null;
let fetching = false;
export const ctLast = () => {
  if (!has("proxy")) return null;
  if (!last && !fetching) {
    fetching = true;
    void api
      .get<CtWatch>("/api/ctwatch")
      .then((d) => (last = d))
      .catch(() => undefined)
      .finally(() => (fetching = false));
  }
  return last;
};

export function useCtWatch(): Poll<CtWatch> {
  const [fast, setFast] = useState(false);
  const p = usePoll<CtWatch>(has("proxy") ? "/api/ctwatch" : null, fast ? 2_000 : 60_000);
  useEffect(() => {
    if (p.data) last = p.data;
    setFast(!!p.data?.checking);
  }, [p.data]);
  return p;
}

export const OWN_LABEL: Record<OwnBy, string> = {
  serial: "Serial number matches the Proxy Manager",
  fingerprint: "Fingerprint matches the Proxy Manager",
  run: "Requested in a Proxy Manager renewal run",
};

export const certLabel = (c: CtCert) => (c.names[0] ?? "?") + (c.names.length > 1 ? ` +${c.names.length - 1}` : "");
