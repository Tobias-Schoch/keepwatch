import { Eye, Search, ShieldOff, Unlock } from "lucide-react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { api, refreshAll, type Poll } from "../api";
import { Country } from "../common";
import { has } from "../config";
import { prefersReduced } from "../design/motion";
import { cx, Kbd, Overlay, useCloseOverlay } from "../design/ui";
import { dateTime, dayDate, num, plural } from "../format";
import { openLogs } from "../logs/open";
import { useNav, type View } from "../nav";
import { Detail } from "../pages/Containers";
import { openTool } from "../tools";
import { useSiteActions } from "../pages/Sites";
import type { Container, Country as CountryT, Sites } from "../types";
import { UnbanConfirm } from "./dialogs";
import { asIp, fuzzy } from "./fuzzy";
import { collect, GROUPS, type GroupId, type Jump, type PaletteCtx, type PaletteData, type PaletteItem } from "./registry";
import "./sources";
import "./palette.css";

/* ---------- Open/closed (global, also for the button in the header) -------------------------- */

let isOpen = false;
const listeners = new Set<() => void>();
const set = (v: boolean) => {
  if (isOpen === v) return;
  isOpen = v;
  listeners.forEach((l) => l());
};
export const openPalette = () => set(true);
export const closePalette = () => set(false);
const usePaletteOpen = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => isOpen,
  );

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const PALETTE_KEY = isMac ? "⌘K" : "Ctrl K";

/* ---------- Data: fetched fresh on open, remembered in between ------------------------------- */

const EMPTY: PaletteData = { docker: null, stacks: null, sites: null, backups: null, security: null };
let cache: PaletteData = EMPTY;

function usePaletteData(open: boolean): PaletteData {
  const [d, setD] = useState<PaletteData>(cache);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = <K extends keyof PaletteData>(k: K, path: string) =>
      api.get<NonNullable<PaletteData[K]>>(path).then(
        (v) => {
          cache = { ...cache, [k]: v };
          if (alive) setD(cache);
        },
        () => {},
      );
    // Only what the installed modules provide.
    if (has("docker")) void load("docker", "/api/docker");
    if (has("portainer")) void load("stacks", "/api/stacks");
    if (has("proxy")) void load("sites", "/api/sites");
    if (has("backup")) void load("backups", "/api/backups");
    void load("security", "/api/security");
    return () => {
      alive = false;
    };
  }, [open]);
  return d;
}

/* ---------- Jump: switch page, find the spot, flash it --------------------------------------- */

function jumpTo(go: (v: View) => void, v: View, j: Jump) {
  go(v);
  const want = j.text.trim().toLowerCase();
  let tries = 0;
  const look = () => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(j.sel));
    const el = els.find((e) => {
      const s = (e.textContent ?? "").trim().toLowerCase();
      return j.exact ? s === want : s.includes(want);
    });
    if (!el) {
      if (++tries < 60) setTimeout(look, 100);
      return;
    }
    const target = (j.up && el.closest<HTMLElement>(j.up)) || el;
    target.scrollIntoView({ block: "center", behavior: prefersReduced() ? "auto" : "smooth" });
    target.classList.remove("d-flash");
    void target.offsetWidth;
    target.classList.add("d-flash");
    setTimeout(() => target.classList.remove("d-flash"), 2000);
  };
  setTimeout(look, 80);
}

/* ---------- Host: once in App.tsx ------------------------------------------------------------ */

