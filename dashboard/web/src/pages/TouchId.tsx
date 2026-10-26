import { Fingerprint, Laptop, Plus, RefreshCw, Smartphone, Trash2 } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { api, refreshAll, usePoll } from "../api";
import { Button, Callout, Confirm, CopyButton, Field, IconButton, Overlay, Pill } from "../design/ui";
import { ago, dateTime } from "../format";
import { useAction, useToast } from "../messages";
import { appBridge, createCredential, defaultDeviceName, inApp, touchPrompt, type RegisterOptions, type TouchDevice, type TouchStatus } from "../touchid";
import { DBody, DFoot } from "./settingsUi";
import "./touchid.css";

/* Settings → Passkey: devices that may confirm dangerous actions (server/touchid.py). */

/** `enabled` false (no passkey on this server): nothing is fetched. */
export function useTouchStatus(enabled = true) {
  return usePoll<TouchStatus>(enabled ? "/api/touchid" : null, 60 * 60_000);
}

/** Create a key on this device and register it (exactly one device: only while none is registered). */
async function register(name: string) {
  const o = await api.post<RegisterOptions>("/api/touchid/register/start", { name });
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
  const [remove, setRemove] = useState<TouchDevice | null>(null);
  const done = () => {
    reload();
    refreshAll();
  };
  const app = !!appBridge();
  const blocked = !st.crypto || !st.rpUsable;

  const setup = () =>
    void run("add", () => register(name.trim() || defaultDeviceName()), "Passkey is on. Dangerous actions now need your confirmation.").then((ok) => {
      if (ok) done();
    });

  const addSection = (
    <div className="d-set-sub">
      <h3 className="d-set-subhead">Set up this device</h3>
      <div className="flex flex-col gap-3">
        <Field label="Name" htmlFor="tid-name" hint={app ? "Key in this Mac's Secure Enclave, Touch ID only." : "Passkey with Touch ID, Face ID or Windows Hello."}>
          <input id="tid-name" className="o-input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <div>
          <Button variant="primary" disabled={!!busy || !name.trim()} onClick={setup}>
            {busy === "add" ? <RefreshCw className="h-4 w-4 o-spin" /> : <Plus className="h-4 w-4" />}
            {busy === "add" ? "Waiting for passkey…" : "Set up"}
          </Button>
        </div>
      </div>
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
              Until then everything works without confirmation. One device can be set up – Touch ID in the macOS app, or a passkey in your browser
              (Touch ID, Windows Hello or a security key).
            </Callout>
          ) : !st.here ? (
            <Callout tone="sand" title={`No device is set up for ${st.rpId}`}>
              Dangerous actions don't work here. Open the dashboard at the address where your device is set up (the macOS app uses localhost). To switch: run
              <span className="d-mono"> keepwatch-passkey reset</span> on the server over SSH, then set it up again here.
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
                  <IconButton label={st.devices.length <= 1 ? "The only device – switch over SSH (keepwatch-passkey reset)" : `Remove ${d.name}`} size="sm" onClick={() => setRemove(d)} disabled={!!busy || st.devices.length <= 1}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}

          {!st.active && !blocked && addSection}

          <div className="d-set-sub">
            <h3 className="d-set-subhead">Needs a passkey</h3>
            <ul className="d-tid-protects">
              {st.protects.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <p className="o-hint mt-3">No passkey needed: checks and scans, backing up now, acknowledging, renewing certificates, closing port 22, longer retention.</p>
            <p className="o-hint mt-3 flex items-center gap-2">
              <span>
                New device or lost one? On the server over SSH: <span className="d-mono">keepwatch-passkey reset</span>
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
            note: st.devices.length === 1 ? "It's the last device: the passkey check turns off and everything works without confirmation again." : undefined,
            confirmLabel: "Remove",
            tone: "danger",
          }}
          onClose={() => setRemove(null)}
          onConfirm={() =>
            void run("remove", () => api.del(`/api/touchid/devices/${encodeURIComponent(remove.id)}`)).then((ok) => {
              if (!ok) return;
              toast(st.devices.length === 1 ? "Device removed – passkey check is off." : `Removed ${remove.name}.`);
              done();
            })
          }
        />
      )}
    </>
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
