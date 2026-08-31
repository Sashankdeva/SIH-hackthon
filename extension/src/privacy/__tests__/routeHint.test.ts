// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { captureDomState, resetElementRegistry } from "../../perception/domCapture";
import { buildSanitizedContext, toWireSanitizedContext } from "../sanitizedContext";
import { detectTier1 } from "../tier1DomRules";
import { redact } from "../redact";

/**
 * route_hint — the current in-page route, path only.
 *
 * SPAs frequently leave document.title stale after a client-side navigation,
 * so `page` alone can describe the PREVIOUS view. The path is the authoritative
 * signal for what is actually on screen. Query string and fragment are
 * deliberately excluded: those are the parts that carry identifiers.
 */
function wireFor() {
  const ps = captureDomState("t");
  const det = detectTier1(ps.elements);
  const red = redact(det);
  const fw = buildSanitizedContext(ps, det, red, "do the thing");
  if (!fw.ok) throw new Error("firewall blocked");
  return { wire: toWireSanitizedContext(fw.context), context: fw.context };
}

// Same-origin only — jsdom refuses a cross-origin replaceState.
const setPath = (path: string, search = "", hash = "") => {
  window.history.replaceState({}, "", `${location.origin}${path}${search}${hash}`);
};

describe("route_hint reaches the wire", () => {
  beforeEach(() => {
    document.body.innerHTML = `<a href="/x">Link</a>`;
    document.title = "Home";
    resetElementRegistry();
  });

  it("1. route_hint is populated from the CURRENT path", () => {
    setPath("/acme-widget-a/p/itm12345");
    expect(wireFor().wire.route_hint).toBe("/acme-widget-a/p/itm12345");
  });

  it("2. it tracks a client-side navigation even when the title stays stale", () => {
    setPath("/search");
    const before = wireFor().wire;
    expect(before.route_hint).toBe("/search");

    // SPA route change; title deliberately left stale
    setPath("/acme-widget-b/p/itm99");
    const after = wireFor().wire;
    expect(after.page).toBe("Home"); // title never updated
    expect(after.route_hint).toBe("/acme-widget-b/p/itm99"); // route did
  });

  it("3. query string and fragment are NEVER included", () => {
    setPath("/checkout", "?email=user%40example.com&token=abc123", "#section");
    const hint = wireFor().wire.route_hint!;
    expect(hint).toBe("/checkout");
    expect(hint).not.toContain("?");
    expect(hint).not.toContain("email");
    expect(hint).not.toContain("token");
    expect(hint).not.toContain("#");
  });

  it("4. url_origin is unchanged and no full URL is sent", () => {
    setPath("/a/b", "?q=1");
    const wire = wireFor().wire;
    expect(wire.url_origin).toBe(location.origin);
    expect(JSON.stringify(wire)).not.toContain("?q=1");
  });

  it("5. the internal context carries routeHint and the wire emits route_hint", () => {
    setPath("/p/1");
    const { wire, context } = wireFor();
    expect(context.routeHint).toBe("/p/1");
    expect(wire.route_hint).toBe("/p/1");
  });

  it("6. it is bounded in length", () => {
    setPath("/" + "a".repeat(500));
    expect(wireFor().wire.route_hint!.length).toBeLessThanOrEqual(200);
  });

  it("7. existing fields are unaffected", () => {
    setPath("/p/2");
    const wire = wireFor().wire;
    expect(wire.task_id).toBeDefined();
    expect(wire.task).toBe("do the thing");
    expect(Array.isArray(wire.elements)).toBe(true);
    expect(wire.fields).toBeDefined();
  });
});
