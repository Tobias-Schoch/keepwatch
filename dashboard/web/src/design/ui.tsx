import { AlertTriangle, Check, CheckCircle2, Copy, Info, X, XCircle, type LucideIcon } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { copyText } from "../format";
import { cx } from "./fx";
import { useLayer } from "./layer";
import { nudgeSpecular, registerSpecular } from "./rb/surface/specular";

/* Obsidian UI building blocks: buttons, surfaces, forms, overlays. */

export { cx };

/* ---------- Buttons ------------------------------------------------------- */

type Variant = "primary" | "secondary" | "ghost" | "danger" | "accent";
type Size = "sm" | "md" | "lg";

export function Button({
  variant = "secondary",
  size = "md",
  className,
  children,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  const ref = useRef<HTMLButtonElement>(null);
  const idle = SPECULAR_IDLE[variant];
  useEffect(() => {
    const el = ref.current;
    if (!el || idle === undefined) return;
    return registerSpecular(el, idle);
  }, [idle]);
  useEffect(() => nudgeSpecular(), [rest.disabled]);
  return (
    <button ref={ref} type={type} {...rest} className={cx("o-btn", `o-btn-${variant}`, `o-btn-${size}`, idle !== undefined && "o-spec", className)}>
      {children}
    </button>
  );
}

/** Specular edge: base brightness per variant; primary always glows a little, the others only near the cursor. */
const SPECULAR_IDLE: Partial<Record<Variant, number>> = { primary: 0.5, secondary: 0.12, accent: 0.2, danger: 0.1 };

export function IconButton({
  label,
  className,
  children,
  size = "md",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: "sm" | "md" }) {
  return (
    <button type="button" aria-label={label} title={label} {...rest} className={cx("o-icon-btn", size === "sm" && "is-sm", className)}>
      {children}
    </button>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cx("o-kbd", className)}>{children}</kbd>;
}

export function CopyButton({ text, label, variant = "icon", size = "sm", icon: Icon = Copy }: { text: string; label: string; variant?: "icon" | "button"; size?: "sm" | "md"; icon?: LucideIcon }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 1600);
    return () => clearTimeout(t);
  }, [state]);
  const run = () => void copyText(text).then((ok) => setState(ok ? "ok" : "fail"));
  if (variant === "button")
    return (
      <Button onClick={run} size={size === "sm" ? "sm" : "md"}>
        {state === "ok" ? <Check className="h-4 w-4 o-pop" /> : <Icon className="h-4 w-4" />}
        {state === "ok" ? "Copied" : state === "fail" ? "Failed" : label}
      </Button>
    );
  return (
    <IconButton label={state === "ok" ? "Copied" : label} size={size} onClick={run} className={cx(state === "ok" && "is-ok")}>
      {state === "ok" ? <Check className="h-3.5 w-3.5 o-pop" /> : <Icon className="h-3.5 w-3.5" />}
    </IconButton>
  );
}

/* ---------- Status ------------------------------------------------------- */

export type Tone = "neutral" | "accent" | "ok" | "sand" | "apricot" | "rose";

export function Pill({ tone = "neutral", children, className, title, dot }: { tone?: Tone; children: ReactNode; className?: string; title?: string; dot?: boolean }) {
  return (
    <span className={cx("o-pill", className)} data-tone={tone} title={title}>
      {dot && <i className="o-pill-dot" />}
      {children}
    </span>
  );
}

/* ---------- Surfaces & forms ----------------------------------------------- */

export function Panel({ children, className, tone, as = "section", id }: { children: ReactNode; className?: string; tone?: "danger" | "accent" | "sand"; as?: "section" | "div"; id?: string }) {
  const Tag = as;
  return (
    <Tag id={id} className={cx("o-panel", className)} data-light data-tone={tone}>
      {children}
    </Tag>
  );
}

export function SectionHead({ title, sub, aside, icon: Icon }: { title: ReactNode; sub?: ReactNode; aside?: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="o-section-head">
      <div className="min-w-0 flex-1">
        <h2 className="o-h2">
          {Icon && <Icon className="o-h2-icon" />}
          {title}
        </h2>
        {sub && <p className="o-sub">{sub}</p>}
      </div>
      {aside && <div className="o-section-aside">{aside}</div>}
    </div>
  );
}

