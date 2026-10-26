import { ChevronRight, RefreshCw, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button, DialogHead, Overlay, useCloseOverlay } from "../design/ui";
import "./settings.css";

/* Building blocks of the settings: a row at rest, a dialog for editing. */

/** One setting: name, current value on one line, a state only when something needs attention. Click opens the dialog. */
export function SettingRow({ icon: Icon, title, hint, value, state, onOpen, id }: { icon: LucideIcon; title: string; hint?: string; value: ReactNode; state?: ReactNode; onOpen: () => void; id?: string }) {
  return (
    <button type="button" id={id} className="d-set-row" onClick={onOpen} title={hint}>
      <Icon className="d-set-icon" strokeWidth={1.8} aria-hidden />
      <span className="d-set-name">{title}</span>
      <span className="d-set-val">{value}</span>
      <span className="d-set-state">{state}</span>
      <ChevronRight className="d-set-chev" aria-hidden />
    </button>
  );
}

/** Dialog frame; the content gets `close` (closes with a fade-out). */
export function SettingDialog({ icon, title, sub, size = "md", onClose, children }: { icon: LucideIcon; title: string; sub?: ReactNode; size?: "sm" | "md" | "lg"; onClose: () => void; children: (close: () => void) => ReactNode }) {
  return (
    <Overlay onClose={onClose} label={title} size={size} align="top" className="d-set-dialog">
      <DialogHead icon={icon} title={title} sub={sub} />
      <Inner>{children}</Inner>
    </Overlay>
  );
}

function Inner({ children }: { children: (close: () => void) => ReactNode }) {
  const close = useCloseOverlay();
  return <>{children(() => close())}</>;
}

export function DBody({ children }: { children: ReactNode }) {
  return (
    <div className="o-dialog-scroll">
      <div className="o-dialog-body">{children}</div>
    </div>
  );
}

export function DFoot({ children }: { children: ReactNode }) {
  return <div className="o-dialog-foot">{children}</div>;
}

/** Save + Cancel in a dialog footer. */
export function SaveFoot({ dirty, valid, busy, onSave, onCancel, label = "Save" }: { dirty: boolean; valid: boolean; busy: boolean; onSave: () => void; onCancel: () => void; label?: string }) {
  return (
    <DFoot>
      {dirty && (
        <span className="o-unsaved mr-auto">
          <i /> unsaved
        </span>
      )}
      <Button variant="ghost" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
      <Button variant="primary" disabled={!dirty || !valid || busy} onClick={onSave}>
        {busy && <RefreshCw className="h-4 w-4 o-spin" />}
        {busy ? "Saving …" : label}
      </Button>
    </DFoot>
  );
}
