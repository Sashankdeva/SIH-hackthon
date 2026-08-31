// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { captureDomState, resetElementRegistry } from "../domCapture";
import { classifyInteractive } from "../interactive";
import { buildSanitizedContext, toWireSanitizedContext } from "../../privacy/sanitizedContext";
import { detectTier1 } from "../../privacy/tier1DomRules";
import { redact } from "../../privacy/redact";

/**
 * C16 — framework-rendered controls.
 *
 * Many modern stacks render primary actions as a plain <div> with a click
 * handler: no role, no tabindex, no href, no ARIA. Those were invisible to the
 * capture pipeline, so a page could present real visible actions while the
 * model saw only decorative links. Detection is generic: author-declared
 * `cursor: pointer` + a short caption + leaf-ish + not nested inside another
 * control. No class names, hostnames, URLs, or label-text matching.
 */

/** jsdom does not cascade, so declare cursor inline where a real page would style it. */
const POINTER = 'style="cursor: pointer"';

const labels = () => captureDomState("t").elements.map((e) => e.label);
const roleOf = (label: string) =>
  captureDomState("t").elements.find((e) => e.label === label)?.role;

describe("generic custom-control capture", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "T";
    resetElementRegistry();
  });

  it("1. clickable div with nested span text → captured as a button", () => {
    document.body.innerHTML = `<div ${POINTER}><span>Submit Order</span></div>`;
    expect(labels()).toContain("Submit Order");
    expect(roleOf("Submit Order")).toBe("button");
  });

  it("2. clickable div with aria-label → aria-label wins as the accessible name", () => {
    document.body.innerHTML = `<div ${POINTER} aria-label="Primary Action"><span>PA</span></div>`;
    expect(labels()).toContain("Primary Action");
  });

  it("3. clickable div with title → title used when there is no text", () => {
    document.body.innerHTML = `<div ${POINTER} title="Titled Action"><svg></svg></div>`;
    expect(labels()).toContain("Titled Action");
  });

  it("4. nested clickable wrappers collapse to ONE control", () => {
    document.body.innerHTML =
      `<div ${POINTER}><div ${POINTER}><div ${POINTER}>Confirm</div></div></div>`;
    const found = captureDomState("t").elements.filter((e) => e.label === "Confirm");
    expect(found).toHaveLength(1);
  });

  it("5. a span INSIDE a link is not reported as a separate control (cursor inherits)", () => {
    document.body.innerHTML = `<a href="/x" ${POINTER}><span>Go Somewhere</span></a>`;
    const found = captureDomState("t").elements.filter((e) => e.label === "Go Somewhere");
    expect(found).toHaveLength(1);
    expect(found[0].tag).toBe("a"); // the real control, not the inner span
  });

  it("6. ordinary non-clickable divs and prose are NOT scraped", () => {
    document.body.innerHTML = `
      <div>Just a layout container</div>
      <span>plain text</span>
      <div ${POINTER}>${"very long prose ".repeat(10)}</div>`;
    const caught = labels();
    expect(caught).not.toContain("Just a layout container");
    expect(caught).not.toContain("plain text");
    expect(caught.some((l) => (l ?? "").startsWith("very long prose"))).toBe(false);
  });

  it("7. classifyInteractive agrees, so validator/executor/PVM share the same view", () => {
    document.body.innerHTML = `<div id="c" ${POINTER}>Act</div>`;
    const info = classifyInteractive(document.getElementById("c")!);
    expect(info).not.toBeNull();
    expect(info!.role).toBe("button");
    expect(info!.editable).toBe(false); // typing into it is still correctly refused
  });

  it("8. the control survives sanitization onto the wire", () => {
    document.body.innerHTML = `<div ${POINTER}><span>Proceed</span></div>`;
    const ps = captureDomState("t");
    const det = detectTier1(ps.elements);
    const red = redact(det);
    const fw = buildSanitizedContext(ps, det, red, "do it");
    expect(fw.ok).toBe(true);
    if (fw.ok) {
      const wire = toWireSanitizedContext(fw.context);
      const el = wire.elements.find((e) => e.label === "Proceed");
      expect(el).toBeDefined();
      expect(el!.role).toBe("button");
    }
  });

  it("9. a hidden clickable div is still excluded", () => {
    document.body.innerHTML = `<div style="cursor: pointer; display: none">Hidden Action</div>`;
    expect(labels()).not.toContain("Hidden Action");
  });
});

