// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  verifyAction,
  verifyActionSettled,
  makeTargetBaseline,
  type ActionSnapshot,
  type SettleConfig,
} from "../verify";
import { captureDomState, resetElementRegistry } from "../../perception/domCapture";
import type { ActionRequest } from "../../action/types";

/**
 * Deterministic before/after harness: each scenario has a known-correct verdict.
 * We run the OLD synchronous verifyAction (fired at the instant the pipeline
 * used to check — i.e. before any async effect lands) and the NEW bounded
 * verifyActionSettled, and tally correctness, false-success, false-failure,
 * ambiguity and latency.
 */

const FAST: SettleConfig = { clickMs: 90, typeMs: 90, scrollMs: 90, navigateMs: 60 };

type Verdict = "success" | "failure" | "ambiguous";
interface Scenario {
  name: string;
  build: () => { action: ActionRequest; over?: Partial<ActionSnapshot> };
  /** schedule the async effect (or apply a sync one and return) */
  effect: () => void;
  expect: Verdict;
}

// Scenario effects schedule DOM changes; track every timer so a stale one from
// a prior scenario can never mutate the next scenario's DOM (suite-load flake).
const pending: ReturnType<typeof setTimeout>[] = [];
function later(fn: () => void, ms: number): void {
  pending.push(setTimeout(() => { try { fn(); } catch { /* stale target */ } }, ms));
}
function clearPending(): void {
  while (pending.length) clearTimeout(pending.pop());
}

let scrollSetter: (v: number) => void = () => {};
function mockScrollY(initial = 0): (v: number) => void {
  let y = initial;
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => y });
  scrollSetter = (v: number) => (y = v);
  return scrollSetter;
}
function idOf(el: Element): number {
  captureDomState("m");
  return Number(el.getAttribute("data-privy-id"));
}
const clickReq = (elementId: number): ActionRequest =>
  ({ action: "click", elementId, confidence: 1, taskId: "t", stepId: 1 }) as ActionRequest;
const typeReq = (elementId: number, value: string): ActionRequest =>
  ({ action: "type", elementId, value, confidence: 1, taskId: "t", stepId: 1 }) as ActionRequest;