export function PaletteHost() {
  const { go } = useNav();
  const open = usePaletteOpen();
  const data = usePaletteData(open);
  const [dialog, setDialog] = useState<{ id: number; render: (close: () => void) => ReactNode } | null>(null);
  const [container, setContainer] = useState<Container | null>(null);
  const seq = useRef(0);

  // Reuse the existing site actions (the "Renew certificate" confirmation).
  const sitesPoll = useMemo<Poll<Sites>>(() => ({ data: data.sites, error: null, at: null, refresh: async () => void refreshAll() }), [data.sites]);
  const site = useSiteActions(sitesPoll);
  const askRenew = site.askRenew;

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        set(!isOpen);
      }
    };
    addEventListener("keydown", on, true);
    return () => removeEventListener("keydown", on, true);
  }, []);

  // Keep the open container up to date when new data arrives.
  const live = container ? data.docker?.containers.find((c) => c.name === container.name) ?? container : null;

  const ctx = useMemo<PaletteCtx>(
    () => ({
      go,
      jump: (v, j) => jumpTo(go, v, j),
      dialog: (render) => setDialog({ id: ++seq.current, render }),
      openLogs: (title, containers) => openLogs({ title, containers }),
      openContainer: (c) => {
        go("services");
        setContainer(c);
      },
      renew: (s) => askRenew(s),
    }),
    [go, askRenew],
  );

  return (
    <>
      {open && <Palette data={data} ctx={ctx} />}
      {dialog && <Fragment key={dialog.id}>{dialog.render(() => setDialog((d) => (d?.id === dialog.id ? null : d)))}</Fragment>}
      {live && <Detail key={live.name} c={live} onClose={() => setContainer(null)} />}
      {site.dialogs}
    </>
  );
}

/* ---------- The palette itself --------------------------------------------------------------- */

type Row = { kind: "head"; id: string; label: string } | { kind: "item"; item: PaletteItem; hl: number[]; n: number } | { kind: "ip" };

function Palette({ data, ctx }: { data: PaletteData; ctx: PaletteCtx }) {
  return (
    <Overlay onClose={closePalette} label="Command palette" size="md" align="top" className="o-palette d-palette">
      <PaletteBody data={data} ctx={ctx} />
    </Overlay>
  );
}

const LIMIT_EMPTY: Partial<Record<GroupId, number>> = { actions: 4, tools: 4, services: 8, pages: 5, sites: 0, containers: 0, backups: 0, settings: 0 };

interface IpInfo {
  ip: string;
  country: CountryT;
  tailnet: boolean;
  attempts: { total: number; days: number; first: string | null; last: string | null; since: string | null; last24h: number | null };
  banned: string[];
  bans: { jail: string; bannedAt: number; expiresAt: number | null; banCount: number }[];
  logins: { count: number; first: number; last: number; users: string[]; methods: string[] } | null;
  jails: string[];
}

function useIpInfo(ip: string | null) {
  const [st, setSt] = useState<{ ip: string; info: IpInfo | null; error: string | null } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!ip) return setSt(null);
    let alive = true;
    const t = setTimeout(() => {
      api.get<IpInfo>(`/api/security/ip?ip=${encodeURIComponent(ip)}`).then(
        (info) => alive && setSt({ ip, info, error: null }),
        (e) => alive && setSt({ ip, info: null, error: e instanceof Error ? e.message : String(e) }),
      );
    }, 180);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [ip, tick]);
  return { st: st && st.ip === ip ? st : null, reload: () => setTick((n) => n + 1) };
}