describe("focusable controls styled as clickable", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "T";
    resetElementRegistry();
  });

  it("10. tabindex=0 + cursor:pointer with NO aria is captured (framework touchable)", () => {
    document.body.innerHTML =
      `<div tabindex="0" style="cursor: pointer"><span>Section Toggle</span></div>`;
    const els = captureDomState("t").elements;
    const el = els.find((e) => e.label === "Section Toggle");
    expect(el).toBeDefined();
    expect(el!.role).toBe("button");
  });

  it("11. a bare tabindex wrapper with no clickable styling is still NOT captured", () => {
    document.body.innerHTML = `<div tabindex="0"><span>Scroll Region</span></div>`;
    expect(captureDomState("t").elements.map((e) => e.label)).not.toContain("Scroll Region");
  });
});

describe("MAIN-world clickable probe (data-privy-clickable)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "T";
    resetElementRegistry();
  });

  it("12. probe-marked control with NO role/tabindex/cursor is captured", () => {
    // Exactly the shape the probe marks: a plain div the page wired a click
    // handler onto. cursor stays "auto" — there is no styling signal at all.
    document.body.innerHTML =
      `<div data-privy-clickable="1"><span>Primary</span><span>extra</span></div>`;
    const el = captureDomState("t").elements.find((e) => e.label?.startsWith("Primary"));
    expect(el).toBeDefined();
    expect(el!.role).toBe("button");
  });

  it("13. an UNMARKED sibling div of the same shape is NOT captured", () => {
    document.body.innerHTML = `<div><span>Primary</span><span>extra</span></div>`;
    expect(captureDomState("t").elements.map((e) => e.label)).not.toContain("Primaryextra");
  });

  it("14. a marked control with long incidental text is still captured (odometer case)", () => {
    // Real pages append rendered digit columns to the caption's textContent.
    const noise = "0123456789".repeat(9); // 90 chars of incidental text
    document.body.innerHTML = `<div data-privy-clickable="1">Proceed at ${noise}</div>`;
    const found = captureDomState("t").elements.find((e) => (e.label ?? "").startsWith("Proceed at"));
    expect(found).toBeDefined();
    expect(found!.role).toBe("button");
  });

  it("15. a marked element wrapping a whole page section is still rejected", () => {
    const prose = "some long paragraph of body copy ".repeat(20); // > 200 chars
    document.body.innerHTML = `<div data-privy-clickable="1">${prose}</div>`;
    expect(captureDomState("t").elements.length).toBe(0);
  });

  it("16. a hidden marked control is rejected", () => {
    document.body.innerHTML = `<div data-privy-clickable="1" style="display: none">Act Now</div>`;
    expect(captureDomState("t").elements.map((e) => e.label)).not.toContain("Act Now");
  });

  it("17. privacy is unchanged — a sensitive marked control is still redacted", () => {
    document.body.innerHTML = `
      <div data-privy-clickable="1">Continue</div>
      <input type="password" aria-label="Password" />`;
    const ps = captureDomState("t");
    const det = detectTier1(ps.elements);
    const red = redact(det);
    const fw = buildSanitizedContext(ps, det, red, "go");
    expect(fw.ok).toBe(true);
    if (fw.ok) {
      const wire = toWireSanitizedContext(fw.context);
      expect(wire.elements.find((e) => e.label === "Continue")).toBeDefined();
      const pwd = wire.elements.find((e) => e.value_state === "redacted");
      expect(pwd).toBeDefined();
      expect(pwd!.label).toMatch(/^\[[A-Z_]+\d*\]$/); // token, not "Password"
    }
  });

  it("18. parity — validator/executor/PVM see the same control, typing still refused", () => {
    document.body.innerHTML = `<div id="c" data-privy-clickable="1">Act</div>`;
    const info = classifyInteractive(document.getElementById("c")!);
    expect(info).not.toBeNull();
    expect(info!.role).toBe("button");
    expect(info!.editable).toBe(false);
    expect(info!.nativeSelect).toBe(false);
  });
});
