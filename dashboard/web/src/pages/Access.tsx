import { Copy, Globe, LockKeyhole, Plus, ShieldCheck, ShieldOff, Trash2, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, refreshAll } from "../api";
import { Button, Callout, Confirm, cx, DialogHead, IconButton, Overlay, Pill, Segmented } from "../design/ui";
import { num } from "../format";
import { addressCount, covers, isPrivateRelay, isValidEntry, normalize } from "../ip";
import { useAction, useToast } from "../messages";
import type { Access, AccessEntry, AccessHost } from "../types";

type Mode = AccessHost["mode"];
type LockMode = "open" | "list";

/* Per-site IP allow-lists in Nginx Proxy Manager (module `proxy`; opened from the Sites list). */

interface Row extends AccessEntry {
  key: number;
  isNew?: boolean;
}

interface Draft {
  mode: Mode;
  rows: Row[];
}

/** Admin paths: allow-list only for some paths, the rest of the site stays open. */
interface LockDraft {
  on: boolean;
  paths: string[];
  rows: Row[];
}

/** Suggested when turned on: the usual admin paths (the site grade checks these too). */
const DEFAULT_PATHS = ["/admin", "/api/admin/"];
const PATH_OK = /^\/[A-Za-z0-9/_.-]+$/;
const validPath = (p: string) => PATH_OK.test(p) && p.length <= 120 && !p.includes("//") && !p.split("/").some((s) => s === "." || s === "..");

const toRows = (es: AccessEntry[], offset = 0): Row[] => es.map((e, i) => ({ ...e, key: offset + i }));
const toDraft = (h: AccessHost): Draft => ({ mode: h.mode, rows: toRows(h.entries) });
const toLock = (h: AccessHost): LockDraft => {
  const pl = h.pathLock ?? { paths: [], entries: [] }; // older backend without pathLock
  return { on: pl.paths.length > 0, paths: pl.paths.length ? pl.paths : DEFAULT_PATHS, rows: toRows(pl.entries, 5_000) };
};
const plain = (rows: Row[]) => rows.map((r) => ({ value: normalize(r.value), note: r.note.trim() }));
/** Comparison form: what saving would actually send. */
const payload = (d: Draft) => ({ mode: d.mode, entries: d.mode === "open" ? [] : plain(d.rows) });
/** Off = no paths; the list stays stored and is back when turned on again. */
const lockPayload = (l: LockDraft) => ({ paths: l.on ? l.paths : [], entries: plain(l.rows) });

function AddressCount({ n }: { n: number }) {
  if (n <= 1) return null;
  const big = n > 256;
  return (
    <Pill tone={big ? "sand" : "neutral"} title={big ? "Large range – every one of these addresses gets in" : undefined}>
      {n >= Number.MAX_SAFE_INTEGER ? "very many" : num(n)} addresses
    </Pill>
  );
}

