import { Fingerprint, KeyRound, Laptop, Plus, RefreshCw, Smartphone, Trash2 } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { api, refreshAll, usePoll } from "../api";
import { has } from "../config";
import { Button, Callout, Confirm, CopyButton, Field, IconButton, Overlay, Pill } from "../design/ui";
import { ago, clock, dateTime } from "../format";
import { useAction, useToast } from "../messages";
import { appBridge, createCredential, defaultDeviceName, inApp, touchPrompt, type RegisterOptions, type TouchDevice, type TouchStatus } from "../touchid";
import { DBody, DFoot } from "./settingsUi";
import "./touchid.css";

/** What makes things safer needs no passkey – only what exists with the installed modules is named. */
function freeActions(): string[] {
  return [
    "checks and scans",
    has("backup") && "backing up now",
    "acknowledging",
    has("proxy") && "renewing certificates",
    has("firewall") && has("tailscale") && "closing port 22",
    "longer retention",
  ].filter((x): x is string => !!x);
}

/* Settings → Passkey: devices that may confirm dangerous actions (server/touchid.py). */

/** `enabled` false (no passkey on this server): nothing is fetched. */
export function useTouchStatus(enabled = true) {
  return usePoll<TouchStatus>(enabled ? "/api/touchid" : null, 60 * 60_000);
}

/**
 * Create a key on this device and register it. The first device needs nothing; every further one either a pairing
 * code (from a registered device) or – without a code – a passkey confirmation of a registered device (428).
 */
async function register(name: string, pairCode?: string) {
  const o = await api.post<RegisterOptions>("/api/touchid/register/start", pairCode ? { name, pairCode } : { name });
  const r = await createCredential(o, name);
  await api.post("/api/touchid/register/finish", { ...r, name });
}

const KIND: Record<TouchDevice["kind"], string> = { passkey: "Passkey", app: "macOS app · Secure Enclave" };

function DeviceIcon({ d }: { d: TouchDevice }) {
  const Icon = d.kind === "app" ? Laptop : /iphone|ipad|android/i.test(d.name) ? Smartphone : Fingerprint;
  return <Icon className="d-tid-icon" strokeWidth={1.8} aria-hidden />;
}

