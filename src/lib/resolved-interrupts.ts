import { useSyncExternalStore } from "react";

/**
 * Interrupt ids the operator has already answered (approve / edit / reject /
 * resolve) this session.
 *
 * The HITL box is rendered off `thread.interrupt`, which the LangGraph SDK only
 * clears once the run reaches a fresh checkpoint with no pending interrupt. When
 * another sub-agent keeps streaming after one interrupt is answered, that clear
 * is delayed, so the box lingers — and worse, as new messages arrive the
 * `<Interrupt>` remounts onto the new last message with FRESH local state and
 * re-shows the already-answered box until the next interrupt replaces it.
 *
 * We keep the answered ids OUTSIDE React so the "answered" flag survives those
 * remounts. The render path suppresses any interrupt whose id is in here; when
 * `thread.interrupt` advances to a genuinely new id (or null), suppression no
 * longer matches and the new interrupt renders normally.
 */
const resolvedIds = new Set<string>();
const listeners = new Set<() => void>();

// Bumped on every change so subscribers re-render even when the value they
// derive (e.g. "are ALL of these interrupts resolved?") can't be expressed as a
// single cached snapshot. Needed for the multi-interrupt case where
// thread.interrupt is an array and there is no single id to watch.
let version = 0;

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}

export function markInterruptResolved(id: string | undefined | null): void {
  if (!id || resolvedIds.has(id)) return;
  resolvedIds.add(id);
  emit();
}

export function isInterruptResolved(id: string | undefined | null): boolean {
  return !!id && resolvedIds.has(id);
}

/** Forget all answered ids (e.g. when switching to a different thread). */
export function clearResolvedInterrupts(): void {
  if (resolvedIds.size === 0) return;
  resolvedIds.clear();
  emit();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/**
 * Subscribe a component to changes in the resolved-interrupt set. Returns a
 * version counter that changes on every mutation, so callers can re-derive
 * "which of these interrupts are still pending?" during render via
 * {@link isInterruptResolved} and always re-render when the set changes.
 */
export function useResolvedInterruptsVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
}