/** Edit an address list – the same for the whole site and for admin paths. */
function EntryEditor({
  rows,
  onChange,
  myIps,
  newKey,
  where,
  empty,
}: {
  rows: Row[];
  onChange: (rows: Row[]) => void;
  myIps: string[];
  newKey: () => number;
  /** "the site" / "the admin paths" */
  where: string;
  /** instead of the red notice while the list is empty */
  empty?: ReactNode;
}) {
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [bad, setBad] = useState<string | null>(null);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r) => m.set(normalize(r.value), (m.get(normalize(r.value)) ?? 0) + 1));
    return m;
  }, [rows]);
  const missingIp = rows.length ? myIps.find((ip) => !rows.some((r) => covers(r.value, ip))) : undefined;
  const shared = rows.filter((r) => isPrivateRelay(r.value));

  const add = (v: string, n: string) => {
    const val = v.trim();
    if (!isValidEntry(val)) {
      setBad("That is not an IP address or range (e.g. 198.51.100.23 or 198.51.100.128/25).");
      return;
    }
    if (rows.some((r) => normalize(r.value) === normalize(val))) {
      setBad(`${normalize(val)} is already on the list.`);
      return;
    }
    onChange([...rows, { key: newKey(), value: normalize(val), note: n.trim(), addresses: addressCount(val), isNew: true }]);
    setValue("");
    setNote("");
    setBad(null);
  };

  return (
    <>
      {missingIp && (
        <Callout
          tone="sand"
          icon={UserRound}
          title={`Your current IP (${missingIp}) is not on the list – you would lock yourself out of ${where}.`}
          action={
            <Button size="sm" variant="secondary" onClick={() => add(missingIp, "my IP")}>
              <Plus className="h-3.5 w-3.5" /> Add
            </Button>
          }
        />
      )}
      {shared.length > 0 && (
        <Callout tone="sand" title={`${shared.length} ${shared.length === 1 ? "entry is" : "entries are"} probably iCloud Private Relay`}>
          Other Apple users share these addresses and get in too. Safer: remove them and add the fixed address of your connection instead.
        </Callout>
      )}

      {rows.length > 0 ? (
        <div className="d-table-wrap">
          <table className="d-table">
            <thead>
              <tr>
                <th>Address</th>
                <th>Note</th>
                <th />
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const dup = (counts.get(normalize(r.value)) ?? 0) > 1;
                const mine = myIps.some((ip) => covers(r.value, ip));
                return (
                  <tr key={r.key}>
                    <td className="is-main whitespace-nowrap">
                      <span className="d-mono">{r.value}</span>
                      {r.isNew && <i className="o-seg-dot ml-2 inline-block align-middle" title="New, not saved yet" />}
                    </td>
                    <td className="w-full min-w-[160px]">
                      <input
                        className="d-note-input"
                        value={r.note}
                        onChange={(e) => onChange(rows.map((x) => (x.key === r.key ? { ...x, note: e.target.value } : x)))}
                        placeholder="Note, e.g. Office"
                        aria-label={`Note for ${r.value}`}
                        spellCheck={false}
                      />
                    </td>
                    <td className="whitespace-nowrap">
                      <span className="flex justify-end gap-1.5">
                        {mine && <Pill tone="ok">you</Pill>}
                        <AddressCount n={r.addresses} />
                        {isPrivateRelay(r.value) && (
                          <Pill tone="sand" title="Other Apple users share this address and get in too.">
                            shared – iCloud Private Relay?
                          </Pill>
                        )}
                        {dup && (
                          <Pill tone="neutral" title="Listed more than once – merged when saving">
                            duplicate
                          </Pill>
                        )}
                      </span>
                    </td>
                    <td className="is-right">
                      <IconButton label={`Remove ${r.value}`} size="sm" onClick={() => onChange(rows.filter((x) => x.key !== r.key))}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </IconButton>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        (empty ?? (
          <Callout tone="rose" title="The list is empty">
            Nobody could reach {where} – you included. Add at least one address.
          </Callout>
        ))
      )}

      <form
        className="flex flex-col gap-2 rounded-[14px] bg-white/[0.02] p-3 shadow-[inset_0_0_0_1px_var(--o-line)]"
        onSubmit={(e) => {
          e.preventDefault();
          add(value, note);
        }}
      >
        <div className="o-micro">Add address</div>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <input
            className={cx("o-input d-mono", bad && "is-bad")}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setBad(null);
            }}
            placeholder="IP or range, e.g. 198.51.100.23"
            aria-label="IP or range"
            spellCheck={false}
            autoComplete="off"
          />
          <input className="o-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label="Note" autoComplete="off" />
          <Button type="submit" variant="secondary" disabled={!value.trim()}>
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>
        {bad && <p className="o-field-error">{bad}</p>}
        <div className="flex flex-wrap items-center gap-2">
          {myIps.map((ip) => {
            const inList = rows.some((r) => covers(r.value, ip));
            return (
              <Button key={ip} size="sm" variant="ghost" disabled={inList} onClick={() => add(ip, "my IP")} title={inList ? "Already on the list" : undefined}>
                <UserRound className="h-3.5 w-3.5" /> Add my IP <span className="d-mono o-mute">{ip}</span>
              </Button>
            );
          })}
        </div>
      </form>
    </>
  );
}

