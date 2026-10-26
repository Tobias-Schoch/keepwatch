import { Eye, EyeOff, KeyRound, Pencil, Plus, RefreshCw, Rocket, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, refreshAll } from "../api";
import { Button, Callout, Confirm, CopyButton, cx, DialogHead, IconButton, Overlay, Toggle, useCloseOverlay } from "../design/ui";
import { useAction } from "../messages";
import type { EnvVar, Stack } from "../types";

export const repoName = (url: string) => url.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "");
export const branch = (ref: string) => ref.replace(/^refs\/heads\//, "") || "default branch";
const NAME_OK = /^[A-Za-z_][A-Za-z0-9_]*$/;

/* ---------- Redeploy -------------------------------------------------------------------- */

export function Redeploy({ s, onClose }: { s: Stack; onClose: () => void }) {
  return (
    <Overlay onClose={onClose} label={`Redeploy ${s.name}`} size="sm" className="o-confirm">
      <RedeployBody s={s} />
    </Overlay>
  );
}

function RedeployBody({ s }: { s: Stack }) {
  const close = useCloseOverlay();
  const { busy, run } = useAction();
  const [pull, setPull] = useState(true);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void run("deploy", () => api.post(`/api/stacks/${s.id}/redeploy`, { pullImage: pull }), `Redeploying ${s.name}.`).then((ok) => {
          if (ok) {
            refreshAll();
            close();
          }
        });
      }}
    >
      <div className="o-confirm-body">
        <span className="o-confirm-icon" data-tone="accent">
          <Rocket className="h-5 w-5" />
        </span>
        <h2 className="o-confirm-title">Redeploy {s.name}?</h2>
        <p className="o-confirm-text">
          Portainer pulls the latest {s.git ? <>from <b>{branch(s.git.ref)}</b></> : "compose file"} and replaces the containers. The site is down for a few seconds.
        </p>
        <div className="o-switch-row mt-5 text-left">
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-medium text-[var(--o-text)]">Pull image again</div>
            <div className="o-hint">Needed when there’s a new :latest in the registry.</div>
          </div>
          <Toggle checked={pull} onChange={setPull} label="Pull image again" />
        </div>
      </div>
      <div className="o-confirm-foot">
        <Button variant="ghost" onClick={() => close()}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!!busy} data-autofocus>
          {busy ? <RefreshCw className="h-4 w-4 o-spin" /> : <Rocket className="h-4 w-4" />}
          {busy ? "Deploying …" : "Redeploy"}
        </Button>
      </div>
    </form>
  );
}

/* ---------- Environment variables ----------------------------------------------------------- */

interface Row extends EnvVar {
  key: number;
  isNew?: boolean;
}

