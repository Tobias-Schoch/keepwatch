import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError } from "./api";

/** Feedback after actions. Success fades by itself, warnings and errors stay until clicked. */
export type MessageTone = "success" | "warn" | "error";

export interface Message {
  id: number;
  tone: MessageTone;
  text: string;
  title?: string;
}

type Push = (text: string, tone?: MessageTone, title?: string) => void;

const Ctx = createContext<{ messages: Message[]; push: Push; dismiss: (id: number) => void }>({
  messages: [],
  push: () => {},
  dismiss: () => {},
});

export function MessagesProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const next = useRef(1);
  const push = useCallback<Push>((text, tone = "success", title) => {
    const id = next.current++;
    setMessages((list) => [...list.slice(-3), { id, tone, text, title }]);
  }, []);
  const dismiss = useCallback((id: number) => setMessages((list) => list.filter((m) => m.id !== id)), []);
  const value = useMemo(() => ({ messages, push, dismiss }), [messages, push, dismiss]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useToast = () => useContext(Ctx).push;
export const useMessages = () => {
  const { messages, dismiss } = useContext(Ctx);
  return { messages, dismiss };
};

export function autoDismissMs(m: Message): number | null {
  if (m.tone !== "success") return null;
  return Math.min(12000, 4000 + m.text.length * 35);
}

/**
 * Runs an action and reports the result. Returns true on success.
 * `busy` is the key of the action in flight (for spinners/disabled).
 */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>, success?: string) => {
      setBusy(key);
      try {
        await fn();
        if (success) toast(success);
        return true;
      } catch (e) {
        toast(e instanceof ApiError || e instanceof Error ? e.message : String(e), "error", "Something went wrong");
        return false;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return { busy, run };
}