/** Paths as small tags, followed by a field for more. */
function PathField({ paths, onChange }: { paths: string[]; onChange: (p: string[]) => void }) {
  const [value, setValue] = useState("");
  const [bad, setBad] = useState<string | null>(null);
  const add = () => {
    const p = value.trim();
    if (!p) return;
    if (!validPath(p)) {
      setBad("A path starts with / and contains only letters, digits and / _ . - (e.g. /admin).");
      return;
    }
    if (!paths.includes(p)) onChange([...paths, p]);
    setValue("");
    setBad(null);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {paths.map((p) => (
          <Pill key={p} className="d-mono">
            {p}
            <button type="button" className="-mr-1 ml-0.5 rounded p-0.5 opacity-60 hover:opacity-100" aria-label={`Remove ${p}`} title={`Remove ${p}`} onClick={() => onChange(paths.filter((x) => x !== p))}>
              <X className="h-3 w-3" />
            </button>
          </Pill>
        ))}
        <input
          className={cx("o-input d-mono !h-8 !w-48 !py-1 !text-[13px]", bad && "is-bad")}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setBad(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
          placeholder="+ path, e.g. /internal"
          aria-label="Add path"
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      {bad ? <p className="o-field-error">{bad}</p> : !paths.length && <p className="o-field-error">At least one path.</p>}
    </div>
  );
}

export function AccessSheet({ siteId, onClose }: { siteId: number; onClose: () => void }) {
  const [data, setData] = useState<Access | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [lock, setLock] = useState<LockDraft | null>(null);
  const keyRef = useRef(10_000);
  const newKey = () => keyRef.current++;
  const [askOpen, setAskOpen] = useState(false);
  const { busy, run } = useAction();
  const toast = useToast();

  const host = data?.hosts.find((h) => h.id === siteId) ?? null;
  const domain = host?.domains[0] ?? "this site";

  const load = useCallback(async () => {
    try {
      const a = await api.get<Access>("/api/access");
      setData(a);
      setError(null);
      const h = a.hosts.find((x) => x.id === siteId);
      setDraft(h ? toDraft(h) : null);
      setLock(h ? toLock(h) : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [siteId]);
  useEffect(() => {
    void load();
  }, [load]);

  const siteDirty = useMemo(() => !!host && !!draft && JSON.stringify(payload(draft)) !== JSON.stringify(payload(toDraft(host))), [host, draft]);
  const lockDirty = useMemo(() => !!host && !!lock && JSON.stringify(lockPayload(lock)) !== JSON.stringify(lockPayload(toLock(host))), [host, lock]);
  const dirty = siteDirty || lockDirty;
  const reset = () => {
    if (!host) return;
    setDraft(toDraft(host));
    setLock(toLock(host));
  };

  const myIps = data?.myIps ?? [];
  /** Other sites with a list – as a template for the admin paths. */
  const templates = (data?.hosts ?? []).filter((h) => h.id !== siteId && h.mode === "list" && h.entries.length > 0);

  const setMode = (m: Mode) => {
    if (!draft || m === draft.mode) return;
    if (m === "open") setAskOpen(true);
    else setDraft({ ...draft, mode: "list" });
  };

  const save = () => {
    if (!draft || !lock) return;
    let saved = false;
    void run("save", async () => {
      // Admin paths first, then the whole site: opening the site while locking /admin never leaves
      // a moment where /admin is open. Each request asks for the passkey on its own.
      const done: string[] = [];
      if (lockDirty) {
        await api.put(`/api/access/${siteId}/pfade`, lockPayload(lock));
        saved = true;
        done.push(lock.on ? `Admin paths of ${domain} restricted to the list.` : `Admin paths of ${domain} open again.`);
      }
      if (siteDirty) {
        await api.put(`/api/access/${siteId}`, payload(draft));
        saved = true;
        done.push(draft.mode === "open" ? `${domain} is now open to everyone.` : `Access for ${domain} saved.`);
      }
      toast(done.join(" "));
    }).then(async () => {
      if (saved) {
        await load();
        refreshAll();
      }
    });
  };

  const siteEmpty = draft?.mode === "list" && draft.rows.length === 0;
  const lockInvalid = !!lock?.on && (lock.paths.length === 0 || lock.rows.length === 0);

  return (
    <Overlay
      onClose={onClose}
      label={`Access to ${domain}`}
      size="lg"
      align="top"
      onEscape={() => {
        if (!dirty) return false;
        reset();
        return true;
      }}
    >
      <DialogHead
        icon={ShieldCheck}
        title="Manage access"
        sub={
          <>
            <b>{domain}</b>
            {host && host.domains.length > 1 && <> · also {host.domains.slice(1).join(", ")}</>}
          </>
        }
      />
      <div className="o-dialog-scroll">
        <div className="o-dialog-body">
          {error ? (
            <Callout tone="rose" title="Couldn't load the access list">
              {error}
            </Callout>
          ) : !data ? (
            <div className="o-empty !py-10">Loading …</div>
          ) : !host || !draft || !lock ? (
            <Callout tone="sand" title="Unknown proxy host">
              It is not (or no longer) in the Proxy Manager database.
            </Callout>
          ) : (
            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap items-center gap-3">
                <Segmented<Mode>
                  ariaLabel="Who can reach the site"
                  value={draft.mode}
                  onChange={setMode}
                  options={[
                    { id: "open", label: <><Globe className="h-3.5 w-3.5" /> Open to everyone</> },
                    { id: "list", label: <><ShieldCheck className="h-3.5 w-3.5" /> Only these addresses</> },
                  ]}
                />
                <span className="o-hint">{draft.mode === "open" ? "Anyone on the internet can reach the site." : "Everyone else gets a 403."}</span>
              </div>

              {draft.mode === "list" ? (
                <>
                  <EntryEditor rows={draft.rows} onChange={(rows) => setDraft({ ...draft, rows })} myIps={myIps} newKey={newKey} where="the site" />
                  {lock.on && (
                    <Callout
                      tone="neutral"
                      icon={LockKeyhole}
                      title={`Admin paths ${lock.paths.join(", ")} have their own list – not needed while the whole site is restricted.`}
                      action={
                        <Button size="sm" variant="ghost" onClick={() => setLock({ ...lock, on: false })}>
                          Turn off
                        </Button>
                      }
                    >
                      These paths use their own list ({lock.rows.length} {lock.rows.length === 1 ? "entry" : "entries"}) instead of the one above.
                    </Callout>
                  )}
                </>
              ) : (
                <div className="flex flex-col gap-4 pt-5 shadow-[inset_0_1px_0_var(--o-line)]">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="o-micro">Admin paths</span>
                    <Segmented<LockMode>
                      ariaLabel="Who can reach the admin paths"
                      size="sm"
                      value={lock.on ? "list" : "open"}
                      onChange={(m) => setLock({ ...lock, on: m === "list" })}
                      options={[
                        { id: "open", label: "Open" },
                        { id: "list", label: <><LockKeyhole className="h-3.5 w-3.5" /> List only</> },
                      ]}
                    />
                    <span className="o-hint">{lock.on ? "Others get a 403 there, the rest stays open." : "Restricts only some paths, e.g. /admin."}</span>
                  </div>
                  {lock.on && (
                    <>
                      <PathField paths={lock.paths} onChange={(paths) => setLock({ ...lock, paths })} />
                      <EntryEditor
                        rows={lock.rows}
                        onChange={(rows) => setLock({ ...lock, rows })}
                        myIps={myIps}
                        newKey={newKey}
                        where="the admin paths"
                        empty={
                          templates.length > 0 ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="o-hint">Empty. Copy the list from</span>
                              {templates.map((t) => (
                                <Button key={t.id} size="sm" variant="secondary" onClick={() => setLock({ ...lock, rows: t.entries.map((e) => ({ ...e, key: newKey(), isNew: true })) })}>
                                  <Copy className="h-3.5 w-3.5" /> {t.domains[0]} <span className="o-mute">({t.entries.length})</span>
                                </Button>
                              ))}
                            </div>
                          ) : undefined
                        }
                      />
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {draft && lock && host && (
        <div className="o-dialog-foot">
          {dirty ? (
            <span className="o-unsaved mr-auto">
              <i /> Unsaved · Esc discards
            </span>
          ) : (
            <span className="o-hint mr-auto">
              {draft.mode === "open" ? "Open to everyone" : `${draft.rows.length} ${draft.rows.length === 1 ? "entry" : "entries"}`}
              {lock.on && " · admin paths list only"}.
            </span>
          )}
          {dirty && (
            <Button variant="ghost" onClick={reset}>
              Discard
            </Button>
          )}
          <Button variant="primary" disabled={!dirty || siteEmpty || (lockDirty && lockInvalid) || !!busy} onClick={save}>
            {busy ? "Saving …" : "Save"}
          </Button>
        </div>
      )}
      {askOpen && draft && (
        <Confirm
          icon={ShieldOff}
          copy={{
            title: `Open ${domain} to everyone?`,
            description: lock?.on ? `Anyone on the internet can then reach the site – except the admin paths (${lock.paths.join(", ")}).` : "Anyone on the internet can then reach the site, not just your addresses.",
            note: draft.rows.length ? `The list with ${draft.rows.length} ${draft.rows.length === 1 ? "entry" : "entries"} is deleted when you save. Until then you can still go back.` : undefined,
            confirmLabel: "Open to everyone",
            tone: "danger",
          }}
          onClose={() => setAskOpen(false)}
          onConfirm={() => setDraft({ ...draft, mode: "open" })}
        />
      )}
    </Overlay>
  );
}