export function Field({ label, aside, hint, error, htmlFor, children }: { label: ReactNode; aside?: ReactNode; hint?: ReactNode; error?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="o-field">
      <div className="o-field-top">
        <label className="o-label" htmlFor={htmlFor}>
          {label}
        </label>
        {aside && <span className="o-field-aside">{aside}</span>}
      </div>
      {children}
      {error ? <p className="o-field-error">{error}</p> : hint ? <p className="o-hint">{hint}</p> : null}
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} className={cx("o-toggle", checked && "is-on")}>
      <span className="o-toggle-knob" />
    </button>
  );
}

export interface SegOption<T extends string> {
  id: T;
  label: ReactNode;
  count?: number;
  dot?: boolean;
  title?: string;
}

/** Segments/tabs with a sliding glass indicator. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  tabs,
  size = "md",
  className,
}: {
  options: SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
  tabs?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const ind = useRef<HTMLSpanElement>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    const w = wrap.current;
    const i = ind.current;
    if (!w || !i) return;
    const place = () => {
      const el = w.querySelector<HTMLElement>(`[data-seg="${CSS.escape(value)}"]`);
      if (!el) {
        i.style.opacity = "0";
        return;
      }
      i.style.opacity = "1";
      i.style.width = `${el.offsetWidth}px`;
      i.style.transform = `translate3d(${el.offsetLeft}px,0,0)`;
    };
    if (first.current) {
      i.style.transition = "none";
      place();
      void i.offsetWidth;
      i.style.transition = "";
      first.current = false;
    } else place();
    const ro = new ResizeObserver(place);
    ro.observe(w);
    return () => ro.disconnect();
  }, [value, options.length]);
  return (
    <div ref={wrap} className={cx("o-seg", size === "sm" && "is-sm", className)} role={tabs ? "tablist" : "radiogroup"} aria-label={ariaLabel}>
      <span ref={ind} className="o-seg-ind" aria-hidden />
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            data-seg={o.id}
            role={tabs ? "tab" : "radio"}
            aria-selected={tabs ? on : undefined}
            aria-checked={tabs ? undefined : on}
            title={o.title}
            className={cx("o-seg-btn", on && "is-on")}
            onClick={() => onChange(o.id)}
          >
            {o.label}
            {o.count !== undefined && <span className="o-seg-count">{o.count}</span>}
            {o.dot && <i className="o-seg-dot" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}

const CALLOUT_ICON: Record<string, LucideIcon> = {
  neutral: Info,
  accent: Info,
  ok: CheckCircle2,
  sand: AlertTriangle,
  apricot: AlertTriangle,
  rose: XCircle,
};

export function Callout({
  tone = "neutral",
  icon,
  title,
  children,
  action,
  onDismiss,
  className,
}: {
  tone?: Tone;
  icon?: LucideIcon;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  const Icon = icon ?? CALLOUT_ICON[tone];
  return (
    <div className={cx("o-callout", className)} data-tone={tone} role={tone === "rose" ? "alert" : undefined}>
      <span className="o-callout-icon">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        {title && <div className="o-callout-title">{title}</div>}
        {children && <div className="o-callout-text">{children}</div>}
      </div>
      {action && <div className="o-callout-action">{action}</div>}
      {onDismiss && (
        <IconButton label="Dismiss" size="sm" onClick={onDismiss} className="o-callout-x">
          <X className="h-3.5 w-3.5" />
        </IconButton>
      )}
    </div>
  );
}

export function KeyValue({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="o-kv">
      {items.map(([k, v], i) => (
        <div key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ---------- Overlays --------------------------------------------------------- */

const OverlayCtx = createContext<(after?: () => void) => void>(() => {});
/** Closes the surrounding overlay with a fade-out animation, then onClose and `after`. */
export const useCloseOverlay = () => useContext(OverlayCtx);

