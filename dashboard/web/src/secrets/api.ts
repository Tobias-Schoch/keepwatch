/** Secrets check – types and polling (backend: server/secrets_check.py, API.md → "Secrets check"). Never values. Needs Portainer (secrets are stack env vars). */
import { useEffect, useState } from "react";
import { api, usePoll, type Poll } from "../api";
import { has } from "../config";

export type FindingKind = "test-in-prod" | "placeholder" | "weak" | "duplicate" | "due";

export interface SecretFinding {
  kind: FindingKind;
  /** warn = open (counts), info = note or acknowledged. */
  level: "warn" | "info";
  text: string;
  acked?: boolean;
}

export interface SecretItem {
  /** "<stackId>/<NAME>" */
  id: string;
  stackId: number;
  stack: string;
  name: string;
  type: string;
  typeLabel: string;
  production: boolean;
  /** Since when the value is unchanged (Unix seconds). */
  since: number;
  /** true: the value was already there on the first run – `since` is when the stack was created (upper bound). */
  estimated: boolean;
  ageDays: number;
  maxAgeDays: number;
  dueAt: number | null;
  findings: SecretFinding[];
  acked: boolean;
  ackedAt: number | null;
}

export interface SecretType {
  id: string;
  label: string;
  defaultDays: number;
  maxAgeDays: number;
  where: string;
  url: string | null;
  steps: string[];
}

export interface Secrets {
  checkedAt: number | null;
  checking: boolean;
  error: string | null;
  every: number;
  portainer: boolean | null;
  baselineAt: number | null;
  types: SecretType[];
  items: SecretItem[];
  counts: { secrets: number; withFindings: number; due: number };
}

export const openFindings = (i: SecretItem) => i.findings.filter((f) => f.level === "warn");

let last: Secrets | null = null;
let fetching = false;
/** Last known state for the command palette (⌘K). */
export const secretsLast = () => {
  if (!has("portainer")) return null;
  if (!last && !fetching) {
    fetching = true;
    void api
      .get<Secrets>("/api/secrets")
      .then((d) => (last = d))
      .catch(() => undefined)
      .finally(() => (fetching = false));
  }
  return last;
};

export function useSecrets(): Poll<Secrets> {
  const [fast, setFast] = useState(false);
  const p = usePoll<Secrets>(has("portainer") ? "/api/secrets" : null, fast ? 2_000 : 60_000);
  useEffect(() => {
    if (p.data) last = p.data;
    setFast(!!p.data?.checking);
  }, [p.data]);
  return p;
}

/** "~75 d" (estimated) or "12 d" */
export const ageText = (i: SecretItem) => `${i.estimated ? "~" : ""}${i.ageDays} d`;
