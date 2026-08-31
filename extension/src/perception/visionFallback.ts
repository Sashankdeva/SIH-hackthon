/**
 * C9 — Generic visual-perception fallback (LOCAL SCAFFOLD ONLY).
 *
 * Context / hard limits established by the C9 audit:
 *
 *  - The frozen `/reason` contract accepts ONLY `SanitizedContext`
 *    (text/structured, `additionalProperties:false`, re-validated server-side).
 *    It cannot carry a screenshot, a visual-evidence blob, or bounding boxes,
 *    and `ActionResponse` has no coordinate action. So visual evidence cannot
 *    reach the model without a server change → SERVER MULTIMODAL DEPENDENCY.
 *  - The DOM privacy firewall operates on the text/attribute layer. Raw viewport
 *    pixels (password glyphs, autofilled PII, tokens, faces, other users' data)
 *    cannot be redacted from a raster by the existing pipeline, and
 *    `pvm/verify.ts` carries a hard "never capture/persist/log screenshots"
 *    invariant. So raw screenshot transmission FAILS CLOSED.
 *  - There is no local UI-vision model — only a face detector used for redaction.
 *
 * Therefore this module is deliberately inert end-to-end: it defines the
 * internal contracts (vision target, sufficiency decision, DOM↔vision mapping)
 * and a deterministic, PURE mapper that a future vision source could plug into.
 * It performs NO screenshot capture, NO network I/O, imports NO `chrome.*` API,
 * and NEVER produces a `success`. `runVisionFallback()` without an injected
 * vision source returns `unavailable` — the caller then proceeds exactly as it
 * does today (existing typed failure / ambiguous). Nothing here changes the
 * DOM-only execution path.
 */

import { normalizeName } from "./accessibleName";

/** Viewport-pixel rectangle: [x, y, width, height]. */
export type Box = [number, number, number, number];

/** A single visual target proposal. Internal only — never serialised to the wire. */
export interface VisionTarget {
  /** What the target looks like / says (free text, bounded by the caller). */
  targetDescription: string;
  /** Viewport pixel box: [x, y, width, height]. */
  boundingBox: Box;
  /** 0..1. */
  confidence: number;
}

/** Geometry + identity for one captured element, in viewport pixels. */
export interface ElementBox {
  elementId: number;
  role: string;
  label: string | null;
  rect: Box;
}

// ---------------------------------------------------------------------------
// Bounds (C9 §12) — everything vision-related must be bounded.
// ---------------------------------------------------------------------------
export const VISION_CAPTURE_TIMEOUT_MS = 1_500;
export const VISION_ANALYSIS_TIMEOUT_MS = 4_000;
export const VISION_MAX_IMAGE_BYTES = 4_000_000;
export const VISION_MAX_DIMENSION = 2_048;
/** A vision result below this confidence never drives a mapping. */
export const VISION_MIN_CONFIDENCE = 0.6;
/** IoU at/above this is a strong box match; the lower band only feeds ambiguity. */
export const STRONG_IOU = 0.5;
export const WEAK_IOU = 0.3;

// ---------------------------------------------------------------------------
// Phase D — perception-sufficiency decision (pure).
// ---------------------------------------------------------------------------
export type SufficiencyReason =
  | "no_dom_target_for_element_action"
  | "referenced_element_absent_from_context"
  | "dom_target_unresolved"
  | "dom_target_ambiguous";

export type PerceptionSufficiency =
  | { decision: "DOM_SUFFICIENT" }
  | { decision: "DOM_INSUFFICIENT"; reason: SufficiencyReason };

export interface SufficiencyInput {
  /** The action the model asked for. */
  actionType: string;
  /** element_id the model referenced (or null/undefined). */
  requestedElementId: number | null | undefined;
  /** element_ids present in the SanitizedContext the model reasoned over. */
  contextElementIds: readonly number[];
  /** Result of the existing stale-target resolver, when it ran. */
  resolutionStatus?: "resolved" | "missing" | "ambiguous" | "unknown";
}

const ELEMENT_ACTIONS = new Set(["click", "type", "type_secret"]);

/**
 * Generic — no task keywords, no hostnames, no selectors. Decides whether the
 * DOM/accessibility representation reliably backs the requested action.
 */
export function assessPerceptionSufficiency(input: SufficiencyInput): PerceptionSufficiency {
  const { actionType, requestedElementId, contextElementIds, resolutionStatus } = input;

  if (!ELEMENT_ACTIONS.has(actionType)) {
    return { decision: "DOM_SUFFICIENT" };
  }
  if (requestedElementId == null) {
    return { decision: "DOM_INSUFFICIENT", reason: "no_dom_target_for_element_action" };
  }
  if (!contextElementIds.includes(requestedElementId)) {
    return { decision: "DOM_INSUFFICIENT", reason: "referenced_element_absent_from_context" };
  }
  if (resolutionStatus === "missing") {
    return { decision: "DOM_INSUFFICIENT", reason: "dom_target_unresolved" };
  }
  if (resolutionStatus === "ambiguous") {
    return { decision: "DOM_INSUFFICIENT", reason: "dom_target_ambiguous" };
  }
  return { decision: "DOM_SUFFICIENT" };
}

