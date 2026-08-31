// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureDomState, resetElementRegistry } from "../domCapture";

/**
 * Generic regression for the real-Chrome capture bug where a genuinely visible
 * navigation anchor (`<a>…</a>` whose visible content is entirely in descendant
 * spans, i.e. the anchor generates no box of its own — `display: contents` or a
 * collapsed wrapper) was reported as invisible and never sent to the model.
 *
 * No site-specific, word-specific, or hostname logic — the elements here are
 * synthetic wrappers exercising the visibility contract.
 */

const RECT = (w: number, h: number) => ({
  width: w,
  height: h,
  top: 0,
  left: 0,
  bottom: h,
  right: w,
  x: 0,
  y: 0,
  toJSON: () => {},
});
const setRect = (el: Element | null, w: number, h: number): void => {
  if (el) (el as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => RECT(w, h);
};

describe("Role 2 — generic visibility: box-less wrappers & real navigation controls", () => {
  let origBodyRect: typeof document.body.getBoundingClientRect;

  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "Test Page";
    resetElementRegistry();
    // A real layout engine reports a non-zero <body>. Emulate that so the
    // jsdom "no layout ⇒ treat as visible" escape hatch does not fire and the
    // geometry path in isElementVisible() is actually exercised.
    origBodyRect = document.body.getBoundingClientRect.bind(document.body);
    (document.body as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () =>
      RECT(1024, 768);
  });

  afterEach(() => {
    (document.body as unknown as { getBoundingClientRect: unknown }).getBoundingClientRect = origBodyRect;
  });

  const labelPresent = (label: string): boolean =>
    captureDomState("t").elements.some((e) => e.label === label);

  // ---- genuinely visible controls must be captured ------------------------

  it("1. visible anchor with href + text is captured", () => {
    document.body.innerHTML = `<a href="/x" id="a">Section One</a>`;
    setRect(document.getElementById("a"), 90, 20);
    expect(labelPresent("Section One")).toBe(true);
  });

  it("2. visible button with text is captured", () => {
    document.body.innerHTML = `<button id="b">Do Thing</button>`;
    setRect(document.getElementById("b"), 80, 24);
    expect(labelPresent("Do Thing")).toBe(true);
  });

  it("3. visible role=link is captured", () => {
    document.body.innerHTML = `<span role="link" id="s">Go Places</span>`;
    setRect(document.getElementById("s"), 70, 18);
    expect(labelPresent("Go Places")).toBe(true);
  });

  it("4. visible role=tab is captured", () => {
    document.body.innerHTML = `<div role="tab" id="t">Tab Two</div>`;
    setRect(document.getElementById("t"), 60, 30);
    expect(labelPresent("Tab Two")).toBe(true);
  });

  // ---- the real regression: box-less wrapper with a painting descendant --

  it("5. box-less wrapper anchor (0x0 self) with a descendant that paints a box is captured", () => {
    document.body.innerHTML =
      `<a href="/section" id="wrap"><span id="icon"></span><span id="label">Section Label</span></a>`;
    setRect(document.getElementById("wrap"), 0, 0); // anchor generates no box
    setRect(document.getElementById("icon"), 0, 0);
    setRect(document.getElementById("label"), 120, 18); // visible label span
    const nav = captureDomState("t").elements.find((e) => e.label === "Section Label");
    expect(nav).toBeDefined();
    expect(nav?.role).toBe("link");
  });

  it("6. unusual but visible layout: wrapper 0x0 with a DEEP descendant box is captured", () => {
    document.body.innerHTML =
      `<div role="link" id="w"><div id="m"><div id="inner">Deep Nav</div></div></div>`;
    setRect(document.getElementById("w"), 0, 0);
    setRect(document.getElementById("m"), 0, 0);
    setRect(document.getElementById("inner"), 100, 16);
    expect(labelPresent("Deep Nav")).toBe(true);
  });

  // ---- hidden controls must STILL be rejected ---------------------------

  it("7. display:none is rejected (even with a faked box)", () => {
    document.body.innerHTML = `<a href="/x" id="a" style="display:none">Hidden A</a>`;
    setRect(document.getElementById("a"), 90, 20);
    expect(labelPresent("Hidden A")).toBe(false);
  });

  it("8. visibility:hidden is rejected", () => {
    document.body.innerHTML = `<a href="/x" id="a" style="visibility:hidden">Hidden B</a>`;
    setRect(document.getElementById("a"), 90, 20);
    expect(labelPresent("Hidden B")).toBe(false);
  });

  it("9. hidden attribute is rejected", () => {
    document.body.innerHTML = `<a href="/x" id="a" hidden>Hidden C</a>`;
    setRect(document.getElementById("a"), 90, 20);
    expect(labelPresent("Hidden C")).toBe(false);
  });

  it("10. aria-hidden=true is rejected on the element and via an ancestor", () => {
    document.body.innerHTML = `
      <a href="/x" id="a" aria-hidden="true">Hidden D</a>
      <div aria-hidden="true"><a href="/y" id="b">Hidden E</a></div>`;
    setRect(document.getElementById("a"), 90, 20);
    setRect(document.getElementById("b"), 90, 20);
    expect(labelPresent("Hidden D")).toBe(false);
    expect(labelPresent("Hidden E")).toBe(false);
  });

  it("11. genuinely zero-area control with no descendant box is rejected", () => {
    document.body.innerHTML = `<a href="/x" id="a"><span id="c">Zero</span></a>`;
    setRect(document.getElementById("a"), 0, 0);
    setRect(document.getElementById("c"), 0, 0);
    expect(labelPresent("Zero")).toBe(false);
  });

  it("12. box-less wrapper that is ALSO display:none stays rejected — the fix cannot revive hidden content", () => {
    document.body.innerHTML =
      `<a href="/x" id="w" style="display:none"><span id="l">Hidden Nav</span></a>`;
    setRect(document.getElementById("w"), 0, 0);
    setRect(document.getElementById("l"), 120, 18); // a painting child must NOT rescue a display:none wrapper
    expect(labelPresent("Hidden Nav")).toBe(false);
  });
});
