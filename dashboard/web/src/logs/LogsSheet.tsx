import { ScrollText } from "lucide-react";
import { DialogHead, Overlay } from "../design/ui";
import { plural } from "../format";
import { LogView } from "./LogView";
import { closeLogs, useLogsTarget } from "./open";

/** The big log window; mounted once in App.tsx, opened via openLogs(). */
export function LogsHost() {
  const t = useLogsTarget();
  if (!t) return null;
  return (
    <Overlay key={`${t.title}#${t.containers.join("|")}`} onClose={closeLogs} label={`Logs ${t.title}`} size="xl" align="top" className="d-logs-sheet">
      <DialogHead icon={ScrollText} title={t.title} sub={t.containers.length > 1 ? `Logs · ${plural(t.containers.length, "container", "containers")} interleaved` : t.containers[0] === t.title ? "Logs" : `Logs · ${t.containers[0]}`} />
      <div className="o-dialog-body d-logs-body">
        <LogView containers={t.containers} title={t.title} />
      </div>
    </Overlay>
  );
}
