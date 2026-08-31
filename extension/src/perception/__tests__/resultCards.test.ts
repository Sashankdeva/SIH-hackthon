// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { captureDomState, resetElementRegistry, resolveElement } from "../domCapture";
import { buildSanitizedContext, toWireSanitizedContext } from "../../privacy/sanitizedContext";
import { detectTier1 } from "../../privacy/tier1DomRules";
import { redact } from "../../privacy/redact";
import { DEFAULT_BUDGET } from "../elementBudget";

/**
 * C18 — result/product cards.
 *
 * A search-result card is normally ONE navigation target wrapping the whole
 * card. Its accessible name comes from textContent, which also contains the
 * captions of the card's own nested controls (a compare checkbox, a wishlist
 * toggle). Those led the label and pushed the item's identity past the length
 * cap, so several cards looked alike to the model. Nested form controls are now
 * stripped first — the same thing the <label> paths already did.
 */

/** One card: a link wrapping a compare checkbox plus the item's title. */
const card = (title: string, href: string) => `
  <a href="${href}">
    <label><input type="checkbox" />Add to Compare</label>
    <div><span>${title}</span><span>4.5</span><span>1,234 Ratings</span></div>
  </a>`;

const capture = () => captureDomState("t").elements;

describe("result card capture", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "Results";
    resetElementRegistry();
  });

  it("1. a clickable result card is captured as one navigation target", () => {
    document.body.innerHTML = card("Acme Widget A", "/p/a");
    const els = capture();
    const links = els.filter((e) => e.role === "link");
    expect(links).toHaveLength(1);
  });

  it("2. the nested title leads the label, not the nested control's caption", () => {
    document.body.innerHTML = card("Acme Widget A", "/p/a");
    const link = capture().find((e) => e.role === "link")!;
    expect(link.label!.startsWith("Acme Widget A")).toBe(true);
    expect(link.label).not.toMatch(/^Add to Compare/);
  });

  it("3. several cards yield distinct ids and distinguishable labels", () => {
    document.body.innerHTML =
      card("Acme Widget A", "/p/a") + card("Acme Widget B", "/p/b") + card("Acme Widget C", "/p/c");
    const links = capture().filter((e) => e.role === "link");
    expect(links).toHaveLength(3);
    expect(new Set(links.map((l) => l.elementId)).size).toBe(3);
    const labels = links.map((l) => l.label ?? "");
    expect(labels.some((l) => l.startsWith("Acme Widget A"))).toBe(true);
    expect(labels.some((l) => l.startsWith("Acme Widget B"))).toBe(true);
    expect(labels.some((l) => l.startsWith("Acme Widget C"))).toBe(true);
    expect(new Set(labels).size).toBe(3);
  });

  it("4. nested spans inside a card do not become duplicate targets", () => {
    document.body.innerHTML = card("Acme Widget A", "/p/a");
    const els = capture();
    // the card link + its compare checkbox; the title spans are not targets
    expect(els.filter((e) => e.label?.startsWith("Acme Widget A"))).toHaveLength(1);
  });

  it("5. an ordinary non-clickable layout card is NOT captured", () => {
    document.body.innerHTML = `<div><div><span>Acme Widget D</span><span>4.1</span></div></div>`;
    expect(capture().map((e) => e.label)).not.toContain("Acme Widget D");
  });

  it("6. a hidden card is rejected", () => {
    document.body.innerHTML = `
      <a href="/p/e" style="display: none">
        <label><input type="checkbox" />Add to Compare</label>
        <div><span>Acme Widget E</span></div>
      </a>`;
    expect(capture().some((e) => (e.label ?? "").startsWith("Acme Widget E"))).toBe(false);
  });

  it("7. a framework-style clickable card (no href/role) is captured via the probe mark", () => {
    document.body.innerHTML =
      `<div data-privy-clickable="1"><span>Acme Widget F</span><span>4.9</span></div>`;
    const el = capture().find((e) => (e.label ?? "").startsWith("Acme Widget F"));
    expect(el).toBeDefined();
    expect(el!.role).toBe("button");
  });

  it("8. cards survive sanitization onto the wire with identity intact", () => {
    document.body.innerHTML = card("Acme Widget A", "/p/a") + card("Acme Widget B", "/p/b");
    const ps = captureDomState("t");
    const det = detectTier1(ps.elements);
    const red = redact(det);
    const fw = buildSanitizedContext(ps, det, red, "open a product");
    expect(fw.ok).toBe(true);
    if (fw.ok) {
      const wire = toWireSanitizedContext(fw.context);
      const titles = wire.elements.map((e) => e.label ?? "");
      expect(titles.some((l) => l.startsWith("Acme Widget A"))).toBe(true);
      expect(titles.some((l) => l.startsWith("Acme Widget B"))).toBe(true);
    }
  });

  it("9. a captured card is resolvable by the executor", () => {
    document.body.innerHTML = card("Acme Widget A", "/p/a");
    const link = capture().find((e) => e.role === "link")!;
    const node = resolveElement(link.elementId);
    expect(node).not.toBeNull();
    expect(node!.tagName.toLowerCase()).toBe("a");
  });

  it("10. the element budget is unchanged", () => {
    expect(DEFAULT_BUDGET.maxElements).toBe(150);
  });

  it("11. privacy unchanged — a sensitive field beside cards is still redacted", () => {
    document.body.innerHTML = card("Acme Widget A", "/p/a") + `<input type="password" aria-label="Password" />`;
    const ps = captureDomState("t");
    const det = detectTier1(ps.elements);
    const red = redact(det);
    const fw = buildSanitizedContext(ps, det, red, "x");
    expect(fw.ok).toBe(true);
    if (fw.ok) {
      const wire = toWireSanitizedContext(fw.context);
      const pwd = wire.elements.find((e) => e.value_state === "redacted");
      expect(pwd).toBeDefined();
      expect(pwd!.label).toMatch(/^\[[A-Z_]+\d*\]$/);
    }
  });

  it("12. a card whose title trips a privacy rule is tokenised, not leaked", () => {
    // Pre-existing tier-1 behaviour: a label matching /phone|mobile/ is treated
    // as a sensitive field. Over-redaction, never a leak — asserted so the
    // interaction with card capture is explicit rather than surprising.
    document.body.innerHTML = card("Acme Phone A", "/p/a");
    const ps = captureDomState("t");
    const det = detectTier1(ps.elements);
    const red = redact(det);
    const fw = buildSanitizedContext(ps, det, red, "x");
    expect(fw.ok).toBe(true);
    if (fw.ok) {
      const wire = toWireSanitizedContext(fw.context);
      const link = wire.elements.find((e) => e.role === "link")!;
      expect(link.label).toMatch(/^\[[A-Z_]+\d*\]$/);
    }
  });

  it("13. a plain link with no nested controls keeps its ordinary label", () => {
    document.body.innerHTML = `<a href="/x">Plain Link</a>`;
    expect(capture().find((e) => e.role === "link")!.label).toBe("Plain Link");
  });
});
