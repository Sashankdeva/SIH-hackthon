// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  classifyInteractive,
  isEditableInteractive,
  isNativeSelect,
  isInputLike,
  roleCompatible,
} from "../interactive";
import { computeAccessibleName, normalizeName } from "../accessibleName";
import { captureDomState, resetElementRegistry } from "../domCapture";

function first(html: string): Element {
  document.body.innerHTML = html;
  return document.body.firstElementChild as Element;
}

describe("Phase 3 — shared interactive classification", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    resetElementRegistry();
  });

  describe("classifyInteractive coarse role", () => {
    const cases: Array<[string, string, Partial<{ editable: boolean; inputLike: boolean; nativeSelect: boolean }>]> = [
      [`<button>Go</button>`, "button", { editable: false, inputLike: false }],
      [`<a href="/x">Home</a>`, "link", { editable: false }],
      [`<a>no href</a>`, "__null__", {}],
      [`<a role="button" tabindex="0">act</a>`, "button", {}],
      [`<input type="text">`, "textbox", { editable: true, inputLike: true }],
      [`<input type="search">`, "textbox", { editable: true, inputLike: true }],
      [`<input type="number">`, "textbox", { editable: true, inputLike: true }],
      [`<input type="range">`, "slider", { editable: false, inputLike: true }],
      [`<input type="checkbox">`, "checkbox", { editable: false, inputLike: false }],
      [`<input type="radio">`, "radio", { editable: false }],
      [`<input type="submit" value="Send">`, "button", { editable: false }],
      [`<input type="hidden">`, "__null__", {}],
      [`<textarea></textarea>`, "textbox", { editable: true, inputLike: true }],
      [`<select><option>a</option></select>`, "combobox", { editable: false, inputLike: true, nativeSelect: true }],
      [`<summary>More</summary>`, "summary", { editable: false }],
      [`<div role="textbox">x</div>`, "textbox", { editable: false, inputLike: true }],
      [`<div role="searchbox">x</div>`, "searchbox", { editable: false, inputLike: true }],
      [`<div role="combobox">x</div>`, "combobox", { editable: false, inputLike: true }],
      [`<div role="spinbutton">x</div>`, "spinbutton", { editable: false, inputLike: true }],
      [`<div role="slider">x</div>`, "slider", { editable: false, inputLike: true }],
      [`<div contenteditable="true">x</div>`, "textbox", { editable: true, inputLike: true }],
      [`<div contenteditable="">x</div>`, "textbox", { editable: true, inputLike: true }],
      [`<div contenteditable>x</div>`, "textbox", { editable: true, inputLike: true }],
      [`<div role="tab">Tab</div>`, "tab", { editable: false }],
      [`<div role="menuitem">Save</div>`, "menuitem", { editable: false }],
      [`<div role="switch" aria-checked="false">Dark</div>`, "switch", {}],
      [`<div tabindex="0">plain focusable wrapper</div>`, "__null__", {}],
      [`<div tabindex="0" aria-pressed="false">custom toggle</div>`, "button", {}],
      [`<div>totally inert</div>`, "__null__", {}],
    ];

    for (const [html, expectedRole, caps] of cases) {
      it(`classifies ${html}`, () => {
        const info = classifyInteractive(first(html));
        if (expectedRole === "__null__") {
          expect(info).toBeNull();
          return;
        }
        expect(info).not.toBeNull();
        expect(info!.role).toBe(expectedRole);
        for (const [k, v] of Object.entries(caps)) {
          expect(info![k as keyof typeof info]).toBe(v);
        }
      });
    }
  });

  it("helper predicates agree with classifyInteractive", () => {
    expect(isEditableInteractive(first(`<input type="text">`))).toBe(true);
    expect(isEditableInteractive(first(`<select><option>a</option></select>`))).toBe(false);
    expect(isNativeSelect(first(`<select><option>a</option></select>`))).toBe(true);
    expect(isNativeSelect(first(`<div role="combobox">x</div>`))).toBe(false);
    expect(isInputLike(first(`<div role="combobox">x</div>`))).toBe(true);
    expect(isInputLike(first(`<button>x</button>`))).toBe(false);
  });

  it("roleCompatible treats text-entry roles as interchangeable but nothing else", () => {
    expect(roleCompatible("textbox", "searchbox")).toBe(true);
    expect(roleCompatible("combobox", "spinbutton")).toBe(true);
    expect(roleCompatible("button", "link")).toBe(false);
    expect(roleCompatible("textbox", "button")).toBe(false);
    expect(roleCompatible("button", "button")).toBe(true);
    expect(roleCompatible(null, "button")).toBe(true); // no expectation
  });

  it("capture only surfaces classifiable controls (inert focusable wrappers dropped)", () => {
    document.body.innerHTML = `
      <div id="scroller" tabindex="0">just a scroll region</div>
      <div role="button" aria-label="Real">icon</div>
      <button>Plain</button>
      <a>no href no role</a>
    `;
    const roles = captureDomState("t").elements.map((e) => `${e.role}:${e.label}`);
    expect(roles).toEqual(["button:Real", "button:Plain"]);
  });
});

describe("Phase 3 — accessible name extraction", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("normal button text", () => {
    expect(computeAccessibleName(first(`<button>Add to cart</button>`))).toBe("Add to cart");
  });

  it("aria-label wins over text", () => {
    expect(computeAccessibleName(first(`<button aria-label="Close">X</button>`))).toBe("Close");
  });

  it("aria-labelledby resolves referenced text", () => {
    document.body.innerHTML = `<span id="l1">Shipping</span><span id="l2">address</span><button aria-labelledby="l1 l2">go</button>`;
    expect(computeAccessibleName(document.querySelector("button")!)).toBe("Shipping address");
  });

  it("icon button with child SVG aria-label", () => {
    const el = first(`<button><svg aria-label="Search" viewBox="0 0 1 1"><path d="M0 0"/></svg></button>`);
    expect(computeAccessibleName(el)).toBe("Search");
  });

  it("icon button with child SVG <title>", () => {
    const el = first(`<button><svg viewBox="0 0 1 1"><title>Menu</title><path d="M0 0"/></svg></button>`);
    expect(computeAccessibleName(el)).toBe("Menu");
  });

  it("icon button with child <img alt>", () => {
    const el = first(`<button><img alt="Wishlist" src="x.png"></button>`);
    expect(computeAccessibleName(el)).toBe("Wishlist");
  });

  it("icon button with no name at all stays null", () => {
    const el = first(`<button><svg viewBox="0 0 1 1"><path d="M0 0"/></svg></button>`);
    expect(computeAccessibleName(el)).toBeNull();
  });

  it("submit input caption comes from value", () => {
    expect(computeAccessibleName(first(`<input type="submit" value="Place order">`))).toBe("Place order");
  });

  it("never reads a text input's value as its name", () => {
    const el = first(`<input type="text" value="SECRET-PII-123">`);
    expect(computeAccessibleName(el)).toBeNull();
  });

  it("labels are bounded to MAX_LABEL", () => {
    const long = "x".repeat(400);
    const name = computeAccessibleName(first(`<button>${long}</button>`));
    expect(name!.length).toBe(120);
  });

  it("duplicate labels are reported identically (disambiguation is a resolver concern)", () => {
    document.body.innerHTML = `<button>Add to cart</button><button>Add to cart</button>`;
    const [a, b] = Array.from(document.querySelectorAll("button"));
    expect(computeAccessibleName(a)).toBe(computeAccessibleName(b));
    expect(normalizeName(computeAccessibleName(a))).toBe("add to cart");
  });
});
