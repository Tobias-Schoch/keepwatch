import { AlertTriangle, CheckCircle2, X, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { autoDismissMs, useMessages, type Message } from "../messages";
import { cx } from "./ui";

/**
 * Feedback as glass capsules at the top center. Success runs down a thin
 * timeline and goes away by itself; warnings and errors stay until clicked.
 */
function Toast({ m, onDismiss }: { m: Message; onDismiss: (id: number) => void }) {
  const [leaving, setLeaving] = useState(false);
  const ms = autoDismissMs(m);
  const dismiss = () => {
    if (leaving) return;
    setLeaving(true);
    setTimeout(() => onDismiss(m.id), 220);
  };
  useEffect(() => {
    if (ms === null) return;
    const t = setTimeout(dismiss, ms);
    return () => clearTimeout(t);
  }, [ms, m.id]);
  const Icon = m.tone === "success" ? CheckCircle2 : m.tone === "warn" ? AlertTriangle : XCircle;
  return (
    <div className={cx("o-toast", leaving && "is-leaving", m.tone === "error" && "is-error")} data-tone={m.tone} role={m.tone === "success" ? "status" : "alert"}>
      <Icon className="o-toast-icon h-4 w-4" />
      <div className="min-w-0 flex-1">
        {m.title && <p className="o-toast-title">{m.title}</p>}
        <p className="o-toast-text">{m.text}</p>
      </div>
      <button type="button" className="o-toast-x" aria-label="Dismiss" onClick={dismiss}>
        <X className="h-3.5 w-3.5" />
      </button>
      {ms !== null && <i className="o-toast-time" style={{ animationDuration: `${ms}ms` }} />}
    </div>
  );
}

export function Toasts() {
  const { messages, dismiss } = useMessages();
  return createPortal(
    <div className="o-toasts" aria-live="polite">
      {messages.map((m) => (
        <Toast key={m.id} m={m} onDismiss={dismiss} />
      ))}
    </div>,
    document.body,
  );
}
