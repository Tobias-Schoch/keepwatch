import { Archive, Download } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Button, cx } from "../design/ui";
import { nowSec, num, plural } from "../format";
import { download, fileSlug, isoLocal, type LevelFilter } from "../logs/api";
import { openLogs } from "../logs/open";
import { archivePath, isArchiveWindow, shortDay, useArchiveOverview, type ArchiveLinesResponse } from "./api";
import "./logarchive.css";

type ArchiveRangeId = "604800" | "1209600";

/**
 * Bar in the live logs (logs/LogView.tsx), below the search:
 * - Containers that no longer exist: switches to "14 days" by itself (only the archive knows them).
 * - Other containers of the same service that no longer exist: buttons to open them.
 * - In an archive range (7/14 days): source, retention and – beyond the loaded lines –
 *   "search / download the whole range" (the server searches every day).
 * Shows nothing when there's nothing to say. Only rendered with the log-archive module.
 */
export function ArchiveNote({
  containers,
  title,
  windowSec,
  level,
  q,
  onRange,
}: {
  containers: string[];
  title: string;
  windowSec: number;
  level: LevelFilter;
  q: string;
  onRange: (id: ArchiveRangeId) => void;
}) {
  const ov = useArchiveOverview().data;
  const archive = isArchiveWindow(windowSec);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const mine = useMemo(() => (ov ? ov.containers.filter((c) => containers.includes(c.name)) : []), [ov, containers]);
  const gone = mine.filter((c) => c.exists === false).map((c) => c.name);
  const allGone = mine.length > 0 && containers.every((n) => gone.includes(n));
  const related = useMemo(() => {
    if (!ov) return [];
    const stacks = new Set(mine.map((c) => c.stack));
    return ov.containers.filter((c) => stacks.has(c.stack) && c.exists === false && !containers.includes(c.name) && c.stack !== "no-stack");
  }, [ov, mine, containers]);

  // If none of the containers exist anymore, `docker logs` has nothing – go straight to the archive.
  const switched = useRef(false);
  useEffect(() => {
    if (allGone && !archive && !switched.current) {
      switched.current = true;
      onRange("1209600");
    }
  }, [allGone, archive, onRange]);

  useEffect(() => setMsg(null), [q, windowSec, level]);

  const fetchAll = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.get<ArchiveLinesResponse>(archivePath(containers, null, windowSec, level, { q, limit: 50000, download: true }));
      const multi = containers.length > 1;
      const text = r.lines
        .map((l) => (l.sep ? `${isoLocal(l.t)} ${multi ? `[${l.c}] ` : ""}----- ${l.text} -----` : `${isoLocal(l.t)} ${multi ? `[${l.c}] ` : ""}${l.stream === "stderr" ? "! " : ""}${l.text}`))
        .join("\n");
      const n = r.lines.filter((l) => !l.sep).length;
      if (!n) {
        setMsg(q ? `No line in the whole range contains “${q}”.` : "The archive has nothing for this range.");
        return;
      }
      const stamp = isoLocal(nowSec()).slice(0, 10).replace(/-/g, "");
      download(`${fileSlug(title)}-archive-${Math.round(windowSec / 86400)}d${q ? `-${fileSlug(q)}` : ""}-${stamp}.log`, `${text}\n`);
      const cut = r.truncated.length || r.dropped || Object.keys(r.errors).length;
      setMsg(`${plural(n, "line", "lines")} saved${cut ? " – not everything: hit the limit per request" : ""}.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!archive && !related.length && !gone.length) return null;

  return (
    <div className={cx("d-la-note", archive && "is-archive")}>
      {archive && (
        <span className="d-la-src">
          <Archive className="h-3.5 w-3.5" aria-hidden />
          From the log archive{ov ? ` · kept ${ov.settings.days} days` : ""}
          {ov && !ov.running && <span className="o-text-rose"> · {ov.installed ? "not writing right now" : "not deployed yet"}</span>}
          {mine.length > 0 && <span className="d-la-dim"> · since {shortDay(mine.map((c) => c.from).sort()[0])}</span>}
        </span>
      )}
      {gone.length > 0 && (
        <span className="d-la-gone">
          {gone.length === containers.length ? (containers.length === 1 ? "This container no longer exists" : "These containers no longer exist") : `Gone: ${gone.join(", ")}`} – archive only.
        </span>
      )}
      {related.length > 0 && (
        <span className="d-la-related">
          <span className="d-la-dim">Also in the archive, now removed:</span>
          {related.map((c) => (
            <button key={c.key} type="button" className="o-chip" onClick={() => openLogs({ title: c.name, containers: [c.name] })} title={`${c.key} · ${shortDay(c.from)}–${shortDay(c.to)}`}>
              {c.name}
            </button>
          ))}
        </span>
      )}
      <span className="flex-1" />
      {archive && (
        <Button size="sm" variant="ghost" onClick={() => void fetchAll()} disabled={busy} title="The server reads every day of the range (up to 50,000 lines per container)">
          <Download className="h-3.5 w-3.5" />
          {busy ? "Reading the archive …" : q ? `“${q.length > 24 ? `${q.slice(0, 24)}…` : q}” in all ${num(Math.round(windowSec / 86400))} days` : `All ${num(Math.round(windowSec / 86400))} days`}
        </Button>
      )}
      {msg && <span className="d-la-msg">{msg}</span>}
    </div>
  );
}