/** `focus`: name of a variable – the dialog opens in edit mode with that value field focused (Secrets → "Rotate"). */
export function EnvSheet({ s, canEdit, onClose, focus }: { s: Stack; canEdit: boolean; onClose: () => void; focus?: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [orig, setOrig] = useState<EnvVar[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const [shown, setShown] = useState<Set<number>>(new Set());
  const [ask, setAsk] = useState(false);
  const { busy, run } = useAction();
  const [nextKey, setNextKey] = useState(1000);

  const load = async () => {
    try {
      const r = await api.get<{ env: EnvVar[] }>(`/api/stacks/${s.id}/env`);
      setOrig(r.env);
      setRows(r.env.map((e, i) => ({ ...e, key: i })));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void load();
  }, [s.id]);
  const [focusDone, setFocusDone] = useState(false);
  useEffect(() => {
    if (!focus || focusDone || !rows || !canEdit) return;
    setFocusDone(true);
    if (rows.some((r) => r.name === focus)) setEdit(true);
  }, [rows, focus, focusDone, canEdit]);

  const problems = useMemo(() => {
    if (!rows) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      if (!r.name.trim()) out.push("A row has no name.");
      else if (!NAME_OK.test(r.name.trim())) out.push(`“${r.name}” isn’t a valid name (letters, digits and _ only; can’t start with a digit).`);
      else if (seen.has(r.name.trim())) out.push(`“${r.name}” appears twice.`);
      seen.add(r.name.trim());
    }
    return [...new Set(out)];
  }, [rows]);

  const changed = useMemo(() => {
    if (!rows) return false;
    const a = rows.map((r) => `${r.name.trim()}=${r.value}`).join("\n");
    const b = orig.map((r) => `${r.name}=${r.value}`).join("\n");
    return a !== b;
  }, [rows, orig]);

  const toggle = (k: number) =>
    setShown((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const set = (k: number, patch: Partial<EnvVar>) => setRows((list) => list && list.map((r) => (r.key === k ? { ...r, ...patch } : r)));

  const save = () =>
    void run("save", () => api.put(`/api/stacks/${s.id}/env`, { env: rows!.map((r) => ({ name: r.name.trim(), value: r.value })) }), `${s.name}: variables saved, redeploying.`).then((ok) => {
      if (ok) {
        setEdit(false);
        setShown(new Set());
        void load();
        refreshAll();
      }
    });

  return (
    <Overlay onClose={onClose} label={`Environment variables of ${s.name}`} size="lg" align="top">
      <DialogHead icon={KeyRound} title="Environment variables" sub={<>Stack <b>{s.name}</b> · Values are hidden; the eye reveals one at a time.</>} />
      <div className="o-dialog-scroll">
        <div className="o-dialog-body">
          {error ? (
            <Callout tone="rose" title="Couldn’t load the variables">
              {error}
            </Callout>
          ) : !rows ? (
            <div className="o-empty !py-10">Loading …</div>
          ) : rows.length === 0 && !edit ? (
            <div className="o-empty !py-10">
              <span className="o-empty-title">No variables</span>
              This stack gets everything from its compose file.
            </div>
          ) : (
            <div className="d-env">
              {rows.map((r) =>
                edit ? (
                  <div key={r.key} className={cx("d-env-row", r.isNew && "is-new", focus && r.name === focus && "is-focus")}>
                    <input className={cx("o-input", r.name && !NAME_OK.test(r.name.trim()) && "is-bad")} value={r.name} onChange={(e) => set(r.key, { name: e.target.value })} placeholder="NAME" aria-label="Name" spellCheck={false} autoComplete="off" autoFocus={r.isNew} />
                    <input className="o-input" value={r.value} onChange={(e) => set(r.key, { value: e.target.value })} placeholder="Value" aria-label={`Value of ${r.name || "new variable"}`} spellCheck={false} autoComplete="off" type={shown.has(r.key) || r.isNew ? "text" : "password"} autoFocus={!!focus && r.name === focus} onFocus={focus && r.name === focus ? (e) => e.currentTarget.select() : undefined} />
                    <span className="flex">
                      <IconButton label={shown.has(r.key) ? "Hide" : "Reveal"} size="sm" onClick={() => toggle(r.key)}>
                        {shown.has(r.key) ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </IconButton>
                      <IconButton label="Delete row" size="sm" onClick={() => setRows((list) => list && list.filter((x) => x.key !== r.key))}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </IconButton>
                    </span>
                  </div>
                ) : (
                  <div key={r.key} className="d-env-row">
                    <span className="d-env-key" title={r.name}>
                      {r.name}
                    </span>
                    <span className="d-env-val">
                      <span className={cx(!shown.has(r.key) && "is-masked")}>{shown.has(r.key) ? r.value || "(empty)" : "••••••••••"}</span>
                    </span>
                    <span className="flex">
                      <IconButton label={shown.has(r.key) ? "Hide" : "Reveal"} size="sm" onClick={() => toggle(r.key)}>
                        {shown.has(r.key) ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </IconButton>
                      <CopyButton text={r.value} label={`Copy ${r.name}`} />
                    </span>
                  </div>
                ),
              )}
              {edit && (
                <div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setRows((list) => [...(list ?? []), { name: "", value: "", key: nextKey, isNew: true }]);
                      setNextKey((k) => k + 1);
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" /> Add variable
                  </Button>
                </div>
              )}
              {edit && problems.length > 0 && (
                <Callout tone="sand" className="mt-3" title="Not quite yet">
                  {problems.join(" ")}
                </Callout>
              )}
            </div>
          )}
        </div>
      </div>
      {rows && !error && (
        <div className="o-dialog-foot">
          {!canEdit ? (
            <span className="o-hint mr-auto">Editing needs Portainer to be connected in Settings.</span>
          ) : edit ? (
            <>
              {changed && (
                <span className="o-unsaved mr-auto">
                  <i /> unsaved
                </span>
              )}
              <Button
                variant="ghost"
                onClick={() => {
                  setRows(orig.map((e, i) => ({ ...e, key: i })));
                  setEdit(false);
                  setShown(new Set());
                }}
              >
                Discard
              </Button>
              <Button variant="primary" disabled={!changed || problems.length > 0 || !!busy} onClick={() => setAsk(true)}>
                {busy ? <RefreshCw className="h-4 w-4 o-spin" /> : <Rocket className="h-4 w-4" />}
                Save & redeploy
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => setEdit(true)}>
              <Pencil className="h-4 w-4" /> Edit
            </Button>
          )}
        </div>
      )}
      {ask && (
        <Confirm
          icon={Rocket}
          copy={{
            title: "Save & redeploy?",
            description: `Portainer applies the ${rows?.length ?? 0} variables and replaces the containers of ${s.name}. The site is down for a few seconds.`,
            note: "If a variable the app needs is missing, it won’t start afterwards. The old values stay here until you save – when in doubt, discard.",
            confirmLabel: "Save & redeploy",
            tone: "accent",
          }}
          onClose={() => setAsk(false)}
          onConfirm={save}
        />
      )}
    </Overlay>
  );
}