const SCENARIOS: Scenario[] = [
  { name: "click/url-sync", expect: "success",
    build: () => { document.body.innerHTML = `<a href="#a">x</a>`; return { action: clickReq(idOf(document.querySelector("a")!)) }; },
    effect: () => { location.hash = "#a"; } },
  { name: "click/removal-sync", expect: "success",
    build: () => { document.body.innerHTML = `<button>x</button>`; return { action: clickReq(idOf(document.querySelector("button")!)) }; },
    effect: () => document.querySelector("button")!.remove() },
  { name: "click/aria-expanded-async", expect: "success",
    build: () => { document.body.innerHTML = `<button aria-expanded="false">x</button>`; return { action: clickReq(idOf(document.querySelector("button")!)) }; },
    effect: () => later(() => document.querySelector("button")!.setAttribute("aria-expanded", "true"), 20) },
  { name: "click/aria-pressed-async", expect: "success",
    build: () => { document.body.innerHTML = `<button aria-pressed="false">x</button>`; return { action: clickReq(idOf(document.querySelector("button")!)) }; },
    effect: () => later(() => document.querySelector("button")!.setAttribute("aria-pressed", "true"), 20) },
  { name: "click/controls-shown-async", expect: "success",
    build: () => { document.body.innerHTML = `<button aria-controls="p">x</button><div id="p" hidden></div>`; return { action: clickReq(idOf(document.querySelector("button")!)) }; },
    effect: () => later(() => document.getElementById("p")!.removeAttribute("hidden"), 20) },
  { name: "click/disabled-async", expect: "success",
    build: () => { document.body.innerHTML = `<button>x</button>`; return { action: clickReq(idOf(document.querySelector("button")!)) }; },
    effect: () => later(() => document.querySelector("button")!.setAttribute("disabled", ""), 20) },
  { name: "click/no-effect", expect: "ambiguous",
    build: () => { document.body.innerHTML = `<button>x</button>`; return { action: clickReq(idOf(document.querySelector("button")!)) }; },
    effect: () => {} },
  { name: "click/unrelated-mutation", expect: "ambiguous",
    build: () => { document.body.innerHTML = `<button>x</button><div id="n"></div>`; return { action: clickReq(idOf(document.querySelector("button")!)) }; },
    effect: () => later(() => { const n = document.getElementById("n")!; n.appendChild(document.createElement("i")); n.setAttribute("aria-expanded", "true"); }, 15) },

  { name: "type/match-sync", expect: "success",
    build: () => { document.body.innerHTML = `<input>`; const el = document.querySelector("input") as HTMLInputElement; const id = idOf(el); el.value = "v"; return { action: typeReq(id, "v") }; },
    effect: () => {} },
  { name: "type/match-async", expect: "success",
    build: () => { document.body.innerHTML = `<input>`; return { action: typeReq(idOf(document.querySelector("input")!), "v") }; },
    effect: () => later(() => ((document.querySelector("input") as HTMLInputElement).value = "v"), 25) },
  { name: "type/reconcile-async", expect: "success",
    build: () => { document.body.innerHTML = `<input value="stale">`; return { action: typeReq(idOf(document.querySelector("input")!), "v") }; },
    effect: () => later(() => ((document.querySelector("input") as HTMLInputElement).value = "v"), 30) },
  { name: "type/revert", expect: "failure",
    build: () => { document.body.innerHTML = `<input>`; const el = document.querySelector("input") as HTMLInputElement; const id = idOf(el); el.value = "v"; return { action: typeReq(id, "v") }; },
    effect: () => later(() => ((document.querySelector("input") as HTMLInputElement).value = "back"), 30) },
  { name: "type/never", expect: "failure",
    build: () => { document.body.innerHTML = `<input>`; return { action: typeReq(idOf(document.querySelector("input")!), "v") }; },
    effect: () => {} },
  { name: "type/target-gone", expect: "failure",
    build: () => { document.body.innerHTML = `<input>`; return { action: typeReq(idOf(document.querySelector("input")!), "v") }; },
    effect: () => later(() => document.querySelector("input")!.remove(), 20) },

  { name: "select/sync", expect: "success",
    build: () => { document.body.innerHTML = `<select><option value="a">A</option><option value="b">B</option></select>`; const el = document.querySelector("select") as HTMLSelectElement; const id = idOf(el); el.value = "b"; return { action: typeReq(id, "B") }; },
    effect: () => {} },
  { name: "select/async", expect: "success",
    build: () => { document.body.innerHTML = `<select><option value="a">A</option><option value="b">B</option></select>`; return { action: typeReq(idOf(document.querySelector("select")!), "B") }; },
    effect: () => later(() => ((document.querySelector("select") as HTMLSelectElement).value = "b"), 25) },
  { name: "select/mismatch", expect: "failure",
    build: () => { document.body.innerHTML = `<select><option value="a">A</option><option value="b">B</option></select>`; const el = document.querySelector("select") as HTMLSelectElement; const id = idOf(el); el.value = "a"; return { action: typeReq(id, "B") }; },
    effect: () => {} },

  { name: "scroll/sync", expect: "success",
    build: () => { mockScrollY(0); return { action: { action: "scroll", direction: "down", amount: 400, confidence: 1, taskId: "t", stepId: 1 } as ActionRequest, over: { scrollYBefore: 0 } }; },
    effect: () => scrollSetter(400) },
  { name: "scroll/async", expect: "success",
    build: () => { mockScrollY(0); return { action: { action: "scroll", direction: "down", amount: 400, confidence: 1, taskId: "t", stepId: 1 } as ActionRequest, over: { scrollYBefore: 0 } }; },
    effect: () => later(() => scrollSetter(360), 30) },
  { name: "scroll/at-boundary", expect: "ambiguous",
    build: () => { mockScrollY(0); Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, get: () => 4000 }); Object.defineProperty(window, "innerHeight", { configurable: true, get: () => 800 }); return { action: { action: "scroll", direction: "up", amount: 400, confidence: 1, taskId: "t", stepId: 1 } as ActionRequest, over: { scrollYBefore: 0 } }; },
    effect: () => {} },

  { name: "navigate/url-sync", expect: "success",
    build: () => ({ action: { action: "navigate", url: "https://e.test/b", confidence: 1, taskId: "t", stepId: 1 } as ActionRequest, over: { urlBefore: "https://e.test/a" } }),
    effect: () => {} },
  { name: "navigate/spa-async", expect: "success",
    build: () => ({ action: { action: "navigate", url: "/r", confidence: 1, taskId: "t", stepId: 1 } as ActionRequest, over: { urlBefore: location.href } }),
    effect: () => later(() => history.pushState({}, "", "/r-" + Date.now()), 20) },
  { name: "navigate/none", expect: "failure",
    build: () => ({ action: { action: "navigate", url: "/x", confidence: 1, taskId: "t", stepId: 1 } as ActionRequest, over: { urlBefore: location.href } }),
    effect: () => {} },
];