function PaletteBody({ data, ctx }: { data: PaletteData; ctx: PaletteCtx }) {
  const close = useCloseOverlay();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLSpanElement>(null);

  const items = useMemo(() => collect(data), [data]);
  const ip = asIp(q);
  const { st: ipState, reload: reloadIp } = useIpInfo(ip);
  const info = ipState?.info ?? null;

  const ipItems = useMemo<PaletteItem[]>(() => {
    if (!info) return [];
    const out: PaletteItem[] = info.banned.map((jail) => ({
      id: `ip-unban:${jail}`,
      group: "actions",
      title: `Unban ${info.ip}`,
      hint: `Lift the ban in ${jail}`,
      icon: Unlock,
      run: (c: PaletteCtx) => c.dialog((done) => <UnbanConfirm ip={info.ip} jail={jail} loggedIn={!!info.logins} onClose={done} onDone={reloadIp} />),
    }));
    out.push({ id: "ip-view", group: "actions", title: "Open Security", hint: "Bans, sources, countries", icon: Eye, run: (c) => c.go("security") });
    return out;
  }, [info, reloadIp]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let n = 0;
    if (ip) {
      out.push({ kind: "ip" });
      for (const it of ipItems) out.push({ kind: "item", item: it, hl: [], n: n++ });
    }
    const needle = ip ? "" : q.trim();
    if (ip) return out;
    const scored = new Map<GroupId, { item: PaletteItem; score: number; hl: number[] }[]>();
    for (const it of items) {
      if (!needle && it.searchOnly) continue;
      const m = fuzzy(needle, it.title, `${it.keywords ?? ""} ${it.hint ?? ""}`);
      if (!m) continue;
      const arr = scored.get(it.group) ?? [];
      arr.push({ item: it, score: m.score + (it.rank ?? 0) * 6, hl: m.hl });
      scored.set(it.group, arr);
    }
    for (const g of GROUPS) {
      const arr = scored.get(g.id);
      if (!arr?.length) continue;
      const limit = needle ? (g.id === "actions" ? 7 : 6) : LIMIT_EMPTY[g.id] ?? 4;
      if (!limit) continue;
      arr.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));
      out.push({ kind: "head", id: g.id, label: g.label });
      for (const r of arr.slice(0, limit)) out.push({ kind: "item", item: r.item, hl: r.hl, n: n++ });
    }
    return out;
  }, [items, q, ip, ipItems]);

  const count = rows.filter((r) => r.kind === "item").length;
  useEffect(() => setActive(0), [q]);
  const act = count ? Math.min(active, count - 1) : -1;

  // Glass marker under the active entry + keep it in view
  useLayoutEffect(() => {
    const box = list.current;
    const m = marker.current;
    if (!box || !m) return;
    const el = box.querySelector<HTMLElement>(`[data-n="${act}"]`);
    if (!el) {
      m.style.opacity = "0";
      return;
    }
    m.style.opacity = "1";
    m.style.height = `${el.offsetHeight}px`;
    m.style.transform = `translate3d(0, ${el.offsetTop}px, 0)`;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < box.scrollTop + 8) box.scrollTop = Math.max(0, top - 40);
    else if (bottom > box.scrollTop + box.clientHeight - 8) box.scrollTop = bottom - box.clientHeight + 8;
  }, [act, rows]);

  const runItem = useCallback(
    (it: PaletteItem) => {
      if (it.href) {
        openTool(it.href);
        close();
        return;
      }
      close(() => it.run(ctx));
    },
    [close, ctx],
  );

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!count) return;
      const d = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (Math.min(a, count - 1) + d + count) % count);
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      if (count) setActive((a) => Math.max(0, Math.min(count - 1, a + (e.key === "PageDown" ? 5 : -5))));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = rows.find((x) => x.kind === "item" && x.n === act);
      if (r && r.kind === "item") runItem(r.item);
    } else if (e.key === "Tab") {
      // Focus trap: focus stays in the input, arrows choose.
      e.preventDefault();
      if (count) setActive((a) => (Math.min(a, count - 1) + (e.shiftKey ? -1 : 1) + count) % count);
    }
  };

  const activeId = act >= 0 ? `pal-opt-${act}` : undefined;

  return (
    <>
      <div className="o-palette-input">
        <Search className="h-5 w-5 shrink-0 text-[var(--o-mute)]" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder={`Search ${[has("docker") && "services", has("proxy") && "sites", has("docker") && "containers", "actions"].filter(Boolean).join(", ")} or an IP…`}
          aria-label="Command palette"
          role="combobox"
          aria-expanded="true"
          aria-controls="pal-list"
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          autoComplete="off"
          spellCheck={false}
          data-autofocus
        />
        <Kbd>esc</Kbd>
      </div>
      <div ref={list} id="pal-list" className="o-palette-list" role="listbox" aria-label="Results">
        <span ref={marker} className="o-palette-marker" aria-hidden />
        {rows.map((r, i) => {
          if (r.kind === "ip") return <IpCard key="ip" ip={ip!} state={ipState} />;
          if (r.kind === "head")
            return (
              <div key={`h-${r.id}`} className="o-palette-group" role="presentation">
                {r.label}
              </div>
            );
          const it = r.item;
          const on = r.n === act;
          const Icon = it.icon;
          return (
            <div
              key={`${it.id}-${i}`}
              id={`pal-opt-${r.n}`}
              data-n={r.n}
              role="option"
              aria-selected={on}
              className={cx("o-palette-item", on && "is-on")}
              onMouseMove={() => r.n !== act && setActive(r.n)}
              onClick={() => runItem(it)}
            >
              <span className="o-palette-icon" aria-hidden>
                <Icon className="h-4 w-4" />
              </span>
              <span className={cx("d-pal-title", it.mono && "d-mono")}>{mark(it.title, r.hl)}</span>
              {it.hint && <span className="o-palette-hint">{it.hint}</span>}
              <span className="flex-1" />
              {on && <Kbd>↵</Kbd>}
            </div>
          );
        })}
        {!count && !ip && <div className="o-palette-empty">No results for “{q.trim()}”.</div>}
      </div>
      <div className="o-palette-foot">
        <span>
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> select
        </span>
        <span>
          <Kbd>↵</Kbd> run
        </span>
        <span>
          <Kbd>esc</Kbd> close
        </span>
        <span className="d-pal-foot-hint">Type an IP: country, attempts, bans</span>
      </div>
    </>
  );
}

