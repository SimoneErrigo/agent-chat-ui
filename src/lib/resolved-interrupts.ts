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

// Resume decisions answered during the CURRENT interrupt episode, keyed by
// interrupt id. With several parallel interrupts pending, resuming with ONLY the
// just-answered one makes the backend re-fire the others from the shared
// checkpoint, so an already-accepted HITL box reappears as approvable. Sending
// the FULL accumulated map on every resume keeps every answered interrupt
// resolved. Cleared together with resolvedIds at the turn boundary.
const answeredResumeDecisions = new Map<string, unknown>();

export function recordResumeDecision(
  id: string | null | undefined,
  payload: unknown,
): void {
  if (id) answeredResumeDecisions.set(id, payload);
}

export function getAllResumeDecisions(): Record<string, unknown> {
  return Object.fromEntries(answeredResumeDecisions);
}

/** JSON.stringify with sorted object keys, so the same payload always yields the same string. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

function getHitlFingerprint(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const hitlValue = value as {
    action_requests?: unknown[];
    review_configs?: unknown[];
  };
  if (!Array.isArray(hitlValue.action_requests)) return null;
  if (!Array.isArray(hitlValue.review_configs)) return null;

  const normalized = {
    action_requests: hitlValue.action_requests.map((request) => {
      const item = request as { name?: unknown; args?: unknown };
      return { name: item?.name, args: item?.args };
    }),
    review_configs: hitlValue.review_configs.map((config) => {
      const item = config as {
        action_name?: unknown;
        allowed_decisions?: unknown;
      };
      return {
        action_name: item?.action_name,
        allowed_decisions: item?.allowed_decisions,
      };
    }),
  };
  return `hitl:${stableStringify(normalized)}`;
}

/**
 * Stable keys for an interrupt. Prefer `interrupt.id` (present on recent
 * LangGraph backends), but also keep a HITL-specific fingerprint that ignores
 * descriptions and schemas. Those fields can be regenerated while sibling
 * agents keep streaming, which otherwise makes an already-approved interrupt
 * look "new" and reappear.
 */
export function getInterruptKeys(
  interrupt: { id?: string | null; value?: unknown } | null | undefined,
): string[] {
  if (!interrupt) return [];
  const keys: string[] = [];
  if (interrupt.id) keys.push(interrupt.id);
  try {
    const hitlFingerprint = getHitlFingerprint(interrupt.value);
    if (hitlFingerprint) keys.push(hitlFingerprint);
    keys.push(`value:${stableStringify(interrupt.value)}`);
  } catch {
    // Fall through with any keys collected so far.
  }
  return [...new Set(keys)];
}

/** Back-compatible single key for callers that do not need all aliases. */
export function getInterruptKey(
  interrupt: { id?: string | null; value?: unknown } | null | undefined,
): string | null {
  return getInterruptKeys(interrupt)[0] ?? null;
}

// Bumped on every change so subscribers re-render even when the value they
// derive (e.g. "are ALL of these interrupts resolved?") can't be expressed as a
// single cached snapshot. Needed for the multi-interrupt case where
// thread.interrupt is an array and there is no single id to watch.
let version = 0;

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}

export function markInterruptResolved(
  id: string | string[] | undefined | null,
): void {
  const ids = Array.isArray(id) ? id : [id];
  let changed = false;
  for (const item of ids) {
    if (!item || resolvedIds.has(item)) continue;
    resolvedIds.add(item);
    changed = true;
  }
  if (changed) {
    persist();
    emit();
  }
}

// Persist the answered-id set per thread so a PAGE RELOAD mid-run does not lose it
// and re-propose interrupts the operator already approved (they linger in
// thread.interrupt until the whole parallel superstep resolves). Keyed by thread,
// so switching threads loads the right set; cleared at the turn boundary.
const STORAGE_PREFIX = "resolved-interrupts:";
let currentStorageKey: string | null = null;

function persist(): void {
  if (typeof sessionStorage === "undefined" || !currentStorageKey) return;
  try {
    sessionStorage.setItem(currentStorageKey, JSON.stringify([...resolvedIds]));
  } catch {
    // sessionStorage unavailable (private mode / quota) -> in-memory only.
  }
}

/** Point the resolved set at a thread, hydrating ids answered before a reload. */
export function setResolvedInterruptsThread(
  threadId: string | null | undefined,
): void {
  const key = threadId ? STORAGE_PREFIX + threadId : null;
  if (key === currentStorageKey) return;
  currentStorageKey = key;
  resolvedIds.clear();
  answeredResumeDecisions.clear();
  if (key && typeof sessionStorage !== "undefined") {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw)
        for (const id of JSON.parse(raw) as string[]) resolvedIds.add(id);
    } catch {
      // ignore malformed storage
    }
  }
  emit();
}

export function isInterruptResolved(
  id: string | string[] | undefined | null,
): boolean {
  const ids = Array.isArray(id) ? id : [id];
  return ids.some((item) => !!item && resolvedIds.has(item));
}

/** Forget all answered ids + accumulated resume decisions (new turn / thread). */
export function clearResolvedInterrupts(): void {
  answeredResumeDecisions.clear();
  if (currentStorageKey && typeof sessionStorage !== "undefined") {
    try {
      sessionStorage.removeItem(currentStorageKey);
    } catch {
      // ignore
    }
  }
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