export function Overlay({
  onClose,
  label,
  size = "md",
  align = "center",
  className,
  children,
  onEscape,
}: {
  onClose: () => void;
  label: string;
  size?: "sm" | "md" | "lg" | "xl";
  align?: "center" | "top";
  className?: string;
  children: ReactNode;
  /** Ask here first on Escape: true = handled (e.g. changes discarded), the overlay stays open. */
  onEscape?: () => boolean;
}) {
  const [leaving, setLeaving] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const timer = useRef<number>();
  const close = (after?: () => void) => {
    if (timer.current) return;
    setLeaving(true);
    timer.current = window.setTimeout(() => {
      onCloseRef.current();
      after?.();
    }, 170);
  };
  useLayer(() => {
    if (onEscapeRef.current?.()) return;
    close();
  });
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const p = panel.current;
    if (p && !p.contains(document.activeElement)) {
      const auto = p.querySelector<HTMLElement>("[autofocus], [data-autofocus]");
      (auto ?? p).focus({ preventScroll: true });
    }
    return () => {
      clearTimeout(timer.current);
      if (prev && document.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <div className={cx("o-overlay", align === "top" && "is-top", leaving && "is-leaving")} role="presentation">
      <div className="o-overlay-backdrop" onClick={() => close()} />
      <div ref={panel} className={cx("o-dialog", `o-dialog-${size}`, className)} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        <OverlayCtx.Provider value={close}>{children}</OverlayCtx.Provider>
      </div>
    </div>,
    document.body,
  );
}

export function DialogHead({ icon: Icon, title, sub, tone, aside }: { icon?: LucideIcon; title: ReactNode; sub?: ReactNode; tone?: Tone | "danger"; aside?: ReactNode }) {
  const close = useCloseOverlay();
  return (
    <div className="o-dialog-head">
      {Icon && (
        <span className="o-dialog-icon" data-tone={tone}>
          <Icon className="h-[18px] w-[18px]" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <h2 className="o-dialog-title">{title}</h2>
        {sub && <div className="o-dialog-sub">{sub}</div>}
      </div>
      {aside}
      <IconButton label="Close (Esc)" onClick={() => close()} className="-mr-1 -mt-1">
        <X className="h-4 w-4" />
      </IconButton>
    </div>
  );
}

export interface ConfirmCopy {
  title: string;
  description: ReactNode;
  note?: ReactNode;
  confirmLabel: string;
  tone?: "danger" | "accent";
  /** Confirm only after typing this word. */
  requireTyping?: string;
}

export function Confirm({ copy, icon, disabled, onClose, onConfirm }: { copy: ConfirmCopy; icon?: LucideIcon; disabled?: boolean; onClose: () => void; onConfirm: () => void }) {
  return (
    <Overlay onClose={onClose} label={copy.title} size="sm" className="o-confirm">
      <ConfirmBody copy={copy} icon={icon} disabled={disabled} onConfirm={onConfirm} />
    </Overlay>
  );
}

function ConfirmBody({ copy, icon: Icon = AlertTriangle, disabled, onConfirm }: { copy: ConfirmCopy; icon?: LucideIcon; disabled?: boolean; onConfirm: () => void }) {
  const close = useCloseOverlay();
  const [typed, setTyped] = useState("");
  const typingOk = !copy.requireTyping || typed.trim() === copy.requireTyping;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled || !typingOk) return;
        onConfirm();
        close();
      }}
    >
      <div className="o-confirm-body">
        <span className="o-confirm-icon" data-tone={copy.tone}>
          <Icon className="h-5 w-5" />
        </span>
        <h2 className="o-confirm-title">{copy.title}</h2>
        <p className="o-confirm-text">{copy.description}</p>
        {copy.note && <div className="o-confirm-note">{copy.note}</div>}
        {copy.requireTyping && (
          <div className="mt-4 text-left">
            <Field label={<>Type “{copy.requireTyping}” to confirm</>} htmlFor="o-confirm-typing">
              <input id="o-confirm-typing" className="o-input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} autoFocus />
            </Field>
          </div>
        )}
      </div>
      <div className="o-confirm-foot">
        <Button variant="ghost" onClick={() => close()}>
          Cancel
        </Button>
        <Button type="submit" variant={copy.tone === "danger" ? "danger" : "primary"} disabled={disabled || !typingOk} data-autofocus={copy.requireTyping || copy.tone === "danger" ? undefined : true}>
          {copy.confirmLabel}
        </Button>
      </div>
    </form>
  );
}