function mark(text: string, hl: number[]): ReactNode {
  if (!hl.length) return text;
  const out: ReactNode[] = [];
  const set = new Set(hl);
  let i = 0;
  while (i < text.length) {
    const on = set.has(i);
    let j = i;
    while (j < text.length && set.has(j) === on) j++;
    out.push(on ? <b key={i}>{text.slice(i, j)}</b> : text.slice(i, j));
    i = j;
  }
  return out;
}

function IpCard({ ip, state }: { ip: string; state: { info: IpInfo | null; error: string | null } | null }) {
  const info = state?.info;
  return (
    <div className="d-pal-ip" role="status" aria-live="polite">
      <div className="d-pal-ip-head">
        <span className="d-mono">{ip}</span>
        {info && <Country c={info.country} />}
        {info && (info.banned.length ? <span className="d-pal-tag" data-tone="rose">banned · {info.banned.join(", ")}</span> : <span className="d-pal-tag">not banned</span>)}
      </div>
      {!state ? (
        <p className="d-pal-ip-dim">Looking up…</p>
      ) : state.error ? (
        <p className="d-pal-ip-dim o-text-rose">{state.error}</p>
      ) : info ? (
        <dl className="d-pal-ip-facts">
          <div>
            <dt>SSH attempts</dt>
            <dd>
              {info.attempts.total ? (
                <>
                  {num(info.attempts.total)} on {plural(info.attempts.days, "day", "days")}
                  {info.attempts.last ? `, last on ${dayDate(info.attempts.last)}` : ""}
                </>
              ) : (
                <>none{info.attempts.since ? ` since ${dayDate(info.attempts.since)}` : ""}</>
              )}
              {info.attempts.last24h !== null && <> · {num(info.attempts.last24h)} in 24 h</>}
            </dd>
          </div>
          <div>
            <dt>Bans</dt>
            <dd>
              {info.bans.length ? (
                <>
                  {plural(info.bans.length, "ban", "bans")}, last {dateTime(info.bans[0].bannedAt)} ({info.bans[0].jail})
                </>
              ) : (
                "never banned"
              )}
            </dd>
          </div>
          <div>
            <dt>Logins</dt>
            <dd>
              {info.logins ? (
                <>
                  {plural(info.logins.count, "successful", "successful")} ({info.logins.users.join(", ")}), last {dateTime(info.logins.last)}
                </>
              ) : (
                "none successful"
              )}
            </dd>
          </div>
        </dl>
      ) : null}
      {info && !info.banned.length && has("fail2ban") && (
        <p className="d-pal-ip-dim">
          <ShieldOff className="mr-1 inline h-3.5 w-3.5 align-[-2px]" aria-hidden />
          Manual bans aren’t possible from the dashboard (there is no endpoint for it) – fail2ban bans on its own.
        </p>
      )}
    </div>
  );
}
