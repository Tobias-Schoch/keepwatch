import { PlugZap, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Button, Callout, Confirm, Field, Pill } from "../design/ui";
import { has } from "../config";
import { ago } from "../format";
import type { NpmStatus } from "../hosts";
import { useAction, useToast } from "../messages";
import { DBody, DFoot } from "./settingsUi";

/**
 * Settings → "Proxy Manager login": email and password of a Nginx Proxy Manager user.
 * The backend stores them on the server (mode 600) and never returns the password.
 * Needed by the "New site" wizard. Module proxy – nothing is fetched without it.
 */
export function useNpmStatus() {
  const [st, setSt] = useState<NpmStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!has("proxy")) return;
    try {
      setSt(await api.get<NpmStatus>("/api/settings/npm"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { st, error, load };
}

/** Dialog content; `close` closes it after saving. */
export function NpmBody({ st, error, load, close }: { st: NpmStatus | null; error: string | null; load: () => Promise<void>; close: () => void }) {
  const [edit, setEdit] = useState(!st?.configured);
  const [email, setEmail] = useState(st?.email ?? "");
  const [password, setPassword] = useState("");
  const [askRemove, setAskRemove] = useState(false);
  const { busy, run } = useAction();
  const toast = useToast();

  const save = () =>
    void run("save", async () => {
      const r = await api.put<{ ok: true; message: string }>("/api/settings/npm", { email: email.trim(), password });
      toast(r.message);
      setPassword("");
      await load();
      close();
    });

  const test = () =>
    void run("test", async () => {
      const r = await api.post<{ ok: true; message: string }>("/api/settings/npm/test");
      toast(r.message);
      await load();
    }).then((ok) => !ok && void load());

  const connected = !!st?.connected;
  const sameEmail = !!st?.configured && email.trim().toLowerCase() === (st.email ?? "").toLowerCase();

  return (
    <>
      <DBody>
          {error ? (
            <Callout tone="rose" title="Couldn't load the status">
              {error}
            </Callout>
          ) : !st ? (
            <p className="o-hint">Loading…</p>
          ) : edit ? (
            <div className="flex flex-col gap-4">
              {st.configured && !connected && st.reason && (
                <Callout tone="sand" title="The saved login doesn't work">
                  {st.reason}
                </Callout>
              )}
              <Field label="Email" htmlFor="s-npm-mail">
                <input id="s-npm-mail" className="o-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@example.com" autoComplete="off" spellCheck={false} data-autofocus />
              </Field>
              <Field label="Password" htmlFor="s-npm-pw" hint="Admin role, without two-factor auth.">
                <input
                  id="s-npm-pw"
                  className="o-input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={sameEmail ? "••••••••  (saved)" : ""}
                  autoComplete="new-password"
                  onKeyDown={(e) => e.key === "Enter" && email.trim() && (password || sameEmail) && save()}
                />
              </Field>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="d-summary">
                <Pill tone={connected ? "ok" : "rose"} dot>
                  {connected ? "connected" : "rejected"}
                </Pill>{" "}
                as <b>{st.email}</b>
                {st.checkedAt && <span className="o-mute"> · checked {ago(st.checkedAt)}</span>}
              </p>
              {!connected && st.reason && (
                <Callout tone="rose" title="The Proxy Manager rejects the login">
                  {st.reason}
                </Callout>
              )}
            </div>
          )}
      </DBody>
      <DFoot>
        {edit ? (
          <>
            {st?.configured && (
              <Button variant="ghost" onClick={() => (setEdit(false), setPassword(""), setEmail(st.email ?? ""))} disabled={!!busy}>
                Cancel
              </Button>
            )}
            <Button variant="primary" disabled={!email.trim() || (!password && !sameEmail) || !!busy} onClick={save}>
              {busy === "save" && <RefreshCw className="h-4 w-4 o-spin" />}
              {busy === "save" ? "Checking…" : "Save & check"}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" className="mr-auto" onClick={() => setAskRemove(true)} disabled={!!busy}>
              <Trash2 className="h-4 w-4" /> Remove
            </Button>
            <Button variant="secondary" onClick={() => setEdit(true)} disabled={!!busy}>
              Change login
            </Button>
            <Button variant="primary" onClick={test} disabled={!!busy}>
              {busy === "test" ? <RefreshCw className="h-4 w-4 o-spin" /> : <PlugZap className="h-4 w-4" />}
              {busy === "test" ? "Checking…" : "Test connection"}
            </Button>
          </>
        )}
      </DFoot>
      {askRemove && (
        <Confirm
          icon={Trash2}
          copy={{
            title: "Remove the Proxy Manager login?",
            description: "The \"New site\" wizard can no longer create anything. Nothing changes in the Proxy Manager itself.",
            confirmLabel: "Remove",
            tone: "danger",
          }}
          onClose={() => setAskRemove(false)}
          onConfirm={() =>
            void run("remove", () => api.del("/api/settings/npm"), "Login removed.").then(() => {
              setEmail("");
              setEdit(true);
              void load();
            })
          }
        />
      )}
    </>
  );
}
