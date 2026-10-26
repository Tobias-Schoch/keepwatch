/**
 * Mock for the certificate watch (?mock). One foreign certificate (store.example.com, Sectigo,
 * newly seen → loud), two older ones from a previous host (quiet, "mark all known"), the rest from this server.
 * "Known" silences it, "Check now" briefly shows the checking state. Without proxy: {"enabled": false}.
 */
import { has } from "./config";
import type { CtCert, CtWatch } from "./ctwatch/api";

const now = () => Math.floor(Date.now() / 1000);
const D = 86400;
let checkingUntil = 0;
const known = new Map<string, number>();

function cert(key: string, names: string[], issuer: string, cn: string, ageDays: number, extra: Partial<CtCert> = {}): CtCert {
  const nb = now() - ageDays * D;
  return {
    key, names, issuer, issuerCn: cn, notBefore: nb, notAfter: nb + 90 * D, expired: nb + 90 * D < now(), revoked: false,
    firstSeen: now() - Math.min(ageDays, 3) * D, own: true, ownBy: "serial", ownNote: "Serial number matches npm-4/cert5.pem in the Proxy Manager",
    known: false, knownAt: null, alert: false, baseline: true, src: "certspotter", crtsh: `https://crt.sh/?serial=${key}`, ...extra,
  };
}

function certs(): CtCert[] {
  const list: CtCert[] = [
    cert("4f1a9c", ["store.example.com", "www.store.example.com"], "Sectigo", "Sectigo RSA Domain Validation Secure Server CA", 1, { own: false, ownBy: null, ownNote: null, alert: true, baseline: false, firstSeen: now() - 3 * 3600 }),
    cert("617f02", ["example.com"], "Let's Encrypt", "YE1", 15),
    cert("551628", ["blog.example.com"], "Let's Encrypt", "YE1", 15),
    cert("694cd5", ["shop.example.com"], "Let's Encrypt", "YE1", 17),
    cert("3f677a", ["api.shop.example.com"], "Let's Encrypt", "YE2", 17, { ownBy: "run", ownNote: "Requested in the Proxy Manager renewal run on Oct 6, 2026, 08:36 UTC" }),
    cert("53c336", ["old.example.com"], "Let's Encrypt", "YE2", 24),
    cert("63f081", ["photos.example.com"], "Let's Encrypt", "YE2", 25),
    cert("5622df", ["wiki.example.com"], "Let's Encrypt", "YE1", 85),
    cert("9a01bb", ["example.net", "www.example.net"], "ZeroSSL", "ZeroSSL RSA Domain Secure Site CA", 70, { own: false, ownBy: null, ownNote: null }),
    cert("c0ffee", ["*.example.net"], "Google Trust Services", "WE1", 62, { own: false, ownBy: null, ownNote: null }),
  ];
  return list
    .map((c) => (known.has(c.key) ? { ...c, known: true, knownAt: known.get(c.key)!, alert: false } : c))
    .sort((a, b) => Number(b.alert) - Number(a.alert) || Number(a.own || a.known) - Number(b.own || b.known) || (b.notBefore ?? 0) - (a.notBefore ?? 0));
}

function state(): CtWatch {
  const list = certs();
  return {
    checkedAt: now() - 2 * 3600, checking: Date.now() < checkingUntil, error: null, every: 21600, source: "certspotter",
    baselineAt: now() - 3 * D, bases: ["example.com", "example.net"],
    hosts: ["blog.example.com", "example.com", "old.example.com", "photos.example.com", "shop.example.com", "wiki.example.com"],
    counts: {
      total: list.length, own: list.filter((c) => c.own).length, known: list.filter((c) => c.known && !c.own).length,
      unknown: list.filter((c) => !c.own && !c.known).length, alerts: list.filter((c) => c.alert).length,
    },
    certs: list,
  };
}

export function mockCtWatch(method: string, p: string, body: unknown): unknown {
  if (!p.startsWith("/api/ctwatch")) return undefined;
  if (!has("proxy")) return { enabled: false };
  if (method === "GET" && p === "/api/ctwatch") return state();
  if (method === "POST" && p === "/api/ctwatch/check") {
    checkingUntil = Date.now() + 2500;
    return { ok: true, checking: true };
  }
  if (method === "POST" && p === "/api/ctwatch/known") {
    const b = (body ?? {}) as { keys?: string[]; all?: string; undo?: boolean };
    const hit = certs().filter((c) => !c.own && (b.keys?.includes(c.key) || b.all === "all" || (b.all === "baseline" && c.baseline && !c.alert)));
    for (const c of hit) {
      if (b.undo) known.delete(c.key);
      else known.set(c.key, now());
    }
    return { ok: true, count: hit.length, message: `${hit.length} marked as known.` };
  }
  throw new Error("Unknown endpoint.");
}

/** For health (dock dot) in the mock. */
export function mockCtProblems() {
  if (!has("proxy")) return [];
  const a = certs().filter((c) => c.alert);
  if (!a.length) return [];
  return [{ level: "warn" as const, area: "security" as const, key: "ctwatch.foreign-cert", title: `Foreign certificate for ${a[0].names[0]}${a[0].names.length > 1 ? ` (+${a[0].names.length - 1})` : ""}`, detail: `${a[0].issuer}, issued today, not by this server. Check it under Security → Certificates or mark it as known.` }];
}