// ---------------------------------------------------------------------------
// Phase C — DOM ↔ vision-box mapping (pure, deterministic, never guesses).
// ---------------------------------------------------------------------------
export type VisionMapResult =
  | { status: "resolved"; elementId: number; via: "containment" | "overlap" | "overlap+name"; score: number }
  | { status: "unresolved" }
  | { status: "ambiguous"; candidates: number[] };

function area(b: Box): number {
  return Math.max(0, b[2]) * Math.max(0, b[3]);
}

/** Intersection-over-union of two [x,y,w,h] boxes. 0 when disjoint or degenerate. */
export function iou(a: Box, b: Box): number {
  const ax2 = a[0] + a[2];
  const ay2 = a[1] + a[3];
  const bx2 = b[0] + b[2];
  const by2 = b[1] + b[3];
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** True when `point` [x,y] lies inside box [x,y,w,h]. */
export function boxContainsPoint(box: Box, point: [number, number]): boolean {
  return (
    point[0] >= box[0] &&
    point[0] <= box[0] + box[2] &&
    point[1] >= box[1] &&
    point[1] <= box[1] + box[3]
  );
}

function centerOf(b: Box): [number, number] {
  return [b[0] + b[2] / 2, b[1] + b[3] / 2];
}

/** Loose textual compatibility between the vision description and an element's name/role. */
function descriptionCompatible(description: string, el: ElementBox): boolean {
  const d = normalizeName(description);
  if (!d) return true; // no description to disagree with
  if (d.includes(el.role.toLowerCase())) return true;
  const name = normalizeName(el.label);
  if (!name) return false;
  if (d.includes(name) || name.includes(d)) return true;
  const dTokens = new Set(d.split(" ").filter((t) => t.length > 2));
  return name.split(" ").some((t) => t.length > 2 && dTokens.has(t));
}

/**
 * Maps a vision target box to at most one live DOM element.
 *
 *   exactly one strong match  → resolved
 *   zero strong matches       → unresolved
 *   two or more strong        → ambiguous  (never click)
 *
 * "Strong" = (the target's centre lies inside the element, OR IoU ≥ STRONG_IOU)
 * AND the description is compatible with the element's role/name. The lower IoU
 * band only widens the ambiguity check — it never resolves on its own.
 */
export function mapVisionTargetToDom(target: VisionTarget, elements: readonly ElementBox[]): VisionMapResult {
  const point = centerOf(target.boundingBox);

  interface Scored {
    el: ElementBox;
    contains: boolean;
    overlap: number;
    nameOk: boolean;
  }
  const scored: Scored[] = elements.map((el) => ({
    el,
    contains: boxContainsPoint(el.rect, point),
    overlap: iou(target.boundingBox, el.rect),
    nameOk: descriptionCompatible(target.targetDescription, el),
  }));

  const strong = scored.filter((s) => s.nameOk && (s.contains || s.overlap >= STRONG_IOU));
  const weak = scored.filter((s) => s.nameOk && s.overlap >= WEAK_IOU);

  if (strong.length === 1) {
    const s = strong[0];
    const byName = normalizeName(target.targetDescription) !== "" && s.nameOk && normalizeName(s.el.label) !== "";
    const via = s.contains ? "containment" : byName ? "overlap+name" : "overlap";
    const score = Math.max(s.overlap, s.contains ? 1 : 0);
    return { status: "resolved", elementId: s.el.elementId, via, score };
  }
  if (strong.length >= 2) {
    return { status: "ambiguous", candidates: strong.map((s) => s.el.elementId) };
  }
  if (weak.length >= 2) {
    return { status: "ambiguous", candidates: weak.map((s) => s.el.elementId) };
  }
  return { status: "unresolved" };
}

// ---------------------------------------------------------------------------
// Orchestrator — Phase A/B are injected, never built here.
// ---------------------------------------------------------------------------
export type VisionFallbackOutcome =
  | { status: "not_triggered" }
  | { status: "unavailable"; reason: string }
  | { status: "mapped"; elementId: number; via: string; score: number }
  | { status: "unresolved" }
  | { status: "ambiguous"; candidates: number[] };

/** Optional injected vision source. In production NONE is supplied (see module note). */
export interface VisionSource {
  /** Analyse the current viewport and propose a target. May reject / time out. */
  analyse(): Promise<VisionTarget>;
}

export interface VisionFallbackInput {
  sufficiency: PerceptionSufficiency;
  /** Live element geometry, viewport pixels. Supplied by the caller (DOM-side). */
  elements: readonly ElementBox[];
  /** Injected only by tests / a future capability. */
  visionSource?: VisionSource;
  /** Diagnostic sink; defaults to console. */
  trace?: (line: string) => void;
}

function looksLikeVisionTarget(v: unknown): v is VisionTarget {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  const b = t.boundingBox;
  return (
    typeof t.targetDescription === "string" &&
    typeof t.confidence === "number" &&
    Number.isFinite(t.confidence) &&
    Array.isArray(b) &&
    b.length === 4 &&
    b.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error("vision_timeout")), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Runs the visual fallback. Guarantees:
 *   - never returns `success` (there is no such status);
 *   - `DOM_SUFFICIENT` ⇒ `not_triggered` (vision does not run);
 *   - no injected vision source ⇒ `unavailable` ("no_local_vision_source");
 *   - any capture/analysis error, timeout, malformed result, or low confidence
 *     ⇒ `unavailable` (fail-safe);
 *   - a valid high-confidence target ⇒ deterministic DOM mapping
 *     (`mapped` / `unresolved` / `ambiguous`), never a coordinate.
 * The caller maps every non-`mapped` outcome onto its existing typed
 * failure / ambiguous handling.
 */
export async function runVisionFallback(input: VisionFallbackInput): Promise<VisionFallbackOutcome> {
  const trace = input.trace ?? ((l: string) => console.log(l));

  if (input.sufficiency.decision === "DOM_SUFFICIENT") {
    trace("[VISION-FALLBACK-TRACE] triggered=no reason=dom_sufficient");
    return { status: "not_triggered" };
  }

  const why = input.sufficiency.reason;
  if (!input.visionSource) {
    trace(`[VISION-FALLBACK-TRACE] triggered=yes reason=${why} outcome=unavailable detail=no_local_vision_source`);
    return { status: "unavailable", reason: "no_local_vision_source" };
  }

  let target: VisionTarget;
  try {
    const raw = await withTimeout(input.visionSource.analyse(), VISION_ANALYSIS_TIMEOUT_MS);
    if (!looksLikeVisionTarget(raw)) {
      trace(`[VISION-FALLBACK-TRACE] triggered=yes reason=${why} outcome=unavailable detail=malformed_vision_result`);
      return { status: "unavailable", reason: "malformed_vision_result" };
    }
    target = raw;
  } catch (err) {
    const detail = err instanceof Error && err.message === "vision_timeout" ? "vision_timeout" : "vision_error";
    trace(`[VISION-FALLBACK-TRACE] triggered=yes reason=${why} outcome=unavailable detail=${detail}`);
    return { status: "unavailable", reason: detail };
  }

  const conf = Math.max(0, Math.min(1, target.confidence));
  if (conf < VISION_MIN_CONFIDENCE) {
    trace(
      `[VISION-FALLBACK-TRACE] triggered=yes reason=${why} outcome=unavailable detail=low_confidence conf=${conf.toFixed(2)}`
    );
    return { status: "unavailable", reason: "low_confidence" };
  }

  const mapped = mapVisionTargetToDom(target, input.elements);
  const bb = target.boundingBox;
  const safeBox = `[${Math.round(bb[0])},${Math.round(bb[1])},${Math.round(bb[2])},${Math.round(bb[3])}]`;

  if (mapped.status === "resolved") {
    const el = input.elements.find((e) => e.elementId === mapped.elementId);
    trace(
      `[VISION-FALLBACK-TRACE] triggered=yes reason=${why} outcome=mapped conf=${conf.toFixed(2)} ` +
        `box=${safeBox} via=${mapped.via} score=${mapped.score.toFixed(2)} ` +
        `elementId=${mapped.elementId} role=${el?.role ?? "?"} label=${JSON.stringify((el?.label ?? "").slice(0, 48))}`
    );
    return { status: "mapped", elementId: mapped.elementId, via: mapped.via, score: mapped.score };
  }
  if (mapped.status === "ambiguous") {
    trace(
      `[VISION-FALLBACK-TRACE] triggered=yes reason=${why} outcome=ambiguous conf=${conf.toFixed(2)} ` +
        `box=${safeBox} candidates=${mapped.candidates.join(",")}`
    );
    return { status: "ambiguous", candidates: mapped.candidates };
  }
  trace(
    `[VISION-FALLBACK-TRACE] triggered=yes reason=${why} outcome=unresolved conf=${conf.toFixed(2)} box=${safeBox}`
  );
  return { status: "unresolved" };
}
