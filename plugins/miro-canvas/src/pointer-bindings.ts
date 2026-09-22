/** Exact mouse chords: extra modifiers do not steal another gesture. */
export const POINTER_BINDINGS = ["none", "right", "alt+left", "shift+left", "ctrl+left", "ctrl+shift+left", "alt+right"] as const;
export type PointerBinding = typeof POINTER_BINDINGS[number];
export function matchesPointer(binding: PointerBinding, event: Pick<MouseEvent, "button" | "altKey" | "shiftKey" | "ctrlKey" | "metaKey">): boolean {
  if (binding === "none") return false;
  const parts = binding.split("+");
  return event.button === (parts.includes("right") ? 2 : 0)
    && !!event.altKey === parts.includes("alt")
    && !!event.shiftKey === parts.includes("shift")
    && !!(event.ctrlKey || event.metaKey) === parts.includes("ctrl");
}
