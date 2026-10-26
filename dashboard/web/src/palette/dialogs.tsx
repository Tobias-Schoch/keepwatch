import { DatabaseBackup, Unlock } from "lucide-react";
import { api, refreshAll } from "../api";
import { Confirm } from "../design/ui";
import { useAction } from "../messages";

/** Unban as on the Security page (same text, same endpoint). */
export function UnbanConfirm({ ip, jail, loggedIn, onClose, onDone }: { ip: string; jail: string; loggedIn?: boolean; onClose: () => void; onDone?: () => void }) {
  const { run } = useAction();
  return (
    <Confirm
      icon={Unlock}
      copy={{
        title: `Unban ${ip}?`,
        description: "The address can connect again right away. If it keeps failing, fail2ban bans it again.",
        note: loggedIn ? "This address recently logged in successfully – it’s probably you." : jail !== "sshd" ? `Banned in jail “${jail}”.` : undefined,
        confirmLabel: "Unban",
      }}
      onClose={onClose}
      onConfirm={() =>
        void run(ip, () => api.post("/api/security/unban", { jail, ip }), `${ip} is unbanned.`).then((ok) => {
          if (ok) {
            refreshAll();
            onDone?.();
          }
        })
      }
    />
  );
}

/** "Back up now" – a plain button on the Backups page; from the palette with a confirmation. */
export function BackupConfirm({ onClose, onStarted }: { onClose: () => void; onStarted: () => void }) {
  const { run } = useAction();
  return (
    <Confirm
      icon={DatabaseBackup}
      copy={{
        title: "Run a backup now?",
        description: "Runs the same backup as the nightly schedule (local and, if set up, off-site). It takes a few minutes; your services keep running.",
        confirmLabel: "Run backup",
        tone: "accent",
      }}
      onClose={onClose}
      onConfirm={() =>
        void run("run", () => api.post("/api/backups/run"), "Backup started.").then((ok) => {
          if (ok) {
            refreshAll();
            onStarted();
          }
        })
      }
    />
  );
}
