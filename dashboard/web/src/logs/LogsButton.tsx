import { ScrollText } from "lucide-react";
import { Button } from "../design/ui";
import { openLogs } from "./open";

/** "Logs" button in a service header: all containers of the service interleaved, live. */
export function LogsButton({ title, containers, className }: { title: string; containers: string[]; className?: string }) {
  if (!containers.length) return null;
  return (
    <Button size="sm" variant="ghost" className={className} onClick={() => openLogs({ title, containers })} title={`Live logs: ${containers.join(", ")}`}>
      <ScrollText className="h-3.5 w-3.5" /> Logs
    </Button>
  );
}
