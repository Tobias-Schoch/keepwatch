import { ArrowUpRight, CheckCircle2, Lock, Unlock, Network, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, refreshAll } from "../api";
import { has } from "../config";
import { Button, Callout, Confirm, CopyButton, cx, KeyValue, Pill, type Tone } from "../design/ui";
import { dateTime, nowSec } from "../format";
import { useAction, useToast } from "../messages";
import type { Settings } from "../types";

export const LOGGED_OUT = new Set(["NeedsLogin", "NoState", "Stopped", null]);

/** Ticks every second while `on` (countdown). */
export function useNow(on: boolean) {
  const [now, setNow] = useState(nowSec());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(nowSec()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

export const mmss = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;

/* ---------- Tailscale ---------------------------------------------------------------------------- */

function TailscalePart({ ts, reload }: { ts: Settings["tailscale"]; reload: () => void }) {
  const { busy, run } = useAction();
  const toast = useToast();
  const [loginUrl, setLoginUrl] = useState<string | null>(ts.loginUrl);
  const [waiting, setWaiting] = useState(!!ts.loginUrl && ts.state !== "Running");
  const running = ts.state === "Running";

  // After the login, check every 3 s until the server reports "Running".
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, [waiting, reload]);
  useEffect(() => {
    if (waiting && running) {
      setWaiting(false);
      setLoginUrl(null);
      toast(`The server is in your tailnet: ${ts.dnsName ?? ts.ip ?? "logged in"}.`);
      refreshAll();
    }
  }, [waiting, running, ts.dnsName, ts.ip, toast]);

  if (!running) {
    const url = loginUrl ?? ts.loginUrl;
    return (
      <div className="flex flex-col gap-4">
        <p className="o-hint">Tailscale also needs to run on this computer.</p>
        {!ts.installed ? (
          <Callout tone="rose" title="Tailscale isn't installed on the server yet – run ./keepwatch deploy" />
        ) : url ? (
          <Callout
            tone="accent"
            icon={Network}
            title="Log the server in to your Tailscale account"
            action={
              <a className="o-btn o-btn-primary o-btn-sm" href={url} target="_blank" rel="noreferrer">
                Open login <ArrowUpRight className="h-3.5 w-3.5" />
              </a>
            }
          >
            <span className="inline-flex items-center gap-2">
              <RefreshCw className="h-3.5 w-3.5 o-spin" /> Waiting for the login …
            </span>
          </Callout>
        ) : null}
        <div>
          <Button
            variant="primary"
            disabled={!ts.installed || !!busy || waiting}
            onClick={() =>
              void run("login", async () => {
                const r = await api.post<{ loginUrl: string }>("/api/settings/tailscale/login");
                setLoginUrl(r.loginUrl);
                setWaiting(true);
              })
            }
          >
            {busy === "login" ? <RefreshCw className="h-4 w-4 o-spin" /> : <Network className="h-4 w-4" />}
            {waiting ? "Logging in …" : "Log in to Tailscale"}
          </Button>
        </div>
      </div>
    );
  }

  const daysLeft = ts.keyExpiry ? Math.floor((ts.keyExpiry - nowSec()) / 86400) : null;
  return (
    <div className="flex flex-col gap-4">
      {ts.urls.length > 0 ? (
        <Callout tone="sand" title="Still shared in the tailnet">
          {ts.urls.map((u) => u.name).join(", ")} – every device in the tailnet can reach it without an SSH key. <span className="d-mono">./keepwatch deploy</span> removes
          these shares.
        </Callout>
      ) : (
        <p className="o-hint">
          Admin UIs are only reachable through the SSH tunnel (<span className="d-mono">./keepwatch tunnel</span> or the macOS app) – you need Tailscale and your SSH key.
        </p>
      )}
      <KeyValue
        items={[
          [
            "Name",
            <span className="inline-flex items-center gap-1">
              <span className="d-mono">{ts.dnsName ?? "—"}</span>
              {ts.dnsName && <CopyButton text={ts.dnsName} label="Copy name" />}
            </span>,
          ],
          [
            "Tailnet IP",
            <span className="inline-flex items-center gap-1">
              <span className="d-mono">{ts.ip ?? "—"}</span>
              {ts.ip && <CopyButton text={ts.ip} label="Copy IP" />}
            </span>,
          ],
          [
            "Key",
            ts.keyExpiry ? (
              <span className={cx(daysLeft !== null && daysLeft < 30 ? "text-[var(--o-rose)]" : "text-[var(--o-sand)]")}>
                valid until {dateTime(ts.keyExpiry)} · {daysLeft} days left
              </span>
            ) : (
              <Pill tone="ok">never expires</Pill>
            ),
          ],
        ]}
      />
      {ts.keyExpiry && (
        <Callout tone={daysLeft !== null && daysLeft < 30 ? "rose" : "sand"} title={`The key expires on ${dateTime(ts.keyExpiry)}.`}>
          Turn on "Disable key expiry" for this machine in the Tailscale admin console.
        </Callout>
      )}
    </div>
  );
}

/* ---------- SSH from the internet ------------------------------------------------------------------ */

function SshPart({ ts, ssh, reload }: { ts: Settings["tailscale"]; ssh: Settings["ssh"]; reload: () => void }) {
  const { busy, run } = useAction();
  const [ask, setAsk] = useState<"close" | "open" | null>(null);
  const now = useNow(!!ssh.revertAt);
  const left = ssh.revertAt ? ssh.revertAt - now : null;
  const host = ts.dnsName ?? ts.ip ?? "<server>";
  const cmd = `ssh root@${host}`;
  const canClose = ts.state === "Running" && ts.viaTailscale;
  const why = ts.state !== "Running" ? "Log the server in to Tailscale first." : !ts.viaTailscale ? "Open the dashboard through a tunnel over Tailscale first, so you can't lock yourself out." : null;

  // Deadline passed: reload (the server has reopened port 22).
  const fired = useRef(false);
  useEffect(() => {
    if (left !== null && left <= 0 && !fired.current) {
      fired.current = true;
      reload();
    }
    if (left === null || left > 0) fired.current = false;
  }, [left, reload]);

  const setPublic = (v: boolean, msg: string) =>
    void run(v ? "open" : "close", () => api.put("/api/settings/ssh", { public: v }), msg).then((ok) => {
      if (ok) {
        reload();
        refreshAll();
      }
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Pill tone={ssh.public ? "sand" : "ok"} dot>
          {ssh.public ? "Port 22 open" : "Port 22 closed"}
        </Pill>
        {ssh.revertAt && <Pill tone="accent">on trial</Pill>}
      </div>
      {!ssh.public && !ssh.revertAt && (
        <div className="d-secret">
          <span className="d-mono">{cmd}</span>
          <CopyButton text={cmd} label="Copy SSH command" />
        </div>
      )}

      {ssh.revertAt && left !== null ? (
        <div className="flex flex-col gap-4 rounded-[16px] bg-[rgb(var(--o-acc)/0.06)] p-4 shadow-[inset_0_0_0_1px_rgb(var(--o-acc)/0.25)]">
          <div>
            <div className="o-micro">Port 22 reopens in</div>
            <div className="o-tile-value o-num mt-2">{mmss(left)}</div>
          </div>
          <div>
            <div className="o-hint mb-1.5">Test it now from your computer:</div>
            <div className="d-secret">
              <span className="d-mono">{cmd}</span>
              <CopyButton text={cmd} label="Copy command" />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={!!busy} onClick={() => void run("confirm", () => api.post("/api/settings/ssh/confirm"), "Port 22 stays closed.").then((ok) => ok && reload())}>
              <CheckCircle2 className="h-4 w-4" /> It works – keep closed
            </Button>
            <Button variant="ghost" disabled={!!busy} onClick={() => setPublic(true, "Port 22 is open again.")}>
              <Unlock className="h-4 w-4" /> Reopen
            </Button>
          </div>
        </div>
      ) : ssh.public ? (
        <div className="flex flex-col gap-2">
          <div>
            <Button variant="danger" disabled={!canClose || !!busy} onClick={() => setAsk("close")}>
              <Lock className="h-4 w-4" /> Close port 22
            </Button>
          </div>
          {why && <p className="o-hint">{why}</p>}
        </div>
      ) : (
        <div>
          <Button variant="secondary" disabled={!!busy} onClick={() => setAsk("open")}>
            <Unlock className="h-4 w-4" /> Reopen port 22
          </Button>
        </div>
      )}

      {ask === "close" && (
        <Confirm
          icon={Lock}
          copy={{
            title: "Close port 22 to the internet?",
            description: (
              <>
                You then have 10 minutes to check that <span className="d-mono">{cmd}</span> works and confirm. Without confirmation the server reopens port 22 by itself.
              </>
            ),
            confirmLabel: "Close port",
            tone: "danger",
          }}
          onClose={() => setAsk(null)}
          onConfirm={() => setPublic(false, "Port 22 is closed – test it now, then confirm.")}
        />
      )}
      {ask === "open" && (
        <Confirm
          icon={Unlock}
          copy={{
            title: "Reopen port 22?",
            description: "SSH will be reachable from the whole internet again. Logins still need a key, and fail2ban bans the bots.",
            confirmLabel: "Reopen",
            tone: "accent",
          }}
          onClose={() => setAsk(null)}
          onConfirm={() => setPublic(true, "Port 22 is open again.")}
        />
      )}
    </div>
  );
}

/* ---------- Settings: row and dialog ------------------------------------------------------------ */

export function tailscaleState(ts: Settings["tailscale"]): { tone: Tone; label: string } {
  if (!ts.installed) return { tone: "rose", label: "not installed" };
  if (ts.state === "Running") return { tone: "ok", label: "connected" };
  if (ts.state === "Starting") return { tone: "accent", label: "starting …" };
  if (LOGGED_OUT.has(ts.state)) return { tone: "sand", label: "logged out" };
  return { tone: "neutral", label: String(ts.state) };
}

/** "Port 22 reopens in m:ss" for the row (only during the trial). */
export function SshCountdown({ at }: { at: number }) {
  const now = useNow(true);
  return <Pill tone="accent">Port 22 reopens in {mmss(at - now)}</Pill>;
}

/** Body of the "Remote access" dialog: Tailscale on top, port 22 below. */
export function RemoteAccessBody({ s, reload }: { s: Settings; reload: () => void }) {
  // Closing port 22 needs the firewall and Tailscale modules; otherwise the backend sends {enabled: false}.
  const sshToggle = sshAvailable(s);
  return (
    <div className="flex flex-col gap-6">
      <TailscalePart ts={s.tailscale} reload={reload} />
      {sshToggle && (
        <div className="d-set-sub">
          <h3 className="d-set-subhead">SSH from the internet</h3>
          <SshPart ts={s.tailscale} ssh={s.ssh} reload={reload} />
        </div>
      )}
    </div>
  );
}

/** Can port 22 be closed from the dashboard (firewall + tailscale modules, reported by the server)? */
export const sshAvailable = (s: Settings) => has("tailscale") && has("firewall") && !!s.ssh && (s.ssh as { enabled?: boolean }).enabled !== false;