export function TouchIdBody({ st, reload, close }: { st: TouchStatus; reload: () => void; close: () => void }) {
  const { busy, run } = useAction();
  const toast = useToast();
  const [name, setName] = useState(defaultDeviceName);
  const [code, setCode] = useState("");
  const [pair, setPair] = useState<PairCode | null>(null);
  const [remove, setRemove] = useState<TouchDevice | null>(null);
  // The code is gone on the server (used, dropped after wrong attempts, replaced): stop showing it.
  const pending = st.pairing?.expires ?? null;
  useEffect(() => {
    if (pending === null) setPair(null);
  }, [pending]);
  const done = () => {
    reload();
    refreshAll();
  };
  const app = !!appBridge();
  const blocked = !st.crypto || !st.rpUsable;
  const digits = code.replace(/\D/g, "");
  const codeOk = /^\d{6}$/.test(digits);
  // Without a device for this address, a further device can only come in with a pairing code.
  const needCode = st.active && !st.here;

  const setup = () => {
    const n = name.trim() || defaultDeviceName();
    void run("add", () => register(n, codeOk ? digits : undefined), st.active ? `Added "${n}".` : "Passkey is on. Dangerous actions now need your confirmation.").then((ok) => {
      if (!ok) return;
      setCode("");
      done();
    });
  };

  const addSection = (
    <div className="d-set-sub">
      <h3 className="d-set-subhead">{!st.active ? "Set up this device" : st.here ? "Add another key here" : "Add this device"}</h3>
      <div className="flex flex-col gap-3">
        <Field label="Name" htmlFor="tid-name" hint={app ? "Key in this Mac's Secure Enclave, Touch ID only." : "Passkey with Touch ID, Face ID or Windows Hello."}>
          <input id="tid-name" className="o-input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        {st.active && (
          <Field
            label="Pairing code"
            htmlFor="tid-code"
            aside={needCode ? undefined : "optional"}
            hint={
              needCode
                ? "Create it on a registered device: Settings → Passkey → Pair another device."
                : "From a registered device. Without a code, a registered passkey on this device confirms first."
            }
          >
            <input
              id="tid-code"
              className="o-input d-mono d-tid-code-in"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, "").slice(0, 7))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123 456"
            />
          </Field>
        )}
        <div>
          <Button variant={st.active ? "secondary" : "primary"} disabled={!!busy || !name.trim() || (code.trim() !== "" && !codeOk) || (needCode && !codeOk)} onClick={setup}>
            {busy === "add" ? <RefreshCw className="h-4 w-4 o-spin" /> : <Plus className="h-4 w-4" />}
            {busy === "add" ? "Waiting for passkey…" : !st.active ? "Set up" : codeOk ? "Add with code" : "Add"}
          </Button>
        </div>
      </div>
    </div>
  );

  const pairSection = (
    <div className="d-set-sub">
      <h3 className="d-set-subhead">Pair another device</h3>
      {pair && pair.expires * 1000 > Date.now() ? (
        <PairCodeView pair={pair} onGone={() => setPair(null)} />
      ) : (
        <div className="flex flex-col gap-3">
          <p className="o-hint">For a device that has no key yet – the macOS app, another browser or computer. The code is valid for 5 minutes and works once.</p>
          <div>
            <Button
              variant="secondary"
              disabled={!!busy}
              onClick={() =>
                void run("pair", async () => {
                  setPair(await api.post<PairCode>("/api/touchid/pair"));
                  reload();
                })
              }
            >
              <KeyRound className="h-4 w-4" /> {busy === "pair" ? "Waiting for passkey…" : "Create pairing code"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <>
      <DBody>
        <div className="flex flex-col gap-5">
          {!st.crypto ? (
            <Callout tone="rose" title="python3-cryptography is missing on the server">
              Without it the server can't verify signatures. Run <span className="d-mono">./keepwatch deploy</span> once.
            </Callout>
          ) : !st.active ? (
            <Callout tone="sand" title="Off – no device set up yet">
              Until then everything works without confirmation, and the first device needs none either – so set it up right away: Touch ID in the macOS
              app, or a passkey in your browser (Touch ID, Windows Hello or a security key). Every further device needs a passkey or a pairing code.
            </Callout>
          ) : !st.here ? (
            <Callout tone="sand" title={`No device is set up for ${st.rpId}`}>
              Dangerous actions don't work here. Open the dashboard at the address where your device is set up (the macOS app uses localhost), or add
              this device below with a pairing code from a registered one.
            </Callout>
          ) : (
            <Callout tone="ok" icon={Fingerprint} title="On">
              Dangerous actions need a passkey from one of these devices. There is no password fallback.
            </Callout>
          )}
          {!st.rpUsable && (
            <Callout tone="sand" title="This address doesn't work">
              Passkeys need a host name, not an IP. Open the dashboard via http://localhost:… instead of 127.0.0.1, or in the macOS app.
            </Callout>
          )}
          {inApp() && !app && (
            <Callout tone="sand" title="This version of the macOS app can't use Touch ID yet">
              It comes with the next app update. Until then, set up the passkey in your browser and confirm there.
            </Callout>
          )}

          {st.devices.length > 0 && (
            <ul className="d-tid-list">
              {st.devices.map((d) => (
                <li key={d.id} className="d-tid-row">
                  <DeviceIcon d={d} />
                  <div className="min-w-0">
                    <div className="d-tid-name">
                      {d.name}
                      {d.here && st.devices.filter((x) => x.here).length < st.devices.length && <Pill tone="neutral">this address</Pill>}
                    </div>
                    <div className="d-tid-meta">
                      {KIND[d.kind]} · {d.lastUsed ? `last used ${ago(d.lastUsed)}` : "never used"} · added {dateTime(d.created)}
                      {!d.here && <> · {d.rpId}</>}
                    </div>
                  </div>
                  <IconButton label={st.devices.length <= 1 ? "The last device – add another one first" : `Remove ${d.name}`} size="sm" onClick={() => setRemove(d)} disabled={!!busy || st.devices.length <= 1}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}

          {st.active && st.here && pairSection}
          {!blocked && addSection}

          <div className="d-set-sub">
            <h3 className="d-set-subhead">Needs a passkey</h3>
            <ul className="d-tid-protects">
              {st.protects.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <p className="o-hint mt-3">No passkey needed: {freeActions().join(", ")}.</p>
            <p className="o-hint mt-3 flex items-center gap-2">
              <span>
                Lost all devices? On the server over SSH: <span className="d-mono">keepwatch-passkey reset</span>
              </span>
              <CopyButton text="keepwatch-passkey reset" label="Copy command" />
            </p>
          </div>
        </div>
      </DBody>
      <DFoot>
        <Button variant="ghost" onClick={close}>
          Close
        </Button>
      </DFoot>
      {remove && (
        <Confirm
          icon={Trash2}
          copy={{
            title: `Remove ${remove.name}?`,
            description: "This device can no longer confirm dangerous actions.",
            note: remove.here && st.devices.filter((d) => d.here).length === 1 ? "It's the last device for this address: dangerous actions won't work here any more." : undefined,
            confirmLabel: "Remove",
            tone: "danger",
          }}
          onClose={() => setRemove(null)}
          onConfirm={() =>
            void run("remove", () => api.del(`/api/touchid/devices/${encodeURIComponent(remove.id)}`)).then((ok) => {
              if (!ok) return;
              toast(`Removed ${remove.name}.`);
              done();
            })
          }
        />
      )}
    </>
  );
}

interface PairCode {
  code: string;
  expires: number;
}

/** The pairing code, large, with a countdown; gone when it expires. */
function PairCodeView({ pair, onGone }: { pair: PairCode; onGone: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      if (pair.expires * 1000 <= Date.now()) onGone();
      else tick((n) => n + 1);
    }, 1000);
    return () => clearInterval(t);
  }, [pair, onGone]);
  const left = Math.max(0, Math.round(pair.expires - Date.now() / 1000));
  return (
    <div className="d-tid-pair">
      <span className="d-tid-pair-code d-mono" aria-label={`Pairing code ${pair.code.split("").join(" ")}`}>
        {pair.code.slice(0, 3)} {pair.code.slice(3)}
      </span>
      <span className="o-hint">
        On the new device: Settings → Passkey → Pairing code. Valid until {clock(pair.expires)} ({Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} left), once.
      </span>
    </div>
  );
}

/** Value of the row in the settings list. */
export function touchRowValue(st: TouchStatus | null, error: string | null) {
  if (!st) return error ? "unavailable" : "…";
  if (!st.active) return "off – no confirmation needed";
  const n = st.devices.length;
  return (
    <>
      on · <b>{n}</b> {n === 1 ? "device" : "devices"}
    </>
  );
}

export function touchRowState(st: TouchStatus | null) {
  if (!st) return null;
  if (!st.crypto && st.active) return <Pill tone="rose" dot>server package missing</Pill>;
  if (!st.active)
    return (
      <Pill tone="sand" dot>
        off
      </Pill>
    );
  return st.here ? null : <Pill tone="sand">not for this address</Pill>;
}

/* ---------- Button for Safari: WebAuthn needs a click ----------------------------------- */

export function TouchIdPrompt() {
  const p = useSyncExternalStore(touchPrompt.subscribe, touchPrompt.get);
  if (!p) return null;
  return (
    <Overlay onClose={() => p.cancel()} label={p.title} size="sm" className="o-confirm">
      <div className="o-confirm-body">
        <span className="o-confirm-icon" data-tone="accent">
          <Fingerprint className="h-5 w-5" />
        </span>
        <h2 className="o-confirm-title">{p.title}</h2>
        <p className="o-confirm-text">{p.text}</p>
      </div>
      <div className="o-confirm-foot">
        <Button variant="ghost" onClick={() => p.cancel()}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => p.go()} data-autofocus>
          <Fingerprint className="h-4 w-4" /> Confirm with passkey
        </Button>
      </div>
    </Overlay>
  );
}
