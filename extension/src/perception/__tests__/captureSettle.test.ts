// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureSettledPage, CAPTURE_SETTLE_MS } from "../../content/index";
import { resetElementRegistry } from "../domCapture";

/**
 * C13 — post-navigation capture settling.
 *
 * A navigating action leaves the NEXT step capturing a document that has not
 * built its interactive DOM yet. That empty context gave the model nothing to
 * target, costing a step on a `wait` or a bad click. Capture now settles within
 * a bounded window. No fixed sleeps, no site rules.
 */

const setReady = (v: DocumentReadyState) =>
  Object.defineProperty(document, "readyState", { value: v, configurable: true });

describe("captureSettledPage — bounded post-navigation settle", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "T";
    resetElementRegistry();
    setReady("complete");
  });
  afterEach(() => setReady("complete"));

  it("1. navigation with an empty DOM that later populates → returns the populated capture", async () => {
    // page arrives empty, controls appear shortly after
    setTimeout(() => {
      document.body.innerHTML = `<button aria-label="Add to cart">Add</button><a href="/x">Home</a>`;
    }, 150);
    const res = await captureSettledPage("t");
    expect(res!.pageState.elements.length).toBeGreaterThan(0);
    expect(res!.pageState.elements.some((e) => e.label === "Add to cart")).toBe(true);
  });

  it("2. first capture empty, second populated → the populated context is what is used", async () => {
    setTimeout(() => { document.body.innerHTML = `<button aria-label="Go">Go</button>`; }, 130);
    const res = await captureSettledPage("t");
    expect(res!.pageState.elements.map((e) => e.label)).toContain("Go");
  });

  it("3. sparse then fully rendered → waits for the count to stabilise", async () => {
    document.body.innerHTML = `<button aria-label="A">A</button>`;
    setReady("loading"); // document still settling, so the fast path does not apply
    setTimeout(() => {
      document.body.innerHTML = `
        <button aria-label="A">A</button><button aria-label="B">B</button>
        <button aria-label="C">C</button><button aria-label="D">D</button>`;
      setReady("complete");
    }, 140);
    const res = await captureSettledPage("t");
    expect(res!.pageState.elements.length).toBe(4);
  });

  it("4. genuinely empty page → existing safe behaviour, returns an empty capture, still bounded", async () => {
    const started = Date.now();
    const res = await captureSettledPage("t");
    const elapsed = Date.now() - started;
    expect(res).not.toBeNull();
    expect(res!.pageState.elements.length).toBe(0); // no fabricated controls
    expect(elapsed).toBeLessThan(CAPTURE_SETTLE_MS + 1500);
  });

  it("5. already-populated ready document → returns immediately, no delay", async () => {
    document.body.innerHTML = `<button aria-label="Go">Go</button>`;
    const started = Date.now();
    const res = await captureSettledPage("t");
    expect(Date.now() - started).toBeLessThan(60);
    expect(res!.pageState.elements.length).toBe(1);
  });

  it("6. bounded settle cannot hang: never-ready document still returns within the cap", async () => {
    setReady("loading"); // never becomes complete
    const started = Date.now();
    const res = await captureSettledPage("t");
    const elapsed = Date.now() - started;
    expect(res).not.toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(CAPTURE_SETTLE_MS - 200);
    expect(elapsed).toBeLessThan(CAPTURE_SETTLE_MS + 1500);
  });

  it("7. capture always reflects the CURRENT document — no stale elements survive", async () => {
    document.body.innerHTML = `<button aria-label="OldOnly">Old</button>`;
    const first = await captureSettledPage("t");
    expect(first!.pageState.elements.map((e) => e.label)).toContain("OldOnly");

    // simulate an SPA route change replacing the whole subtree
    document.body.innerHTML = `<button aria-label="NewOnly">New</button>`;
    const second = await captureSettledPage("t");
    const labels = second!.pageState.elements.map((e) => e.label);
    expect(labels).toContain("NewOnly");
    expect(labels).not.toContain("OldOnly");
  });

  it("8. settled capture still carries value_state (privacy/serialisation untouched)", async () => {
    document.body.innerHTML = `<input type="text" aria-label="Search" /><input type="password" aria-label="Password" />`;
    const res = await captureSettledPage("t");
    const search = res!.pageState.elements.find((e) => e.label === "Search");
    const pwd = res!.pageState.elements.find((e) => e.label === "Password");
    expect(search?.valueState).toBe("empty");
    expect(pwd?.valueState).toBe("redacted");
  });
});
