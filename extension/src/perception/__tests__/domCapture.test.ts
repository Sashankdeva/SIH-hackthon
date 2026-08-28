// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { captureDomState, resetElementRegistry, resolveElement } from "../domCapture";

describe("Role 2 — DOM & Accessibility Perception (domCapture)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "Test Page";
    resetElementRegistry();
  });

  it("1. captures basic text input with associated label and correct semantic role", () => {
    document.body.innerHTML = `
      <label for="username">Username</label>
      <input id="username" type="text" />
    `;
    const state = captureDomState("task-1");
    expect(state.elements).toHaveLength(1);
    const el = state.elements[0];
    expect(el.role).toBe("textbox");
    expect(el.label).toBe("Username");
    expect(el.tag).toBe("input");
    expect(el.inputType).toBe("text");
  });

  it("2. captures email input preserving inputType for privacy detection", () => {
    document.body.innerHTML = `
      <label>
        Email Address
        <input type="email" name="user_email" />
      </label>
    `;
    const state = captureDomState("task-2");
    expect(state.elements).toHaveLength(1);
    const el = state.elements[0];
    expect(el.role).toBe("textbox");
    expect(el.label).toBe("Email Address");
    expect(el.inputType).toBe("email");
  });

  it("3. captures password input preserving inputType without leaking raw password value (CRITICAL PRIVACY TEST)", () => {
    document.body.innerHTML = `
      <label for="pwd">Your Secret Password</label>
      <input id="pwd" type="password" value="SuperSecret123" />
    `;
    const state = captureDomState("task-3");
    expect(state.elements).toHaveLength(1);
    const el = state.elements[0];
    expect(el.role).toBe("textbox");
    expect(el.label).toBe("Your Secret Password");
    expect(el.inputType).toBe("password");
    expect((el as any).value).toBeUndefined();

    // Deep check that the secret string does not appear in any property of the captured object
    const serialized = JSON.stringify(el);
    expect(serialized).not.toContain("SuperSecret123");
  });

  it("4. captures tel input preserving inputType", () => {
    document.body.innerHTML = `
      <label for="phone">Phone Number</label>
      <input id="phone" type="tel" placeholder="+91 98765 43210" />
    `;
    const state = captureDomState("task-4");
    expect(state.elements).toHaveLength(1);
    const el = state.elements[0];
    expect(el.role).toBe("textbox");
    expect(el.label).toBe("Phone Number");
    expect(el.inputType).toBe("tel");
    expect(el.placeholder).toBe("+91 98765 43210");
  });

  it("5. captures select element with proper combobox role and enclosing label without option pollution", () => {
    document.body.innerHTML = `
      <label>
        Product
        <select name="product">
          <option value="flight-del-bom">Flight — DEL to BOM, tomorrow</option>
          <option value="flight-del-blr">Flight — DEL to BLR, tomorrow</option>
        </select>
      </label>
    `;
    const state = captureDomState("task-5");
    expect(state.elements).toHaveLength(1);
    const el = state.elements[0];
    expect(el.role).toBe("combobox");
    expect(el.label).toBe("Product");
    expect(el.tag).toBe("select");
    expect(el.inputType).toBeNull();
  });

  it("6. captures textarea element with proper textbox role and label", () => {
    document.body.innerHTML = `
      <label for="feedback">Feedback</label>
      <textarea id="feedback" placeholder="Leave your comments"></textarea>
    `;
    const state = captureDomState("task-6");
    expect(state.elements).toHaveLength(1);
    const el = state.elements[0];
    expect(el.role).toBe("textbox");
    expect(el.label).toBe("Feedback");
    expect(el.tag).toBe("textarea");
    expect(el.inputType).toBeNull();
    expect(el.placeholder).toBe("Leave your comments");
  });

  it("7. extracts aria-label correctly", () => {
    document.body.innerHTML = `
      <button aria-label="Close dialog">X</button>
    `;
    const state = captureDomState("task-7");
    expect(state.elements).toHaveLength(1);
    expect(state.elements[0].label).toBe("Close dialog");
    expect(state.elements[0].role).toBe("button");
  });

  it("8. extracts single-ID aria-labelledby", () => {
    document.body.innerHTML = `
      <span id="label-billing">Billing Details</span>
      <input type="text" aria-labelledby="label-billing" />
    `;
    const state = captureDomState("task-8");
    expect(state.elements).toHaveLength(1);
    expect(state.elements[0].label).toBe("Billing Details");
  });

  it("9. extracts multi-ID space-separated aria-labelledby references cleanly", () => {
    document.body.innerHTML = `
      <span id="first">First</span>
      <span id="nonexistent"></span>
      <span id="last">Name</span>
      <input type="text" aria-labelledby="first missing-id last" />
    `;
    const state = captureDomState("task-9");
    expect(state.elements).toHaveLength(1);
    expect(state.elements[0].label).toBe("First Name");
  });

  it("10. obeys deterministic label precedence: aria-label > aria-labelledby > <label> > placeholder > title > name", () => {
    document.body.innerHTML = `
      <span id="aria-by">LabelledBy Text</span>
      <label for="multi">Enclosing Label</label>
      <input
        id="multi"
        type="text"
        name="field_name"
        title="Title Text"
        placeholder="Placeholder Text"
        aria-labelledby="aria-by"
        aria-label="Aria Label Text"
      />
    `;
    const state = captureDomState("task-10");
    expect(state.elements[0].label).toBe("Aria Label Text");

    // Remove aria-label -> falls back to aria-labelledby
    document.getElementById("multi")?.removeAttribute("aria-label");
    expect(captureDomState("task-10b").elements[0].label).toBe("LabelledBy Text");

    // Remove aria-labelledby -> falls back to <label>
    document.getElementById("multi")?.removeAttribute("aria-labelledby");
    expect(captureDomState("task-10c").elements[0].label).toBe("Enclosing Label");

    // Remove <label> association -> falls back to placeholder
    document.querySelector("label")?.remove();
    expect(captureDomState("task-10d").elements[0].label).toBe("Placeholder Text");

    // Remove placeholder -> falls back to title
    document.getElementById("multi")?.removeAttribute("placeholder");
    expect(captureDomState("task-10e").elements[0].label).toBe("Title Text");

    // Remove title -> falls back to name
    document.getElementById("multi")?.removeAttribute("title");
    expect(captureDomState("task-10f").elements[0].label).toBe("field_name");
  });

  it("11. filters out hidden elements via display:none, visibility:hidden, opacity:0, hidden, and aria-hidden", () => {
    document.body.innerHTML = `
      <input id="visible" type="text" aria-label="Visible" />
      <input id="hidden-attr" type="text" aria-label="Hidden Attr" hidden />
      <input id="aria-hidden" type="text" aria-label="Aria Hidden" aria-hidden="true" />
      <div aria-hidden="true">
        <input id="nested-aria-hidden" type="text" aria-label="Nested Aria Hidden" />
      </div>
      <input id="style-none" type="text" aria-label="Display None" style="display: none;" />
      <input id="style-vis-hidden" type="text" aria-label="Vis Hidden" style="visibility: hidden;" />
      <input id="style-opacity-zero" type="text" aria-label="Opacity Zero" style="opacity: 0;" />
    `;
    // Mock getBoundingClientRect for JSDOM
    const visibleEl = document.getElementById("visible")!;
    visibleEl.getBoundingClientRect = () => ({ width: 100, height: 30, top: 0, left: 0, bottom: 30, right: 100, x: 0, y: 0, toJSON: () => {} });

    const hiddenAttrEl = document.getElementById("hidden-attr")!;
    hiddenAttrEl.getBoundingClientRect = () => ({ width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0, x: 0, y: 0, toJSON: () => {} });

    const state = captureDomState("task-11");
    const labels = state.elements.map((e) => e.label);
    expect(labels).toContain("Visible");
    expect(labels).not.toContain("Hidden Attr");
    expect(labels).not.toContain("Aria Hidden");
    expect(labels).not.toContain("Nested Aria Hidden");
    expect(labels).not.toContain("Display None");
    expect(labels).not.toContain("Vis Hidden");
    expect(labels).not.toContain("Opacity Zero");
  });

  it("12. captures disabled and readonly states accurately", () => {
    document.body.innerHTML = `
      <input id="d1" type="text" aria-label="Disabled 1" disabled />
      <input id="d2" type="text" aria-label="Disabled 2" aria-disabled="true" />
      <input id="r1" type="text" aria-label="Readonly 1" readonly />
      <input id="r2" type="text" aria-label="Readonly 2" aria-readonly="true" />
      <input id="normal" type="text" aria-label="Normal" />
    `;
    const state = captureDomState("task-12");
    const d1 = state.elements.find((e) => e.label === "Disabled 1");
    const d2 = state.elements.find((e) => e.label === "Disabled 2");
    const r1 = state.elements.find((e) => e.label === "Readonly 1");
    const r2 = state.elements.find((e) => e.label === "Readonly 2");
    const normal = state.elements.find((e) => e.label === "Normal");

    expect(d1?.disabled).toBe(true);
    expect(d2?.disabled).toBe(true);
    expect(r1?.readonly).toBe(true);
    expect(r2?.readonly).toBe(true);
    expect(normal?.disabled).toBeUndefined();
    expect(normal?.readonly).toBeUndefined();
  });

  it("13. assigns stable integer element IDs via data-privy-id and resolves them correctly", () => {
    document.body.innerHTML = `
      <button id="btn1">Submit</button>
      <a id="link1" href="https://example.com">Learn More</a>
    `;
    const state = captureDomState("task-13");
    expect(state.elements).toHaveLength(2);

    const btnId = state.elements[0].elementId;
    const linkId = state.elements[1].elementId;
    expect(btnId).toBeGreaterThan(0);
    expect(linkId).toBeGreaterThan(btnId);

    const resolvedBtn = resolveElement(btnId);
    const resolvedLink = resolveElement(linkId);
    expect(resolvedBtn).toBe(document.getElementById("btn1"));
    expect(resolvedLink).toBe(document.getElementById("link1"));
  });

  it("14. recovers element resolution after DOM node replacement if data-privy-id attribute is preserved (SPA re-render simulation)", () => {
    document.body.innerHTML = `
      <div id="container">
        <button id="old-btn">Click Me</button>
      </div>
    `;
    const state = captureDomState("task-14");
    const btnId = state.elements[0].elementId;

    // Simulate SPA component re-render replacing the DOM node
    const container = document.getElementById("container")!;
    const newBtn = document.createElement("button");
    newBtn.id = "new-btn";
    newBtn.textContent = "Click Me";
    newBtn.setAttribute("data-privy-id", String(btnId)); // Re-rendered node retains assigned ID
    container.innerHTML = "";
    container.appendChild(newBtn);

    // resolveElement should successfully find the new element node via data-privy-id fallback
    const resolved = resolveElement(btnId);
    expect(resolved).toBe(newBtn);
    expect(resolved?.id).toBe("new-btn");
  });

  it("15. supports diverse ARIA interactive widgets (checkbox, radio, tab, switch, menuitem)", () => {
    document.body.innerHTML = `
      <div role="checkbox" aria-label="Accept Terms" tabindex="0"></div>
      <div role="radio" aria-label="Option A" tabindex="0"></div>
      <div role="tab" aria-label="General Settings"></div>
      <div role="switch" aria-label="Dark Mode"></div>
      <div role="menuitem" aria-label="Save File"></div>
      <div role="button" aria-label="Custom Button"></div>
    `;
    const state = captureDomState("task-15");
    expect(state.elements).toHaveLength(6);

    expect(state.elements.find((e) => e.role === "checkbox")?.label).toBe("Accept Terms");
    expect(state.elements.find((e) => e.role === "radio")?.label).toBe("Option A");
    expect(state.elements.find((e) => e.role === "tab")?.label).toBe("General Settings");
    expect(state.elements.find((e) => e.role === "switch")?.label).toBe("Dark Mode");
    expect(state.elements.find((e) => e.role === "menuitem")?.label).toBe("Save File");
    expect(state.elements.find((e) => e.role === "button")?.label).toBe("Custom Button");
  });

  it("16. perfectly perceives the full mock-site checkout page including product select", () => {
    document.body.innerHTML = `
      <nav><a href="privacy-test.html">Go to privacy canary test page &rarr;</a></nav>
      <h1>Mock Checkout</h1>
      <form id="checkout-form" onsubmit="return false;">
        <label>
          Full Name
          <input type="text" name="name" autocomplete="name" placeholder="Aarav Sharma" />
        </label>
        <label>
          Email
          <input type="email" name="email" autocomplete="email" placeholder="aarav@example.com" />
        </label>
        <label>
          Phone
          <input type="tel" name="phone" autocomplete="tel" placeholder="+91 98765 43210" />
        </label>
        <label>
          Password
          <input type="password" name="password" autocomplete="current-password" />
        </label>
        <label>
          Shipping Address
          <input type="text" name="address" autocomplete="street-address" placeholder="221B Residency Road" />
        </label>
        <label>
          Card Number
          <input type="text" name="card_number" autocomplete="cc-number" placeholder="4111 1111 1111 1111" />
        </label>
        <label>
          Product
          <select name="product">
            <option value="flight-del-bom">Flight — DEL to BOM, tomorrow</option>
            <option value="flight-del-blr">Flight — DEL to BLR, tomorrow</option>
          </select>
        </label>
        <button id="submit-btn" type="submit">Place Order</button>
      </form>
    `;

    const state = captureDomState("task-mock");
    expect(state.elements).toHaveLength(9);

    const labels = state.elements.map((e) => e.label);
    expect(labels).toEqual([
      "Go to privacy canary test page →",
      "Full Name",
      "Email",
      "Phone",
      "Password",
      "Shipping Address",
      "Card Number",
      "Product",
      "Place Order",
    ]);

    const productSelect = state.elements.find((e) => e.label === "Product");
    expect(productSelect).toBeDefined();
    expect(productSelect?.role).toBe("combobox");
    expect(productSelect?.tag).toBe("select");
    expect(productSelect?.inputType).toBeNull();
  });

  it("17. falls back to name attribute for unlabeled input/select/textarea", () => {
    document.body.innerHTML = `
      <input type="text" name="standalone_input" />
      <select name="standalone_select"><option>A</option></select>
      <textarea name="standalone_textarea"></textarea>
    `;
    const state = captureDomState("task-17");
    expect(state.elements).toHaveLength(3);
    expect(state.elements[0].label).toBe("standalone_input");
    expect(state.elements[1].label).toBe("standalone_select");
    expect(state.elements[2].label).toBe("standalone_textarea");
  });

  it("18. maps input[type=submit] and input[type=button] to role button with value as text content", () => {
    document.body.innerHTML = `
      <input type="submit" value="Send Form" />
      <input type="button" value="Click Button" />
    `;
    const state = captureDomState("task-18");
    expect(state.elements).toHaveLength(2);
    expect(state.elements[0].role).toBe("button");
    expect(state.elements[0].inputType).toBe("submit");
    expect(state.elements[1].role).toBe("button");
    expect(state.elements[1].inputType).toBe("button");
  });

  it("19. correctly marks elements inside disabled fieldset as disabled", () => {
    document.body.innerHTML = `
      <fieldset disabled>
        <legend>Personal Info</legend>
        <input type="text" aria-label="First Name" />
      </fieldset>
    `;
    const state = captureDomState("task-19");
    expect(state.elements).toHaveLength(1);
    expect(state.elements[0].disabled).toBe(true);
  });

  it("20. handles invalid or non-existent element IDs safely in resolveElement", () => {
    expect(resolveElement(0)).toBeNull();
    expect(resolveElement(-1)).toBeNull();
    expect(resolveElement(99999)).toBeNull();
  });

  it("21. never captures CANARY PII values from privacy test page into CapturedElement fields", () => {
    document.body.innerHTML = `
      <form>
        <label>Email <input type="email" name="email" value="CANARY_EMAIL_12345@example.com" /></label>
        <label>Phone <input type="tel" name="phone" value="CANARY_PHONE_5550100" /></label>
        <label>Password <input type="password" name="password" value="CANARY_PASSWORD_hunter2" /></label>
        <label>Card <input type="text" name="card_number" value="CANARY_CARD_4242424242424242" /></label>
      </form>
    `;
    const state = captureDomState("task-canary");
    const jsonStr = JSON.stringify(state);

    expect(jsonStr).not.toContain("CANARY_EMAIL_12345@example.com");
    expect(jsonStr).not.toContain("CANARY_PHONE_5550100");
    expect(jsonStr).not.toContain("CANARY_PASSWORD_hunter2");
    expect(jsonStr).not.toContain("CANARY_CARD_4242424242424242");
  });

  it("22. [Phase 2 Hand-off] verifies JSON serialization/deserialization integrity and fidelity", () => {
    document.body.innerHTML = `
      <label for="name">Name</label>
      <input id="name" type="text" placeholder="Your Name" disabled />
      <button id="btn" aria-label="Action">Click</button>
    `;
    const state = captureDomState("task-serialize");
    const jsonString = JSON.stringify(state);
    const parsed = JSON.parse(jsonString);

    expect(parsed.taskId).toBe("task-serialize");
    expect(parsed.url).toBe(location.href);
    expect(parsed.title).toBe(document.title);
    expect(typeof parsed.capturedAt).toBe("number");
    expect(parsed.elements).toHaveLength(2);

    const inputEl = parsed.elements[0];
    expect(inputEl.elementId).toBeGreaterThan(0);
    expect(inputEl.role).toBe("textbox");
    expect(inputEl.label).toBe("Name");
    expect(inputEl.tag).toBe("input");
    expect(inputEl.inputType).toBe("text");
    expect(inputEl.disabled).toBe(true);
    expect(inputEl.placeholder).toBe("Your Name");
    expect(inputEl.readonly).toBeUndefined();
  });

  it("23. [Phase 2 Hand-off] verifies full dynamic page lifecycle cases (existence, removal, replacement, re-mount, attribute loss)", () => {
    document.body.innerHTML = `
      <div id="wrapper">
        <button id="target-btn">Target</button>
      </div>
    `;

    // Case 1: Element exists
    const state1 = captureDomState("task-lifecycle");
    const targetId = state1.elements[0].elementId;
    expect(resolveElement(targetId)).toBe(document.getElementById("target-btn"));

    // Case 2: Element is removed from DOM
    const targetBtn = document.getElementById("target-btn")!;
    targetBtn.remove();
    expect(resolveElement(targetId)).toBeNull();

    // Case 3 & 4: Element is re-mounted / replaced with data-privy-id preserved
    const wrapper = document.getElementById("wrapper")!;
    const remountedBtn = document.createElement("button");
    remountedBtn.id = "remounted-btn";
    remountedBtn.setAttribute("data-privy-id", String(targetId));
    wrapper.appendChild(remountedBtn);
    expect(resolveElement(targetId)).toBe(remountedBtn);

    // Case 5: Element is replaced and custom attributes are stripped
    wrapper.innerHTML = `<button id="brand-new-btn">Brand New</button>`;
    expect(resolveElement(targetId)).toBeNull();
  });

  it("24. [Phase 2 Hand-off] measures capture execution performance and payload footprint", () => {
    document.body.innerHTML = `
      <nav><a href="privacy-test.html">Go to privacy canary test page &rarr;</a></nav>
      <h1>Mock Checkout</h1>
      <form id="checkout-form">
        <label>Full Name <input type="text" name="name" autocomplete="name" placeholder="Aarav Sharma" /></label>
        <label>Email <input type="email" name="email" autocomplete="email" placeholder="aarav@example.com" /></label>
        <label>Phone <input type="tel" name="phone" autocomplete="tel" placeholder="+91 98765 43210" /></label>
        <label>Password <input type="password" name="password" autocomplete="current-password" /></label>
        <label>Shipping Address <input type="text" name="address" autocomplete="street-address" placeholder="221B Residency Road" /></label>
        <label>Card Number <input type="text" name="card_number" autocomplete="cc-number" placeholder="4111 1111 1111 1111" /></label>
        <label>Product
          <select name="product">
            <option value="flight-del-bom">Flight — DEL to BOM, tomorrow</option>
            <option value="flight-del-blr">Flight — DEL to BLR, tomorrow</option>
          </select>
        </label>
        <button id="submit-btn" type="submit">Place Order</button>
      </form>
    `;

    const iterations = 50;
    const times: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      const state = captureDomState(`task-perf-${i}`);
      const duration = performance.now() - start;
      times.push(duration);
      expect(state.elements).toHaveLength(9);
    }

    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const avgTime = times.reduce((a, b) => a + b, 0) / iterations;

    const sampleState = captureDomState("task-perf-sample");
    const jsonBytes = new TextEncoder().encode(JSON.stringify(sampleState)).length;

    console.log(`[Phase 2 Performance] Capture Execution (${iterations} runs): min=${minTime.toFixed(3)}ms, max=${maxTime.toFixed(3)}ms, avg=${avgTime.toFixed(3)}ms, payload=${jsonBytes} bytes`);

    expect(avgTime).toBeLessThan(50); // Well within real-time budget (<50ms in test environment, typically <1ms)
    expect(jsonBytes).toBeLessThan(5000); // Lightweight payload (<5KB)
  });

  it("25. [Phase 3 - Group B] Label Robustness & Precedence: comprehensive 10-case cascade verification", () => {
    // Case 1: aria-label
    document.body.innerHTML = `<input id="c1" aria-label="Aria Label" placeholder="Placeholder" title="Title" name="fieldName" />`;
    expect(captureDomState("p3-b1").elements[0].label).toBe("Aria Label");

    // Case 2: single aria-labelledby
    document.body.innerHTML = `<span id="lbl2">LabelledBy Single</span><input id="c2" aria-labelledby="lbl2" placeholder="Placeholder" />`;
    expect(captureDomState("p3-b2").elements[0].label).toBe("LabelledBy Single");

    // Case 3: multi-ID aria-labelledby
    document.body.innerHTML = `<span id="lbl3a">First</span><span id="lbl3b">Part</span><input id="c3" aria-labelledby="lbl3a lbl3b" />`;
    expect(captureDomState("p3-b3").elements[0].label).toBe("First Part");

    // Case 4: associated label[for]
    document.body.innerHTML = `<label for="c4">Associated For Label</label><input id="c4" placeholder="Placeholder" />`;
    expect(captureDomState("p3-b4").elements[0].label).toBe("Associated For Label");

    // Case 5: nested label
    document.body.innerHTML = `<label>Nested Label Text<input id="c5" placeholder="Placeholder" /></label>`;
    expect(captureDomState("p3-b5").elements[0].label).toBe("Nested Label Text");

    // Case 6: placeholder
    document.body.innerHTML = `<input id="c6" placeholder="Placeholder Text" title="Title Text" name="c6Name" />`;
    expect(captureDomState("p3-b6").elements[0].label).toBe("Placeholder Text");

    // Case 7: title
    document.body.innerHTML = `<input id="c7" title="Title Text" name="c7Name" />`;
    expect(captureDomState("p3-b7").elements[0].label).toBe("Title Text");

    // Case 8: name
    document.body.innerHTML = `<input id="c8" name="c8Name" />`;
    expect(captureDomState("p3-b8").elements[0].label).toBe("c8Name");

    // Case 9: no label information
    document.body.innerHTML = `<input id="c9" />`;
    expect(captureDomState("p3-b9").elements[0].label).toBeNull();

    // Case 10: non-input text fallback
    document.body.innerHTML = `<button id="c10">Button Text Content</button>`;
    expect(captureDomState("p3-b10").elements[0].label).toBe("Button Text Content");
  });

  it("26. [Phase 3 - Group C] ARIA Robustness: whitespace normalization, duplicate references, and non-pollution from aria-describedby", () => {
    document.body.innerHTML = `
      <span id="p1">Hello</span>
      <span id="p2">World</span>
      <div id="desc">Helper description error message</div>
      <input
        id="aria-edge"
        type="text"
        aria-labelledby="   p1    p1    missingId   p2   "
        aria-describedby="desc"
      />
    `;
    const state = captureDomState("p3-c");
    expect(state.elements).toHaveLength(1);
    expect(state.elements[0].label).toBe("Hello Hello World");
    // Confirm aria-describedby text is not polluting the accessible label
    expect(state.elements[0].label).not.toContain("Helper description");
  });

  it("27. [Phase 3 - Group D] Form Element Types Robustness: number, search, url, date, textarea, and select", () => {
    document.body.innerHTML = `
      <label for="num">Age</label>
      <input id="num" type="number" value="25" />
      <label for="srch">Search</label>
      <input id="srch" type="search" placeholder="Search docs..." />
      <label for="web">Website</label>
      <input id="web" type="url" value="https://example.com" />
      <label for="dob">Birthday</label>
      <input id="dob" type="date" value="2000-01-01" />
    `;
    const state = captureDomState("p3-d");
    expect(state.elements).toHaveLength(4);

    expect(state.elements[0].role).toBe("textbox");
    expect(state.elements[0].inputType).toBe("number");
    expect(state.elements[0].label).toBe("Age");

    expect(state.elements[1].role).toBe("textbox");
    expect(state.elements[1].inputType).toBe("search");
    expect(state.elements[1].label).toBe("Search");

    expect(state.elements[2].role).toBe("textbox");
    expect(state.elements[2].inputType).toBe("url");

    expect(state.elements[3].role).toBe("textbox");
    expect(state.elements[3].inputType).toBe("date");

    // Assert no raw values leaked in serialization
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("2000-01-01");
    expect(serialized).not.toContain("https://example.com");
  });

  it("28. [Phase 3 - Group F] Visibility Robustness: off-screen elements with valid dimensions are preserved; hidden styles are excluded", () => {
    document.body.innerHTML = `
      <button id="normal-btn">Normal</button>
      <button id="offscreen-btn">Offscreen</button>
      <button id="disabled-visible-btn" disabled>Disabled</button>
      <button id="display-none-btn" style="display: none;">Hidden 1</button>
      <button id="vis-hidden-btn" style="visibility: hidden;">Hidden 2</button>
      <button id="op-zero-btn" style="opacity: 0;">Hidden 3</button>
      <button id="aria-hid-btn" aria-hidden="true">Hidden 4</button>
    `;

    // Mock offscreen element having real non-zero dimensions
    const offscreenEl = document.getElementById("offscreen-btn")!;
    offscreenEl.getBoundingClientRect = () => ({
      width: 120,
      height: 40,
      top: 3500,
      left: 20,
      bottom: 3540,
      right: 140,
      x: 20,
      y: 3500,
      toJSON: () => {},
    });

    const state = captureDomState("p3-f");
    const labels = state.elements.map((e) => e.label);

    expect(labels).toContain("Normal");
    expect(labels).toContain("Offscreen");
    expect(labels).toContain("Disabled");
    expect(labels).not.toContain("Hidden 1");
    expect(labels).not.toContain("Hidden 2");
    expect(labels).not.toContain("Hidden 3");
    expect(labels).not.toContain("Hidden 4");
  });

  it("29. [Phase 3 - Group H] Dynamic DOM: detects dynamic element insertion, removal, and attribute mutations on fresh capture", () => {
    document.body.innerHTML = `
      <div id="dynamic-root">
        <input id="f1" type="text" aria-label="Field 1" />
      </div>
    `;

    // Capture 1
    const state1 = captureDomState("p3-h1");
    expect(state1.elements).toHaveLength(1);
    expect(state1.elements[0].label).toBe("Field 1");
    expect(state1.elements[0].disabled).toBeUndefined();

    // Dynamic Mutation: insert field, disable field 1
    const root = document.getElementById("dynamic-root")!;
    const f1 = document.getElementById("f1") as HTMLInputElement;
    f1.disabled = true;

    const f2 = document.createElement("input");
    f2.id = "f2";
    f2.type = "email";
    f2.setAttribute("aria-label", "Field 2");
    root.appendChild(f2);

    // Capture 2
    const state2 = captureDomState("p3-h2");
    expect(state2.elements).toHaveLength(2);
    expect(state2.elements[0].disabled).toBe(true);
    expect(state2.elements[1].label).toBe("Field 2");
    expect(state2.elements[1].inputType).toBe("email");
  });

  it("30. [Phase 3 - Group K] Mock-Site Golden-Path Workflow: initial load -> form input -> submit click -> state update", () => {
    document.body.innerHTML = `
      <nav><a href="privacy-test.html">Go to privacy canary test page &rarr;</a></nav>
      <h1>Mock Checkout</h1>
      <form id="checkout-form" onsubmit="return false;">
        <label>Full Name <input id="inp-name" type="text" name="name" autocomplete="name" placeholder="Aarav Sharma" /></label>
        <label>Email <input id="inp-email" type="email" name="email" autocomplete="email" placeholder="aarav@example.com" /></label>
        <label>Phone <input id="inp-phone" type="tel" name="phone" autocomplete="tel" placeholder="+91 98765 43210" /></label>
        <label>Password <input id="inp-pwd" type="password" name="password" autocomplete="current-password" /></label>
        <label>Shipping Address <input id="inp-addr" type="text" name="address" autocomplete="street-address" placeholder="221B Residency Road" /></label>
        <label>Card Number <input id="inp-card" type="text" name="card_number" autocomplete="cc-number" placeholder="4111 1111 1111 1111" /></label>
        <label>Product
          <select id="sel-prod" name="product">
            <option value="flight-del-bom">Flight — DEL to BOM, tomorrow</option>
            <option value="flight-del-blr">Flight — DEL to BLR, tomorrow</option>
          </select>
        </label>
        <button id="submit-btn" type="submit">Place Order</button>
      </form>
    `;

    // Step 1: Initial Page State Capture
    const state1 = captureDomState("task-flow-1");
    expect(state1.elements).toHaveLength(9);
    const submitEl1 = state1.elements.find((e) => e.role === "button");
    expect(submitEl1?.label).toBe("Place Order");

    // Step 2: Agent fills form in DOM (values updated)
    (document.getElementById("inp-name") as HTMLInputElement).value = "CustomTypedName";
    (document.getElementById("inp-email") as HTMLInputElement).value = "custom_typed@example.com";
    (document.getElementById("inp-pwd") as HTMLInputElement).value = "secret_typed_password_123";

    // Step 3: Perception capture after input retains privacy (no raw typed values in perception state)
    const state2 = captureDomState("task-flow-2");
    const jsonState2 = JSON.stringify(state2);
    expect(jsonState2).not.toContain("CustomTypedName");
    expect(jsonState2).not.toContain("custom_typed@example.com");
    expect(jsonState2).not.toContain("secret_typed_password_123");

    // Step 4: Submission simulation (mock site click handler updates text)
    const submitBtn = document.getElementById("submit-btn")!;
    submitBtn.textContent = "Order placed (demo only)";

    // Step 5: Post-submission perception capture
    const state3 = captureDomState("task-flow-3");
    const submitEl3 = state3.elements.find((e) => e.role === "button");
    expect(submitEl3?.label).toBe("Order placed (demo only)");
    expect(submitEl3?.elementId).toBe(submitEl1?.elementId); // Retains identical element ID
  });

  it("31. [Phase 3 - Performance Hardening] Synthetic DOM scaling benchmarks (10, 50, 100, 250 elements)", () => {
    const scales = [10, 50, 100, 250];
    const results: Record<number, { min: number; max: number; avg: number; size: number }> = {};

    for (const count of scales) {
      document.body.innerHTML = "";
      const container = document.createElement("div");
      for (let i = 0; i < count; i++) {
        const label = document.createElement("label");
        label.textContent = `Field ${i}`;
        const input = document.createElement("input");
        input.type = i % 2 === 0 ? "text" : "email";
        input.placeholder = `Placeholder ${i}`;
        label.appendChild(input);
        container.appendChild(label);
      }
      document.body.appendChild(container);

      const iterations = 30;
      const times: number[] = [];

      for (let j = 0; j < iterations; j++) {
        const start = performance.now();
        const state = captureDomState(`task-scale-${count}-${j}`);
        const duration = performance.now() - start;
        times.push(duration);
        expect(state.elements).toHaveLength(count);
      }

      const minTime = Math.min(...times);
      const maxTime = Math.max(...times);
      const avgTime = times.reduce((a, b) => a + b, 0) / iterations;

      const sampleState = captureDomState(`task-scale-${count}-sample`);
      const payloadSize = new TextEncoder().encode(JSON.stringify(sampleState)).length;

      results[count] = { min: minTime, max: maxTime, avg: avgTime, size: payloadSize };

      console.log(
        `[Phase 3 Benchmark] Scale=${count} elements: min=${minTime.toFixed(3)}ms, max=${maxTime.toFixed(3)}ms, avg=${avgTime.toFixed(3)}ms, payload=${payloadSize} bytes`
      );

      // Sanity checks: scaling remains sub-linear / efficient
      expect(avgTime).toBeLessThan(100);
    }
  });
});
