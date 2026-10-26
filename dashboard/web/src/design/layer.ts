import { useEffect, useRef } from "react";

/**
 * Overlay stack: Escape closes only the topmost overlay. While one is open,
 * the page below moves back a little (html.o-layered).
 */
interface Layer {
  close: () => void;
}

const stack: Layer[] = [];

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || stack.length === 0) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  stack[stack.length - 1].close();
}

function sync() {
  const html = document.documentElement;
  html.classList.toggle("o-layered", stack.length > 0);
  if (stack.length) addEventListener("keydown", onKey, true);
  else removeEventListener("keydown", onKey, true);
}

export function useLayer(close: () => void, active = true) {
  const ref = useRef(close);
  ref.current = close;
  useEffect(() => {
    if (!active) return;
    const layer: Layer = { close: () => ref.current() };
    stack.push(layer);
    sync();
    return () => {
      const i = stack.indexOf(layer);
      if (i >= 0) stack.splice(i, 1);
      sync();
    };
  }, [active]);
}

export const layersOpen = () => stack.length;