function mkSnap(action: ActionRequest, over: Partial<ActionSnapshot> = {}): ActionSnapshot {
  return {
    urlBefore: location.href,
    scrollYBefore: (window as unknown as { scrollY: number }).scrollY ?? 0,
    elementValueBefore: null,
    action,
    startedAt: Date.now(),
    targetBefore: action.elementId != null ? makeTargetBaseline(action.elementId) : null,
    ...over,
  };
}

interface Tally { correct: number; falseSuccess: number; falseFailure: number; ambiguous: number; latSum: number; n: number; }
const blank = (): Tally => ({ correct: 0, falseSuccess: 0, falseFailure: 0, ambiguous: 0, latSum: 0, n: 0 });

function record(t: Tally, got: Verdict, want: Verdict, latency: number) {
  t.n++; t.latSum += latency;
  if (got === want) t.correct++;
  if (got === "ambiguous") t.ambiguous++;
  if (got === "success" && want !== "success") t.falseSuccess++;
  if (got === "failure" && want !== "failure") t.falseFailure++;
}

describe("Phase 5 — before/after settle metrics", () => {
  it("measures old vs new across the scenario matrix", async () => {
    const before = blank();
    const after = blank();

    for (const sc of SCENARIOS) {
      // ---- OLD: synchronous check at the pipeline's old timing ----
      clearPending();
      resetElementRegistry();
      document.body.innerHTML = "";
      location.hash = "";
      {
        const { action, over } = sc.build();
        const s = mkSnap(action, over);
        sc.effect(); // sync effects apply now; async effects are merely scheduled
        const t0 = Date.now();
        const r = verifyAction("t:1", s); // no await — the old immediate check
        record(before, r.status as Verdict, sc.expect, Date.now() - t0);
      }

      // ---- NEW: bounded settle ----
      clearPending();
      resetElementRegistry();
      document.body.innerHTML = "";
      location.hash = "";
      {
        const { action, over } = sc.build();
        const s = mkSnap(action, over);
        sc.effect();
        const t0 = Date.now();
        const r = await verifyActionSettled("t:1", s, FAST);
        record(after, r.status as Verdict, sc.expect, Date.now() - t0);
      }
    }

    const pct = (x: number, n: number) => `${((x / n) * 100).toFixed(0)}%`;
    const line = (label: string, t: Tally) =>
      `${label.padEnd(7)} correct=${pct(t.correct, t.n).padStart(4)}  falseSuccess=${t.falseSuccess}  falseFailure=${t.falseFailure}  ambiguous=${t.ambiguous}  avgLatency=${(t.latSum / t.n).toFixed(1)}ms`;
    // Visible with: npx vitest run <file> --disableConsoleIntercept
    // eslint-disable-next-line no-console
    console.log([`\n[Phase 5 settle metrics] scenarios=${SCENARIOS.length}`, line("BEFORE", before), line("AFTER", after)].join("\n"));

    // The new verifier must be strictly better on correctness and no worse on
    // either error class.
    expect(after.correct).toBeGreaterThan(before.correct);
    expect(after.falseSuccess).toBeLessThanOrEqual(before.falseSuccess);
    expect(after.falseFailure).toBeLessThanOrEqual(before.falseFailure);
    // and it must be perfect on this deterministic matrix
    expect(after.correct).toBe(SCENARIOS.length);
    clearPending();
  });
});
