// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { captureDomState, resetElementRegistry } from "../../perception/domCapture";
import { buildSanitizedContext, toWireSanitizedContext } from "../sanitizedContext";
import { detectTier1 } from "../tier1DomRules";
import { redact } from "../redact";

/**
 * C11 — `value_state` population.
 *
 * The context must let the model distinguish an already-filled field from a
 * blank one, WITHOUT ever carrying the field's text. Sensitive fields report
 * "redacted" and never disclose occupancy.
 */

const capture = (taskId = "t") => captureDomState(taskId);

/** Full firewall pass → wire payload, as the real pipeline does it. */
function wireFor(task = "do the thing") {
  const pageState = capture();
  const detections = detectTier1(pageState.elements);
  const redactions = redact(detections);
  const fw = buildSanitizedContext(pageState, detections, redactions, task);
  if (!fw.ok) throw new Error("firewall blocked: " + fw.missingElementIds.join(","));
  return { wire: toWireSanitizedContext(fw.context), pageState };
}
const byLabel = (wire: ReturnType<typeof wireFor>["wire"], label: string) =>
  wire.elements.find((e) => e.label === label);

describe("C11 — value_state at the perception boundary", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "Test Page";
    resetElementRegistry();
  });

  it("1. empty textbox → empty", () => {
    document.body.innerHTML = `<input type="text" aria-label="Query" />`;
    expect(capture().elements[0].valueState).toBe("empty");
  });

  it("2. populated textbox → nonempty", () => {
    document.body.innerHTML = `<input type="text" aria-label="Query" />`;
    (document.querySelector("input") as HTMLInputElement).value = "Samsung Galaxy S24 FE";
    expect(capture().elements[0].valueState).toBe("nonempty");
  });

  it("3. empty textarea → empty", () => {
    document.body.innerHTML = `<textarea aria-label="Notes"></textarea>`;
    expect(capture().elements[0].valueState).toBe("empty");
  });

  it("4. populated textarea → nonempty", () => {
    document.body.innerHTML = `<textarea aria-label="Notes"></textarea>`;
    (document.querySelector("textarea") as HTMLTextAreaElement).value = "hello";
    expect(capture().elements[0].valueState).toBe("nonempty");
  });

  it("5. search input reports state like any other text-family input", () => {
    document.body.innerHTML = `<input type="search" aria-label="Search" />`;
    expect(capture().elements[0].valueState).toBe("empty");
    (document.querySelector("input") as HTMLInputElement).value = "phones";
    resetElementRegistry();
    expect(capture().elements[0].valueState).toBe("nonempty");
  });

  it("6. password input → redacted, filled or not", () => {
    document.body.innerHTML = `<input type="password" aria-label="Password" />`;
    expect(capture().elements[0].valueState).toBe("redacted");
    (document.querySelector("input") as HTMLInputElement).value = "hunter2-synthetic";
    resetElementRegistry();
    expect(capture().elements[0].valueState).toBe("redacted");
  });

  it("7. privacy-classified field is forced to redacted even though it is an ordinary text input", () => {
    // type=email is classified sensitive by tier1DomRules → firewall redacts it.
    document.body.innerHTML = `<input type="email" aria-label="Email" />`;
    (document.querySelector("input") as HTMLInputElement).value = "someone@example.com";
    const { wire } = wireFor();
    const el = wire.elements[0];
    expect(el.value_state).toBe("redacted");
    expect(el.value_state).not.toBe("nonempty"); // occupancy of a sensitive field is not disclosed
  });

  it("8. a raw password value never reaches the wire payload in any form", () => {
    const SECRET = "sup3r-secret-synthetic-value";
    document.body.innerHTML = `
      <input type="password" aria-label="Password" />
      <input type="text" aria-label="Query" />`;
    (document.querySelector('input[type="password"]') as HTMLInputElement).value = SECRET;
    (document.querySelector('input[type="text"]') as HTMLInputElement).value = "public text";

    const { wire } = wireFor();
    const serialized = JSON.stringify(wire);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("public text"); // ordinary values are not sent either
    expect(byLabel(wire, "Query")?.value_state).toBe("nonempty");
  });

  it("9. no `value` field is introduced anywhere in the wire elements", () => {
    document.body.innerHTML = `<input type="text" aria-label="Query" />`;
    (document.querySelector("input") as HTMLInputElement).value = "abc";
    const { wire } = wireFor();
    for (const el of wire.elements) {
      expect(Object.keys(el).sort()).toEqual(["element_id", "label", "role", "value_state"].filter((k) => k in el).sort());
      expect(el).not.toHaveProperty("value");
    }
  });

  it("10. state tracks the LIVE DOM: empty before typing, nonempty after", () => {
    document.body.innerHTML = `<input type="text" aria-label="Search" />`;
    const before = wireFor().wire;
    expect(byLabel(before, "Search")?.value_state).toBe("empty");

    // simulate the executor typing into the field
    (document.querySelector("input") as HTMLInputElement).value = "Samsung Galaxy S24 FE";

    const after = wireFor().wire;
    expect(byLabel(after, "Search")?.value_state).toBe("nonempty");
  });

  it("11. non-editable elements carry no value_state; disabled/readonly unchanged", () => {
    document.body.innerHTML = `
      <button aria-label="Go">Go</button>
      <a href="/x" aria-label="Home">Home</a>
      <input type="text" aria-label="Dis" disabled />
      <input type="text" aria-label="Ro" readonly />`;
    const state = capture();
    const btn = state.elements.find((e) => e.label === "Go");
    const link = state.elements.find((e) => e.label === "Home");
    const dis = state.elements.find((e) => e.label === "Dis");
    const ro = state.elements.find((e) => e.label === "Ro");

    expect(btn?.valueState).toBeUndefined();
    expect(link?.valueState).toBeUndefined();
    // disabled/readonly flags behave exactly as before, and still report occupancy
    expect(dis?.disabled).toBe(true);
    expect(dis?.valueState).toBe("empty");
    expect(ro?.readonly).toBe(true);
    expect(ro?.valueState).toBe("empty");

    const { wire } = wireFor();
    expect(byLabel(wire, "Go")).not.toHaveProperty("value_state");
    expect(byLabel(wire, "Home")).not.toHaveProperty("value_state");
  });

  it("12. whitespace-only content counts as empty", () => {
    document.body.innerHTML = `<input type="text" aria-label="Query" />`;
    (document.querySelector("input") as HTMLInputElement).value = "   ";
    expect(capture().elements[0].valueState).toBe("empty");
  });

  it("13. contenteditable host reports occupancy from its text", () => {
    document.body.innerHTML = `<div contenteditable="true" aria-label="Editor"></div>`;
    expect(capture().elements[0].valueState).toBe("empty");
    (document.querySelector("[contenteditable]") as HTMLElement).textContent = "typed";
    resetElementRegistry();
    expect(capture().elements[0].valueState).toBe("nonempty");
  });
});
