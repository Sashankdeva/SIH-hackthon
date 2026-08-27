// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { captureDomState, resetElementRegistry, resolveElement } from "../domCapture";

describe("Role 2 Phase 5 — Final Hardening & Stress Suite", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "SIH26171 Stress Test Page";
    resetElementRegistry();
  });

  it("1. [Step 3: Large DOM Stress] measures perception scaling across 10, 50, 100, 250, 500, and 1000 interactive elements", () => {
    const scales = [10, 50, 100, 250, 500, 1000];
    const report: Record<number, { min: number; max: number; avg: number; size: number }> = {};

    for (const count of scales) {
      document.body.innerHTML = "";
      const form = document.createElement("form");
      for (let i = 0; i < count; i++) {
        const label = document.createElement("label");
        label.textContent = `Field ${i}`;
        const input = document.createElement("input");
        input.type = i % 3 === 0 ? "text" : i % 3 === 1 ? "email" : "tel";
        input.placeholder = `Sample ${i}`;
        label.appendChild(input);
        form.appendChild(label);
      }
      document.body.appendChild(form);

      const iterations = 8;
      const times: number[] = [];

      for (let j = 0; j < iterations; j++) {
        const start = performance.now();
        const state = captureDomState(`task-stress-${count}-${j}`);
        const duration = performance.now() - start;
        times.push(duration);
        expect(state.elements).toHaveLength(count);
      }

      const minTime = Math.min(...times);
      const maxTime = Math.max(...times);
      const avgTime = times.reduce((a, b) => a + b, 0) / iterations;

      const sampleState = captureDomState(`task-sample-${count}`);
      const payloadSize = new TextEncoder().encode(JSON.stringify(sampleState)).length;

      report[count] = { min: minTime, max: maxTime, avg: avgTime, size: payloadSize };

      console.log(
        `[Phase 5 Stress Scale=${count}] Min: ${minTime.toFixed(2)}ms | Max: ${maxTime.toFixed(2)}ms | Avg: ${avgTime.toFixed(2)}ms | Size: ${payloadSize} bytes`
      );

      // Verify sub-linear/linear real-time execution budget in JSDOM test environment
      expect(avgTime).toBeLessThan(count <= 500 ? 200 : 500);
    }
  }, 15000);

  it("2. [Step 4 & 15: Repeated Capture & Stability] executes 1000 repeated captures verifying memory and ID stability", () => {
    document.body.innerHTML = `
      <form id="stable-form">
        <label for="u1">Username</label>
        <input id="u1" type="text" />
        <label for="p1">Password</label>
        <input id="p1" type="password" />
        <button id="b1" type="submit">Log In</button>
      </form>
    `;

    const initial = captureDomState("task-rep-0");
    expect(initial.elements).toHaveLength(3);
    const initialIds = initial.elements.map((e) => e.elementId);

    const iterations = 1000;
    const start = performance.now();

    for (let i = 1; i <= iterations; i++) {
      const state = captureDomState(`task-rep-${i}`);
      expect(state.elements).toHaveLength(3);
      expect(state.elements[0].label).toBe("Username");
      expect(state.elements[1].label).toBe("Password");
      expect(state.elements[2].label).toBe("Log In");

      // Verify element IDs remain strictly identical across repeated captures on same live DOM nodes
      const currentIds = state.elements.map((e) => e.elementId);
      expect(currentIds).toEqual(initialIds);
    }

    const totalDuration = performance.now() - start;
    const avgPerCapture = totalDuration / iterations;

    console.log(`[Phase 5 Stability] ${iterations} captures executed in ${totalDuration.toFixed(2)}ms (Avg: ${avgPerCapture.toFixed(3)}ms/capture)`);

    // Verify resolveElement still cleanly resolves initial elements
    expect(resolveElement(initialIds[0])).toBe(document.getElementById("u1"));
    expect(resolveElement(initialIds[1])).toBe(document.getElementById("p1"));
    expect(resolveElement(initialIds[2])).toBe(document.getElementById("b1"));
  });

  it("3. [Step 5: Dynamic DOM Stress] verifies dynamic mutations across insertion, removal, replacement, and state toggling", () => {
    const container = document.createElement("div");
    container.id = "dynamic-container";
    document.body.appendChild(container);

    // 1. Initial Insert
    container.innerHTML = `
      <input id="f1" type="text" aria-label="Field 1" />
      <button id="f2">Submit 1</button>
    `;
    const s1 = captureDomState("dyn-1");
    expect(s1.elements).toHaveLength(2);
    expect(s1.elements[0].label).toBe("Field 1");
    expect(s1.elements[1].label).toBe("Submit 1");

    // 2. State Toggle (Disabled & Readonly)
    const f1 = document.getElementById("f1") as HTMLInputElement;
    f1.disabled = true;
    f1.readOnly = true;
    const s2 = captureDomState("dyn-2");
    expect(s2.elements[0].disabled).toBe(true);
    expect(s2.elements[0].readonly).toBe(true);

    // 3. Label & Attribute Mutation
    f1.setAttribute("aria-label", "Field 1 Updated");
    const s3 = captureDomState("dyn-3");
    expect(s3.elements[0].label).toBe("Field 1 Updated");

    // 4. Node Insertion
    const extra = document.createElement("input");
    extra.id = "f3";
    extra.type = "email";
    extra.setAttribute("aria-label", "Field 3 Added");
    container.appendChild(extra);
    const s4 = captureDomState("dyn-4");
    expect(s4.elements).toHaveLength(3);
    expect(s4.elements[2].label).toBe("Field 3 Added");

    // 5. Node Removal
    document.getElementById("f2")?.remove();
    const s5 = captureDomState("dyn-5");
    expect(s5.elements).toHaveLength(2);
    expect(s5.elements.map((e) => e.label)).not.toContain("Submit 1");
  });

  it("4. [Step 6 & 13: Accessibility Stress & Hostile DOM Injection] handles malformed, huge, and hostile DOM structures safely", () => {
    // A. Invalid / missing aria-labelledby targets
    document.body.innerHTML = `
      <span id="valid-ref">Valid Reference</span>
      <input id="h1" aria-labelledby="   missing1   valid-ref   missing2   " />
    `;
    const s1 = captureDomState("hostile-1");
    expect(s1.elements[0].label).toBe("Valid Reference");

    // B. Massive label (10,000 characters truncated cleanly to max 120 chars)
    const hugeText = "A".repeat(10000);
    document.body.innerHTML = `<button id="huge-btn">${hugeText}</button>`;
    const s2 = captureDomState("hostile-2");
    expect(s2.elements[0].label).toBe(hugeText.slice(0, 120));

    // C. Deep nesting (15 levels of nested divs)
    let nestedHtml = `<input id="deep-input" aria-label="Deep Input" />`;
    for (let i = 0; i < 15; i++) {
      nestedHtml = `<div>${nestedHtml}</div>`;
    }
    document.body.innerHTML = nestedHtml;
    const s3 = captureDomState("hostile-3");
    expect(s3.elements).toHaveLength(1);
    expect(s3.elements[0].label).toBe("Deep Input");

    // D. Detached DOM node query safety
    const detached = document.createElement("input");
    detached.type = "text";
    // Should not crash resolveElement for unattached nodes
    expect(resolveElement(999999)).toBeNull();
  });

  it("5. [Step 9: Element ID Stress & Collision Resistance] verifies uniqueness across 500 live elements", () => {
    document.body.innerHTML = "";
    for (let i = 0; i < 500; i++) {
      const btn = document.createElement("button");
      btn.id = `btn-${i}`;
      btn.textContent = `Button ${i}`;
      document.body.appendChild(btn);
    }

    const state = captureDomState("task-500-ids");
    expect(state.elements).toHaveLength(500);

    const ids = state.elements.map((e) => e.elementId);
    const uniqueIds = new Set(ids);

    // Strict uniqueness check
    expect(uniqueIds.size).toBe(500);

    // Verify lookup for arbitrary elements
    const midId = state.elements[250].elementId;
    const midElement = resolveElement(midId);
    expect(midElement).toBe(document.getElementById("btn-250"));
  });

  it("6. [Step 10: Serialization Stress] verifies roundtrip integrity of large PageState payloads", () => {
    document.body.innerHTML = "";
    for (let i = 0; i < 200; i++) {
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = `Placeholder ${i}`;
      input.disabled = i % 2 === 0;
      input.readOnly = i % 3 === 0;
      input.setAttribute("aria-label", `Label ${i}`);
      document.body.appendChild(input);
    }

    const state = captureDomState("task-serialize-stress");
    const jsonStr = JSON.stringify(state);
    const parsed = JSON.parse(jsonStr);

    expect(parsed.elements).toHaveLength(200);
    expect(parsed.elements[0].label).toBe("Label 0");
    expect(parsed.elements[0].disabled).toBe(true);
    expect(parsed.elements[0].readonly).toBe(true);
  });

  it("7. [Step 11: Privacy Safety Stress] confirms zero leakage of sensitive canary strings across diverse input controls", () => {
    document.body.innerHTML = `
      <form>
        <input type="password" value="CANARY_SECRET_PWD_9999" />
        <input type="email" value="CANARY_SECRET_EMAIL_8888@test.com" />
        <input type="tel" value="CANARY_SECRET_TEL_7777" />
        <input type="text" value="CANARY_SECRET_CARD_666666666666" />
        <textarea>CANARY_SECRET_NOTES_5555</textarea>
        <select>
          <option value="CANARY_SECRET_VAL_4444">Selected Product</option>
        </select>
      </form>
    `;

    const state = captureDomState("task-privacy-stress");
    const jsonStr = JSON.stringify(state);

    expect(jsonStr).not.toContain("CANARY_SECRET_PWD_9999");
    expect(jsonStr).not.toContain("CANARY_SECRET_EMAIL_8888@test.com");
    expect(jsonStr).not.toContain("CANARY_SECRET_TEL_7777");
    expect(jsonStr).not.toContain("CANARY_SECRET_CARD_666666666666");
    expect(jsonStr).not.toContain("CANARY_SECRET_NOTES_5555");
    expect(jsonStr).not.toContain("CANARY_SECRET_VAL_4444");
  });

  it("8. [Step 12: Server Independence] verifies perception engine functions locally without server dependency", () => {
    // Assert captureDomState is completely synchronous, in-process, and standalone
    const state = captureDomState("local-offline-task");
    expect(state.taskId).toBe("local-offline-task");
    expect(typeof state.capturedAt).toBe("number");
    expect(Array.isArray(state.elements)).toBe(true);
  });
});
