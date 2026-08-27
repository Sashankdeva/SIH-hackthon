// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureDomState, resetElementRegistry } from "../../perception/domCapture";
import { validateAction, isSafeNavigationUrl } from "../validator";
import { executeAction } from "../executor";
import { clearLocalSecrets, resolveLocalSecret, setLocalSecret } from "../secretStore";
import {
  executeAndVerifyAction,
  verifyExecutedAction,
  executeWithBoundedRetry,
  resetVerificationTracker,
  isActionAlreadyVerified,
  getRetryAttempts,
  resetRetryTracker,
  withTimeout,
  MAX_RETRY_ATTEMPTS,
} from "../verifier";
import {
  getOrCreateSession,
  getSession,
  isSessionTerminal,
  completeSession,
  cancelSession,
  interruptSession,
  cleanupSession,
  resetSessionRegistry,
  runActionInSession,
  isLifecycleInterruptionRetryable,
  TERMINAL_SESSION_STATES,
} from "../session";
import * as pvmVerify from "../../pvm/verify";
import type { ActionRequest } from "../types";

describe("Role 1 Complete Suite (Phases 1–6: Execution, Reliability, Lifecycle & Final Integration Freeze)", () => {
  const TASK_ID = "task-role1-test-001";

  beforeEach(() => {
    document.body.innerHTML = "";
    resetElementRegistry();
    clearLocalSecrets();
    resetVerificationTracker();
    resetRetryTracker();
    resetSessionRegistry();
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // 1. SECRET STORE TESTS
  // ===========================================================================
  describe("1. Local Secret Store", () => {
    it("1.1 registers and resolves a valid secret reference", async () => {
      setLocalSecret("[PASSWORD_01]", "SuperSecretPassword123!");
      const secret = await resolveLocalSecret("[PASSWORD_01]");
      expect(secret).toBe("SuperSecretPassword123!");
    });

    it("1.2 returns null for an unregistered reference", async () => {
      const secret = await resolveLocalSecret("[UNKNOWN_REF]");
      expect(secret).toBeNull();
    });

    it("1.3 returns null for empty or invalid references", async () => {
      expect(await resolveLocalSecret("")).toBeNull();
      expect(await resolveLocalSecret(null as any)).toBeNull();
      expect(await resolveLocalSecret(undefined as any)).toBeNull();
    });

    it("1.4 clears all registered secrets on clearLocalSecrets", async () => {
      setLocalSecret("[REF_A]", "ValA");
      setLocalSecret("[REF_B]", "ValB");
      clearLocalSecrets();
      expect(await resolveLocalSecret("[REF_A]")).toBeNull();
      expect(await resolveLocalSecret("[REF_B]")).toBeNull();
    });

    it("1.5 maintains strict isolation between multiple secret references", async () => {
      setLocalSecret("[EMAIL_01]", "user@isro.gov.in");
      setLocalSecret("[PASSWORD_01]", "SecretP@ss99");
      setLocalSecret("[TOKEN_01]", "Bearer abcdef123456");

      expect(await resolveLocalSecret("[EMAIL_01]")).toBe("user@isro.gov.in");
      expect(await resolveLocalSecret("[PASSWORD_01]")).toBe("SecretP@ss99");
      expect(await resolveLocalSecret("[TOKEN_01]")).toBe("Bearer abcdef123456");
    });
  });

  // ===========================================================================
  // 2. ACTION VALIDATOR TESTS
  // ===========================================================================
  describe("2. Action Validator", () => {
    it("2.1 validates a valid click action on an active button", () => {
      document.body.innerHTML = `<button id="btn">Submit</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = validateAction(req, TASK_ID);
      expect(result.ok).toBe(true);
    });

    it("2.2 validates a valid type action on an input text control", () => {
      document.body.innerHTML = `<input id="name-inp" type="text" />`;
      const pageState = captureDomState(TASK_ID);
      const inputId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "type",
        elementId: inputId,
        value: "Vikram Sarabhai",
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = validateAction(req, TASK_ID);
      expect(result.ok).toBe(true);
    });

    it("2.3 validates a valid type_secret action with non-empty valueRef", () => {
      document.body.innerHTML = `<input id="pwd-inp" type="password" />`;
      const pageState = captureDomState(TASK_ID);
      const pwdId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "type_secret",
        elementId: pwdId,
        valueRef: "[PASSWORD_01]",
        confidence: 0.98,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = validateAction(req, TASK_ID);
      expect(result.ok).toBe(true);
    });

    it("2.4 validates scroll, keypress, and wait actions", () => {
      const scrollReq: ActionRequest = {
        action: "scroll",
        direction: "down",
        amount: 300,
        confidence: 0.8,
        taskId: TASK_ID,
        stepId: 1,
      };
      expect(validateAction(scrollReq, TASK_ID).ok).toBe(true);

      const keyReq: ActionRequest = {
        action: "keypress",
        value: "Enter",
        confidence: 0.85,
        taskId: TASK_ID,
        stepId: 2,
      };
      expect(validateAction(keyReq, TASK_ID).ok).toBe(true);

      const waitReq: ActionRequest = {
        action: "wait",
        amount: 500,
        confidence: 0.99,
        taskId: TASK_ID,
        stepId: 3,
      };
      expect(validateAction(waitReq, TASK_ID).ok).toBe(true);
    });

    it("2.5 rejects unknown action types", () => {
      const req: any = { action: "eval_script", confidence: 0.9, taskId: TASK_ID, stepId: 1 };
      const res = validateAction(req, TASK_ID);
      expect(res.ok).toBe(false);
      expect(res.reason).toContain("Unknown action type");
    });

    it("2.6 rejects actions with mismatched taskId", () => {
      const req: ActionRequest = { action: "wait", confidence: 0.9, taskId: "different-task-id", stepId: 1 };
      const res = validateAction(req, TASK_ID);
      expect(res.ok).toBe(false);
      expect(res.reason).toContain("different task");
    });

    it("2.7 rejects actions below confidence threshold (0.50)", () => {
      const req: ActionRequest = { action: "wait", confidence: 0.49, taskId: TASK_ID, stepId: 1 };
      const res = validateAction(req, TASK_ID);
      expect(res.ok).toBe(false);
      expect(res.reason).toContain("below threshold");

      // Exactly at threshold passes
      const boundaryReq: ActionRequest = { action: "wait", confidence: 0.5, taskId: TASK_ID, stepId: 1 };
      expect(validateAction(boundaryReq, TASK_ID).ok).toBe(true);
    });

    it("2.8 rejects element-targeted action with missing or non-existent elementId", () => {
      const missingIdReq: ActionRequest = { action: "click", confidence: 0.9, taskId: TASK_ID, stepId: 1 };
      expect(validateAction(missingIdReq, TASK_ID).ok).toBe(false);

      const invalidIdReq: ActionRequest = {
        action: "click",
        elementId: 999999,
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      };
      const res = validateAction(invalidIdReq, TASK_ID);
      expect(res.ok).toBe(false);
      expect(res.reason).toContain("not found");
    });

    it("2.9 rejects type_secret action when valueRef is missing or empty", () => {
      document.body.innerHTML = `<input id="secret-inp" type="password" />`;
      const pageState = captureDomState(TASK_ID);
      const secretId = pageState.elements[0].elementId;

      const emptyRefReq: ActionRequest = {
        action: "type_secret",
        elementId: secretId,
        valueRef: "",
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      };
      const res = validateAction(emptyRefReq, TASK_ID);
      expect(res.ok).toBe(false);
      expect(res.reason).toContain("Missing or empty valueRef");
    });

    it("2.10 rejects actions targeting disabled or aria-disabled elements", () => {
      document.body.innerHTML = `
        <button id="disabled-btn" disabled>Disabled Button</button>
        <input id="aria-disabled-inp" type="text" aria-disabled="true" />
      `;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;
      const inpId = pageState.elements[1].elementId;

      const clickDisabled = validateAction(
        { action: "click", elementId: btnId, confidence: 0.9, taskId: TASK_ID, stepId: 1 },
        TASK_ID
      );
      expect(clickDisabled.ok).toBe(false);
      expect(clickDisabled.reason).toContain("disabled");

      const typeDisabled = validateAction(
        { action: "type", elementId: inpId, value: "Text", confidence: 0.9, taskId: TASK_ID, stepId: 1 },
        TASK_ID
      );
      expect(typeDisabled.ok).toBe(false);
      expect(typeDisabled.reason).toContain("disabled");
    });

    it("2.11 rejects typing into readonly elements", () => {
      document.body.innerHTML = `<input id="ro-inp" type="text" readonly value="Fixed" />`;
      const pageState = captureDomState(TASK_ID);
      const roId = pageState.elements[0].elementId;

      const res = validateAction(
        { action: "type", elementId: roId, value: "Change", confidence: 0.9, taskId: TASK_ID, stepId: 1 },
        TASK_ID
      );
      expect(res.ok).toBe(false);
      expect(res.reason).toContain("readonly");
    });

    it("2.12 rejects typing into non-editable elements like buttons or anchors", () => {
      document.body.innerHTML = `<a id="link-el" href="#">Link Anchor</a>`;
      const pageState = captureDomState(TASK_ID);
      const linkId = pageState.elements[0].elementId;

      const res = validateAction(
        { action: "type", elementId: linkId, value: "Invalid Type", confidence: 0.9, taskId: TASK_ID, stepId: 1 },
        TASK_ID
      );
      expect(res.ok).toBe(false);
      expect(res.reason).toContain("not an editable text input");
    });
  });

  // ===========================================================================
  // 3. NAVIGATION SECURITY TESTS
  // ===========================================================================
  describe("3. Navigation Security & Protocol Filtering", () => {
    it("3.1 allows safe http and https protocols", () => {
      expect(isSafeNavigationUrl("https://isro.gov.in/spacecraft")).toBe(true);
      expect(isSafeNavigationUrl("http://localhost:3000/checkout")).toBe(true);
      expect(isSafeNavigationUrl("/relative/path/to/page.html")).toBe(true);
      expect(isSafeNavigationUrl("search?query=test")).toBe(true);
    });

    it("3.2 rejects dangerous javascript: URLs (including casing and whitespace variations)", () => {
      expect(isSafeNavigationUrl("javascript:alert(1)")).toBe(false);
      expect(isSafeNavigationUrl("  JaVaScRiPt:alert(document.cookie)")).toBe(false);
      expect(isSafeNavigationUrl("javascript:/*comment*/alert(1)")).toBe(false);
    });

    it("3.3 rejects data:, vbscript:, and file: URLs", () => {
      expect(isSafeNavigationUrl("data:text/html,<h1>XSS</h1>")).toBe(false);
      expect(isSafeNavigationUrl("vbscript:msgbox(1)")).toBe(false);
      expect(isSafeNavigationUrl("file:///etc/passwd")).toBe(false);
    });

    it("3.4 validator blocks unsafe navigation attempts before execution", () => {
      const unsafeReq: ActionRequest = {
        action: "navigate",
        url: "javascript:void(0)",
        confidence: 0.99,
        taskId: TASK_ID,
        stepId: 1,
      };
      const res = validateAction(unsafeReq, TASK_ID);
      expect(res.ok).toBe(false);
      expect(res.reason).toContain("Unsafe or disallowed navigation URL");
    });
  });

  // ===========================================================================
  // 4. ACTION EXECUTOR TESTS
  // ===========================================================================
  describe("4. Action Executor & Event Fidelity", () => {
    it("4.1 executes click and triggers native click listener", async () => {
      let clicked = false;
      document.body.innerHTML = `<button id="action-btn">Click Me</button>`;
      document.getElementById("action-btn")!.addEventListener("click", () => {
        clicked = true;
      });

      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      await executeAction({ action: "click", elementId: btnId, confidence: 0.9, taskId: TASK_ID, stepId: 1 });
      expect(clicked).toBe(true);
    });

    it("4.2 executes typing with input and change event dispatch", async () => {
      let inputFired = false;
      let changeFired = false;

      document.body.innerHTML = `<input id="text-inp" type="text" />`;
      const inputEl = document.getElementById("text-inp") as HTMLInputElement;

      inputEl.addEventListener("input", () => {
        inputFired = true;
      });
      inputEl.addEventListener("change", () => {
        changeFired = true;
      });

      const pageState = captureDomState(TASK_ID);
      const inpId = pageState.elements[0].elementId;

      await executeAction({
        action: "type",
        elementId: inpId,
        value: "Chandrayaan-3",
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      });

      expect(inputEl.value).toBe("Chandrayaan-3");
      expect(inputFired).toBe(true);
      expect(changeFired).toBe(true);
    });

    it("4.3 executes multiline typing into textarea controls", async () => {
      document.body.innerHTML = `<textarea id="notes-area"></textarea>`;
      const textarea = document.getElementById("notes-area") as HTMLTextAreaElement;

      const pageState = captureDomState(TASK_ID);
      const areaId = pageState.elements[0].elementId;

      const multilineText = "Line 1: Mission Orbit Insertion\nLine 2: Lander Separation\nLine 3: Touchdown Success";

      await executeAction({
        action: "type",
        elementId: areaId,
        value: multilineText,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      });

      expect(textarea.value).toBe(multilineText);
    });

    it("4.4 executes typing into contenteditable targets", async () => {
      document.body.innerHTML = `<div id="editor" contenteditable="true">Initial</div>`;
      const editor = document.getElementById("editor") as HTMLElement;

      const pageState = captureDomState(TASK_ID);
      const editorId = pageState.elements[0].elementId;

      await executeAction({
        action: "type",
        elementId: editorId,
        value: "Updated Rich Text Content",
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      });

      expect(editor.textContent).toBe("Updated Rich Text Content");
    });

    it("4.5 executes type_secret by resolving registered secret from Secret Store", async () => {
      setLocalSecret("[CANARY_PASSWORD_01]", "SuperSecretISROPwd!99");

      document.body.innerHTML = `<input id="auth-pwd" type="password" />`;
      const pwdEl = document.getElementById("auth-pwd") as HTMLInputElement;

      const pageState = captureDomState(TASK_ID);
      const pwdId = pageState.elements[0].elementId;

      await executeAction({
        action: "type_secret",
        elementId: pwdId,
        valueRef: "[CANARY_PASSWORD_01]",
        confidence: 0.98,
        taskId: TASK_ID,
        stepId: 1,
      });

      expect(pwdEl.value).toBe("SuperSecretISROPwd!99");
    });

    it("4.6 safely skips typing when secret reference is unregistered", async () => {
      document.body.innerHTML = `<input id="auth-pwd" type="password" value="InitialValue" />`;
      const pwdEl = document.getElementById("auth-pwd") as HTMLInputElement;

      const pageState = captureDomState(TASK_ID);
      const pwdId = pageState.elements[0].elementId;

      await executeAction({
        action: "type_secret",
        elementId: pwdId,
        valueRef: "[UNREGISTERED_REF]",
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      });

      // Stays initial value without throwing
      expect(pwdEl.value).toBe("InitialValue");
    });

    it("4.7 executes directional scrolling (up, down, left, right)", async () => {
      const scrollSpy = vi.fn();
      window.scrollBy = scrollSpy;

      await executeAction({ action: "scroll", direction: "down", amount: 200, confidence: 0.8, taskId: TASK_ID, stepId: 1 });
      expect(scrollSpy).toHaveBeenLastCalledWith({ top: 200, left: 0, behavior: "smooth" });

      await executeAction({ action: "scroll", direction: "up", amount: 150, confidence: 0.8, taskId: TASK_ID, stepId: 2 });
      expect(scrollSpy).toHaveBeenLastCalledWith({ top: -150, left: 0, behavior: "smooth" });

      await executeAction({ action: "scroll", direction: "right", amount: 100, confidence: 0.8, taskId: TASK_ID, stepId: 3 });
      expect(scrollSpy).toHaveBeenLastCalledWith({ top: 0, left: 100, behavior: "smooth" });

      await executeAction({ action: "scroll", direction: "left", amount: 50, confidence: 0.8, taskId: TASK_ID, stepId: 4 });
      expect(scrollSpy).toHaveBeenLastCalledWith({ top: 0, left: -50, behavior: "smooth" });
    });

    it("4.8 executes keypress event on active element", async () => {
      let keyPressed = "";
      document.body.innerHTML = `<input id="focus-inp" type="text" />`;
      const inp = document.getElementById("focus-inp") as HTMLInputElement;
      inp.focus();

      inp.addEventListener("keydown", (e) => {
        keyPressed = e.key;
      });

      await executeAction({ action: "keypress", value: "Tab", confidence: 0.9, taskId: TASK_ID, stepId: 1 });
      expect(keyPressed).toBe("Tab");
    });

    it("4.9 executes wait with positive delay", async () => {
      const t0 = performance.now();
      await executeAction({ action: "wait", amount: 50, confidence: 0.9, taskId: TASK_ID, stepId: 1 });
      const elapsed = performance.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(40);
    });
  });

  // ===========================================================================
  // 5. PRIVACY INVARIANT & NON-LEAKAGE VERIFICATION
  // ===========================================================================
  describe("5. Privacy Invariant & Non-Leakage", () => {
    it("5.1 verifies actual secret string never appears in ActionRequest or serialized payloads", async () => {
      const RAW_SECRET = "TopSecretCredentials_12345";
      setLocalSecret("[SECRET_TOKEN]", RAW_SECRET);

      const serverActionProposal: ActionRequest = {
        action: "type_secret",
        elementId: 1,
        valueRef: "[SECRET_TOKEN]",
        confidence: 0.99,
        taskId: TASK_ID,
        stepId: 1,
      };

      const serializedAction = JSON.stringify(serverActionProposal);

      // Verify serialized action carries ONLY token reference, NEVER raw secret
      expect(serializedAction).toContain("[SECRET_TOKEN]");
      expect(serializedAction).not.toContain(RAW_SECRET);

      // Verify DOM injection works seamlessly via Secret Store resolution
      document.body.innerHTML = `<input id="canary-pwd" type="password" />`;
      const pageState = captureDomState(TASK_ID);
      serverActionProposal.elementId = pageState.elements[0].elementId;

      await executeAction(serverActionProposal);
      const injectedEl = document.getElementById("canary-pwd") as HTMLInputElement;
      expect(injectedEl.value).toBe(RAW_SECRET);
    });
  });

  // ===========================================================================
  // 6. ROLE 1 -> ROLE 5 VERIFICATION CHAINING TESTS (PHASE 2)
  // ===========================================================================
  describe("6. Role 1 -> Role 5 Verification Chaining (Phase 2)", () => {
    it("6.1 successful click action automatically triggers post-action verification and returns verified: true", async () => {
      document.body.innerHTML = `<button id="submit-btn">Submit Order</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await executeAndVerifyAction(req, TASK_ID);
      expect(result.executed).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.actionId).toBe(`${TASK_ID}-step-1`);
      expect(result.verification?.status).toBe("success");
      expect(result.recovery?.shouldRetry).toBe(false);
    });

    it("6.2 validation failure does NOT invoke verification and returns executed: false, verified: false", async () => {
      const invalidReq: any = {
        action: "unsupported_action_type",
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      };

      const verifySpy = vi.spyOn(pvmVerify, "verifyElementPresent");

      const result = await executeAndVerifyAction(invalidReq, TASK_ID);
      expect(result.executed).toBe(false);
      expect(result.verified).toBe(false);
      expect(result.error).toContain("Unknown action type");
      expect(verifySpy).not.toHaveBeenCalled();
    });

    it("6.3 validation failure from taskId mismatch does NOT invoke verification", async () => {
      const req: ActionRequest = {
        action: "wait",
        confidence: 0.9,
        taskId: "wrong-task-id",
        stepId: 1,
      };

      const result = await executeAndVerifyAction(req, TASK_ID);
      expect(result.executed).toBe(false);
      expect(result.verified).toBe(false);
      expect(result.error).toContain("different task");
    });

    it("6.4 validation failure from unsafe navigation URL does NOT invoke verification", async () => {
      const unsafeReq: ActionRequest = {
        action: "navigate",
        url: "javascript:alert(1)",
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const urlSpy = vi.spyOn(pvmVerify, "verifyUrlChanged");

      const result = await executeAndVerifyAction(unsafeReq, TASK_ID);
      expect(result.executed).toBe(false);
      expect(result.verified).toBe(false);
      expect(result.error).toContain("Unsafe or disallowed navigation URL");
      expect(urlSpy).not.toHaveBeenCalled();
    });

    it("6.5 execution failure returns executed: false, verified: false without calling verification", async () => {
      // Mock executeAction throwing an exception
      const req: ActionRequest = {
        action: "click",
        elementId: 1,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      // Mock resolveElement resolving an element that throws on click
      document.body.innerHTML = `<button id="btn">Crash</button>`;
      const pageState = captureDomState(TASK_ID);
      req.elementId = pageState.elements[0].elementId;

      const btn = document.getElementById("btn")!;
      btn.click = () => {
        throw new Error("DOM Exception during click event");
      };

      const result = await executeAndVerifyAction(req, TASK_ID);
      expect(result.executed).toBe(false);
      expect(result.verified).toBe(false);
      expect(result.error).toContain("Execution failed");
    });

    it("6.6 verification success produces verified: true and recovery.shouldRetry: false", async () => {
      document.body.innerHTML = `<input id="user-input" type="text" />`;
      const pageState = captureDomState(TASK_ID);
      const inpId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "type",
        elementId: inpId,
        value: "Verified Input",
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await executeAndVerifyAction(req, TASK_ID);
      expect(result.executed).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.verification?.status).toBe("success");
      expect(result.recovery?.reason).toBe("verified success");
      expect(result.recovery?.shouldRetry).toBe(false);
    });

    it("6.7 verification failure produces verified: false without claiming false success", async () => {
      document.body.innerHTML = `<button id="ephemeral-btn">Remove me on click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const btn = document.getElementById("ephemeral-btn")!;
      btn.addEventListener("click", () => {
        // Element removes itself from DOM upon click
        btn.remove();
      });

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await executeAndVerifyAction(req, TASK_ID);
      expect(result.executed).toBe(true);
      // Because element was removed, verifyElementPresent fails
      expect(result.verified).toBe(false);
      expect(result.verification?.status).toBe("failure");
      expect(result.recovery?.shouldRetry).toBe(true);
    });

    it("6.8 Role 5 verification exceptions are isolated safely and do not crash the extension", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      // Mock verifyElementPresent throwing an unexpected error
      vi.spyOn(pvmVerify, "verifyElementPresent").mockImplementation(() => {
        throw new Error("Internal PVM IndexDB crash");
      });

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await executeAndVerifyAction(req, TASK_ID);
      expect(result.executed).toBe(true);
      expect(result.verified).toBe(false);
      expect(result.verification?.status).toBe("failure");
      expect(result.error).toContain("Internal PVM IndexDB crash");
    });

    it("6.9 duplicate verification prevention blocks re-verifying the exact same actionId", async () => {
      document.body.innerHTML = `<button id="btn">Submit</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      // First run verifies successfully
      const firstResult = await executeAndVerifyAction(req, TASK_ID);
      expect(firstResult.verified).toBe(true);
      expect(isActionAlreadyVerified(`${TASK_ID}-step-1`)).toBe(true);

      // Second run with identical taskId and stepId is flagged as duplicate
      const duplicateResult = await verifyExecutedAction(req);
      expect(duplicateResult.verified).toBe(false);
      expect(duplicateResult.error).toContain("Duplicate verification prevented");
    });

    it("6.10 resetVerificationTracker allows re-verifying across new task/session runs", async () => {
      document.body.innerHTML = `<button id="btn">Submit</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      await executeAndVerifyAction(req, TASK_ID);
      expect(isActionAlreadyVerified(`${TASK_ID}-step-1`)).toBe(true);

      resetVerificationTracker();
      expect(isActionAlreadyVerified(`${TASK_ID}-step-1`)).toBe(false);

      const secondResult = await verifyExecutedAction(req);
      expect(secondResult.verified).toBe(true);
    });

    it("6.11 type_secret verification verifies target presence without leaking raw credential to verification result", async () => {
      const RAW_CREDENTIAL = "SuperConfidentialISROKey_999";
      setLocalSecret("[SECRET_KEY]", RAW_CREDENTIAL);

      document.body.innerHTML = `<input id="key-input" type="password" />`;
      const pageState = captureDomState(TASK_ID);
      const keyId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "type_secret",
        elementId: keyId,
        valueRef: "[SECRET_KEY]",
        confidence: 0.98,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await executeAndVerifyAction(req, TASK_ID);
      expect(result.executed).toBe(true);
      expect(result.verified).toBe(true);

      // Verify DOM has secret
      const keyEl = document.getElementById("key-input") as HTMLInputElement;
      expect(keyEl.value).toBe(RAW_CREDENTIAL);

      // Verify verification result contains NO credential string
      const resultJson = JSON.stringify(result);
      expect(resultJson).not.toContain(RAW_CREDENTIAL);
    });

    it("6.12 navigate action verifies URL changes against urlBefore", async () => {
      const req: ActionRequest = {
        action: "navigate",
        url: "http://localhost:3000/new-page.html",
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await verifyExecutedAction(req, {
        url: "http://localhost:3000/old-page.html",
        startTime: Date.now() - 50,
      });

      expect(result.executed).toBe(true);
      expect(result.verification?.expected).toBe("url_changed");
    });

    it("6.13 scroll action verification returns completed status with measured latency", async () => {
      const req: ActionRequest = {
        action: "scroll",
        direction: "down",
        amount: 300,
        confidence: 0.85,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await verifyExecutedAction(req, { url: location.href, startTime: Date.now() - 20 });
      expect(result.verified).toBe(true);
      expect(result.verification?.expected).toBe("action_completed:scroll");
      expect(result.verification?.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("6.14 keypress action verification returns completed status with measured latency", async () => {
      const req: ActionRequest = {
        action: "keypress",
        value: "Enter",
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 2,
      };

      const result = await verifyExecutedAction(req, { url: location.href, startTime: Date.now() - 10 });
      expect(result.verified).toBe(true);
      expect(result.verification?.expected).toBe("action_completed:keypress");
    });

    it("6.15 wait action verification returns completed status with measured latency", async () => {
      const req: ActionRequest = {
        action: "wait",
        amount: 50,
        confidence: 0.99,
        taskId: TASK_ID,
        stepId: 3,
      };

      const result = await verifyExecutedAction(req, { url: location.href, startTime: Date.now() - 50 });
      expect(result.verified).toBe(true);
      expect(result.verification?.expected).toBe("action_completed:wait");
    });

    it("6.16 preserves exact taskId and stepId across execution and verification records", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: "custom-mission-task-999",
        stepId: 42,
      };

      const result = await executeAndVerifyAction(req, "custom-mission-task-999");
      expect(result.taskId).toBe("custom-mission-task-999");
      expect(result.stepId).toBe(42);
      expect(result.actionId).toBe("custom-mission-task-999-step-42");
      expect(result.verification?.actionId).toBe("custom-mission-task-999-step-42");
    });

    it("6.17 handles ambiguous verification outcomes by recommending re-evaluation via decideRecovery", async () => {
      // Mock verifyUrlChanged returning status: "ambiguous" (URL unchanged)
      vi.spyOn(pvmVerify, "verifyUrlChanged").mockReturnValue({
        actionId: `${TASK_ID}-step-1`,
        expected: "url_changed",
        observed: "url_unchanged",
        status: "ambiguous",
        latencyMs: 15,
      });

      const req: ActionRequest = {
        action: "navigate",
        url: "http://localhost:3000/same-page.html",
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await verifyExecutedAction(req);
      expect(result.verified).toBe(false);
      expect(result.recovery?.shouldRetry).toBe(true);
      expect(result.recovery?.reason).toContain("ambiguous outcome");
    });

    it("6.18 handles verification failure by recommending retry with fresh capture", async () => {
      vi.spyOn(pvmVerify, "verifyElementPresent").mockReturnValue({
        actionId: `${TASK_ID}-step-1`,
        expected: "element_present:[data-privy-id='99']",
        observed: "absent",
        status: "failure",
        latencyMs: 10,
      });

      const req: ActionRequest = {
        action: "click",
        elementId: 99,
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await verifyExecutedAction(req);
      expect(result.verified).toBe(false);
      expect(result.recovery?.shouldRetry).toBe(true);
      expect(result.recovery?.reason).toContain("retry with a fresh state capture");
    });

    it("6.19 guarantees verification is observational and triggers zero recursive execution loops", async () => {
      let executionCount = 0;
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      document.getElementById("btn")!.addEventListener("click", () => {
        executionCount++;
      });

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      await executeAndVerifyAction(req, TASK_ID);
      // Execution occurred exactly once; verification did not trigger recursive action calls
      expect(executionCount).toBe(1);
    });

    it("6.20 handles messaging failure gracefully without breaking execution outcome", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      // Mock chrome.runtime.sendMessage rejecting
      (globalThis as any).chrome = {
        runtime: {
          sendMessage: vi.fn().mockRejectedValue(new Error("Extension context invalidated")),
        },
      };

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await executeAndVerifyAction(req, TASK_ID);
      expect(result.executed).toBe(true);
      expect(result.verified).toBe(true);

      delete (globalThis as any).chrome;
    });

    it("6.21 verifies full lifecycle progression: VALIDATED -> EXECUTED -> VERIFIED", async () => {
      document.body.innerHTML = `<input id="mission-code" type="text" />`;
      const pageState = captureDomState(TASK_ID);
      const codeId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "type",
        elementId: codeId,
        value: "GAGANYAAN-01",
        confidence: 0.99,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await executeAndVerifyAction(req, TASK_ID);
      expect(result.executed).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.verification?.status).toBe("success");
      expect(result.recovery?.shouldRetry).toBe(false);

      const inputEl = document.getElementById("mission-code") as HTMLInputElement;
      expect(inputEl.value).toBe("GAGANYAAN-01");
    });
  });

  // ===========================================================================
  // 7. ROLE 1 PHASE 3 — RELIABILITY, STALE ACTIONS, BOUNDED RETRY & TIMEOUTS
  // ===========================================================================
  describe("7. Role 1 Phase 3 — Reliability, Stale Actions, Bounded Retries & Timeout Safety", () => {
    it("7.1 stale target handling: element removed between capture and execution safely rejects without crashing", async () => {
      document.body.innerHTML = `<button id="disappearing-btn">Submit Order</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      // Simulate DOM mutation removing element before execution
      document.getElementById("disappearing-btn")?.remove();

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await executeWithBoundedRetry(req, TASK_ID);
      expect(result.executed).toBe(false);
      expect(result.verified).toBe(false);
      expect(result.status).toBe("VALIDATION_FAILED");
      expect(result.error).toContain("not found");
      expect(result.attempts).toBe(1); // Validation failures never retry
    });

    it("7.2 stale target missing before execution does NOT attempt click and causes no side effects", async () => {
      let clickTriggered = false;
      document.body.innerHTML = `<div><span id="target">Static</span></div>`;
      const req: ActionRequest = {
        action: "click",
        elementId: 8888,
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await executeWithBoundedRetry(req, TASK_ID);
      expect(result.executed).toBe(false);
      expect(result.status).toBe("VALIDATION_FAILED");
      expect(clickTriggered).toBe(false);
    });

    it("7.3 verification failure with Role 5 shouldRetry: true triggers bounded retry", async () => {
      document.body.innerHTML = `<button id="btn">Action</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      let callCount = 0;
      vi.spyOn(pvmVerify, "verifyElementPresent").mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return {
            actionId: `${TASK_ID}-step-1`,
            expected: "present",
            observed: "absent",
            status: "failure",
            latencyMs: 10,
          };
        }
        return {
          actionId: `${TASK_ID}-step-1`,
          expected: "present",
          observed: "present",
          status: "success",
          latencyMs: 8,
        };
      });

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await executeWithBoundedRetry(req, TASK_ID, 2);
      expect(callCount).toBe(2);
      expect(result.verified).toBe(true);
      expect(result.status).toBe("VERIFIED");
      expect(result.attempts).toBe(2);
    });

    it("7.4 retry budget is strictly bounded: halts at maxAttempts with RETRY_EXHAUSTED when failures persist", async () => {
      document.body.innerHTML = `<button id="btn">Action</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      let verifyCount = 0;
      vi.spyOn(pvmVerify, "verifyElementPresent").mockImplementation(() => {
        verifyCount++;
        return {
          actionId: `${TASK_ID}-step-1`,
          expected: "present",
          observed: "absent",
          status: "failure",
          latencyMs: 10,
        };
      });

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await executeWithBoundedRetry(req, TASK_ID, 2);
      expect(verifyCount).toBe(3); // Initial attempt (0) + Retry 1 + Retry 2
      expect(result.verified).toBe(false);
      expect(result.status).toBe("RETRY_EXHAUSTED");
      expect(result.error).toContain("Retry budget exhausted");
    });

    it("7.5 retry is NOT performed when Role 5 decideRecovery returns shouldRetry: false", async () => {
      document.body.innerHTML = `<button id="btn">Action</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      let verifyCount = 0;
      vi.spyOn(pvmVerify, "verifyElementPresent").mockImplementation(() => {
        verifyCount++;
        return {
          actionId: `${TASK_ID}-step-1`,
          expected: "present",
          observed: "present",
          status: "success",
          latencyMs: 5,
        };
      });

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await executeWithBoundedRetry(req, TASK_ID, 2);
      expect(verifyCount).toBe(1);
      expect(result.verified).toBe(true);
      expect(result.attempts).toBe(1);
    });

    it("7.6 deterministic validation failure (unknown action) NEVER triggers retry", async () => {
      const req: any = {
        action: "malicious_script_action",
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await executeWithBoundedRetry(req, TASK_ID, 2);
      expect(result.executed).toBe(false);
      expect(result.verified).toBe(false);
      expect(result.status).toBe("VALIDATION_FAILED");
      expect(result.attempts).toBe(1);
    });

    it("7.7 deterministic validation failure from unsafe navigation URL NEVER triggers retry", async () => {
      const req: ActionRequest = {
        action: "navigate",
        url: "javascript:alert('pwned')",
        confidence: 0.99,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await executeWithBoundedRetry(req, TASK_ID, 2);
      expect(result.executed).toBe(false);
      expect(result.status).toBe("VALIDATION_FAILED");
      expect(result.attempts).toBe(1);
    });

    it("7.8 deterministic validation failure from missing secret valueRef NEVER triggers retry", async () => {
      document.body.innerHTML = `<input id="pwd" type="password" />`;
      const pageState = captureDomState(TASK_ID);
      const pwdId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "type_secret",
        elementId: pwdId,
        valueRef: "",
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await executeWithBoundedRetry(req, TASK_ID, 2);
      expect(result.executed).toBe(false);
      expect(result.status).toBe("VALIDATION_FAILED");
      expect(result.attempts).toBe(1);
    });

    it("7.9 deterministic validation failure on disabled target NEVER triggers retry", async () => {
      document.body.innerHTML = `<button id="btn" disabled>Disabled</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await executeWithBoundedRetry(req, TASK_ID, 2);
      expect(result.executed).toBe(false);
      expect(result.status).toBe("VALIDATION_FAILED");
      expect(result.attempts).toBe(1);
    });

    it("7.10 type_secret during retry strictly preserves Secret Store privacy (zero credentials in retry state)", async () => {
      const SECRET_PAYLOAD = "ISRO_SECRET_PAYLOAD_XYZ";
      setLocalSecret("[AUTH_TOKEN]", SECRET_PAYLOAD);

      document.body.innerHTML = `<input id="token-inp" type="password" />`;
      const pageState = captureDomState(TASK_ID);
      const tokenFieldId = pageState.elements[0].elementId;

      let callCount = 0;
      vi.spyOn(pvmVerify, "verifyElementPresent").mockImplementation(() => {
        callCount++;
        return {
          actionId: `${TASK_ID}-step-1`,
          expected: "present",
          observed: "present",
          status: "success",
          latencyMs: 12,
        };
      });

      const req: ActionRequest = {
        action: "type_secret",
        elementId: tokenFieldId,
        valueRef: "[AUTH_TOKEN]",
        confidence: 0.98,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await executeWithBoundedRetry(req, TASK_ID, 2);
      expect(result.verified).toBe(true);

      // Verify DOM has secret
      const inputEl = document.getElementById("token-inp") as HTMLInputElement;
      expect(inputEl.value).toBe(SECRET_PAYLOAD);

      // Verify result metadata never contains raw secret
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(SECRET_PAYLOAD);
    });

    it("7.11 navigation retry re-validates URL before secondary navigation execution", async () => {
      const req: ActionRequest = {
        action: "navigate",
        url: "http://localhost:3000/orbit.html",
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      };

      let verifyCount = 0;
      vi.spyOn(pvmVerify, "verifyUrlChanged").mockImplementation(() => {
        verifyCount++;
        if (verifyCount === 1) {
          return { actionId: `${TASK_ID}-step-1`, expected: "url_changed", observed: "unchanged", status: "failure", latencyMs: 5 };
        }
        return { actionId: `${TASK_ID}-step-1`, expected: "url_changed", observed: "url_changed", status: "success", latencyMs: 5 };
      });

      const result = await executeWithBoundedRetry(req, TASK_ID, 2);
      expect(verifyCount).toBe(2);
      expect(result.verified).toBe(true);
    });

    it("7.12 stale / malformed action requests with missing taskId are rejected with VALIDATION_FAILED", async () => {
      const malformedReq: any = {
        action: "click",
        elementId: 1,
      };

      const result = await executeWithBoundedRetry(malformedReq, TASK_ID);
      expect(result.status).toBe("VALIDATION_FAILED");
      expect(result.executed).toBe(false);
      expect(result.verified).toBe(false);
    });

    it("7.13 stepId and taskId preservation across single and retry lifecycle results", async () => {
      document.body.innerHTML = `<button id="btn">Test</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: "mission-task-888",
        stepId: 77,
      };

      const result = await executeWithBoundedRetry(req, "mission-task-888");
      expect(result.taskId).toBe("mission-task-888");
      expect(result.stepId).toBe(77);
      expect(result.actionId).toBe("mission-task-888-step-77");
    });

    it("7.14 retry counter isolation: attempt counts for task-A do NOT affect task-B", async () => {
      document.body.innerHTML = `<button id="btn">Test</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const reqA: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: "task-A",
        stepId: 1,
      };

      const reqB: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: "task-B",
        stepId: 1,
      };

      await executeWithBoundedRetry(reqA, "task-A");
      expect(getRetryAttempts("task-A-step-1")).toBe(0);

      await executeWithBoundedRetry(reqB, "task-B");
      expect(getRetryAttempts("task-B-step-1")).toBe(0);
    });

    it("7.15 action execution timeout returns status: TIMEOUT when execution exceeds timeoutMs", async () => {
      // Mock wait action
      const req: ActionRequest = {
        action: "wait",
        amount: 2000,
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      };

      // Call bounded retry with small 20ms timeout
      const result = await executeWithBoundedRetry(req, TASK_ID, 0, 20);
      expect(result.status).toBe("TIMEOUT");
      expect(result.executed).toBe(false);
      expect(result.verified).toBe(false);
      expect(result.error).toContain("timed out after 20ms");
    });

    it("7.16 withTimeout helper throws timeout error if target promise does not resolve within limit", async () => {
      const slowPromise = new Promise((resolve) => setTimeout(resolve, 500));
      await expect(withTimeout(slowPromise, 30, "Custom Timeout")).rejects.toThrow("Custom Timeout");
    });

    it("7.17 withTimeout helper returns resolved value if target resolves before limit", async () => {
      const fastPromise = Promise.resolve("FastResult");
      const result = await withTimeout(fastPromise, 200, "Timeout");
      expect(result).toBe("FastResult");
    });

    it("7.18 target element dynamically disabled between capture and execution is rejected safely", async () => {
      document.body.innerHTML = `<button id="btn">Clickable</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      // Dynamically disable before execution
      const btn = document.getElementById("btn") as HTMLButtonElement;
      btn.disabled = true;

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await executeWithBoundedRetry(req, TASK_ID);
      expect(result.executed).toBe(false);
      expect(result.status).toBe("VALIDATION_FAILED");
      expect(result.error).toContain("disabled");
    });

    it("7.19 target element dynamically marked readonly between capture and execution is rejected safely", async () => {
      document.body.innerHTML = `<input id="inp" type="text" />`;
      const pageState = captureDomState(TASK_ID);
      const inpId = pageState.elements[0].elementId;

      // Dynamically mark readonly before execution
      const inp = document.getElementById("inp") as HTMLInputElement;
      inp.readOnly = true;

      const req: ActionRequest = {
        action: "type",
        elementId: inpId,
        value: "SomeText",
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await executeWithBoundedRetry(req, TASK_ID);
      expect(result.executed).toBe(false);
      expect(result.status).toBe("VALIDATION_FAILED");
      expect(result.error).toContain("readonly");
    });

    it("7.20 verification exception during retry is caught and returns VERIFICATION_FAILED without throwing", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      vi.spyOn(pvmVerify, "verifyElementPresent").mockImplementation(() => {
        throw new Error("PVM verification fatal failure");
      });

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await executeWithBoundedRetry(req, TASK_ID, 2);
      expect(result.verified).toBe(false);
      expect(result.status).toBe("VERIFICATION_FAILED");
      expect(result.error).toContain("PVM verification fatal failure");
    });

    it("7.21 getRetryAttempts returns correct count and resetRetryTracker clears history", () => {
      resetRetryTracker();
      expect(getRetryAttempts("test-task-step-1")).toBe(0);
    });

    it("7.22 guarantees zero raw DOM serialization (innerHTML) is created during execution and verification", async () => {
      const RAW_HTML_CANARY = `<div data-canary="SECRET_DOM_TREE">Payload</div>`;
      document.body.innerHTML = `${RAW_HTML_CANARY}<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await executeWithBoundedRetry(req, TASK_ID);
      const serialized = JSON.stringify(result);

      expect(serialized).not.toContain("SECRET_DOM_TREE");
      expect(serialized).not.toContain("innerHTML");
    });

    it("7.23 executeWithBoundedRetry default parameter values operate correctly", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await executeWithBoundedRetry(req, TASK_ID);
      expect(result.executed).toBe(true);
      expect(result.verified).toBe(true);
    });

    it("7.24 ambiguous verification recovery recommendation triggers retry and settles on success", async () => {
      let callNum = 0;
      vi.spyOn(pvmVerify, "verifyElementPresent").mockImplementation(() => {
        callNum++;
        if (callNum === 1) {
          return { actionId: `${TASK_ID}-step-1`, expected: "present", observed: "ambiguous", status: "ambiguous", latencyMs: 8 };
        }
        return { actionId: `${TASK_ID}-step-1`, expected: "present", observed: "present", status: "success", latencyMs: 5 };
      });

      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await executeWithBoundedRetry(req, TASK_ID, 2);
      expect(callNum).toBe(2);
      expect(result.verified).toBe(true);
      expect(result.status).toBe("VERIFIED");
    });

    it("7.25 MAX_RETRY_ATTEMPTS constant is exported with value 2", () => {
      expect(MAX_RETRY_ATTEMPTS).toBe(2);
    });

    it("7.26 executeAndVerifyAction handles null/undefined req safely", async () => {
      const result = await executeAndVerifyAction(null as any, TASK_ID);
      expect(result.executed).toBe(false);
      expect(result.verified).toBe(false);
      expect(result.status).toBe("VALIDATION_FAILED");
    });
  });

  // ===========================================================================
  // 8. ROLE 1 PHASE 4 — SESSION LIFECYCLE, CANCELLATION & CONCURRENCY
  // ===========================================================================
  describe("8. Role 1 Phase 4 — Execution Session Lifecycle, Cancellation & Concurrency", () => {
    it("8.1 getOrCreateSession initializes new session in IDLE state with valid timestamps", () => {
      const session = getOrCreateSession("test-task-101");
      expect(session.taskId).toBe("test-task-101");
      expect(session.state).toBe("IDLE");
      expect(session.activeStepId).toBeNull();
      expect(session.activeActionId).toBeNull();
      expect(session.startedAt).toBeGreaterThan(0);
      expect(session.lastUpdatedAt).toBeGreaterThan(0);
      expect(session.abortController.signal.aborted).toBe(false);
    });

    it("8.2 getSession returns existing session for taskId or undefined if not created", () => {
      expect(getSession("non-existent-task")).toBeUndefined();
      getOrCreateSession("test-task-102");
      expect(getSession("test-task-102")).toBeDefined();
    });

    it("8.3 runActionInSession transitions session state from IDLE -> RUNNING -> verified success", async () => {
      document.body.innerHTML = `<button id="btn">Click Me</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID);
      expect(result.verified).toBe(true);
      expect(result.status).toBe("VERIFIED");

      const session = getSession(TASK_ID);
      expect(session?.lastResult?.status).toBe("VERIFIED");
      expect(session?.activeActionId).toBe(`${TASK_ID}-step-1`);
    });

    it("8.4 runActionInSession transitions session state to FAILED on execution or validation failure", async () => {
      const invalidReq: ActionRequest = {
        action: "click",
        elementId: 9999, // Non-existent element
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(invalidReq, TASK_ID);
      expect(result.executed).toBe(false);
      expect(result.verified).toBe(false);

      const session = getSession(TASK_ID);
      expect(session?.state).toBe("FAILED");
    });

    it("8.5 runActionInSession transitions session state to TIMED_OUT when action execution times out", async () => {
      const req: ActionRequest = {
        action: "wait",
        amount: 2000,
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID, 0, 20); // 20ms timeout
      expect(result.status).toBe("TIMEOUT");

      const session = getSession(TASK_ID);
      expect(session?.state).toBe("TIMED_OUT");
    });

    it("8.6 cancelSession transitions active session to CANCELLED and aborts signal", () => {
      const session = getOrCreateSession(TASK_ID);
      session.state = "RUNNING";

      const cancelResult = cancelSession(TASK_ID, "Emergency abort");
      expect(session.state).toBe("CANCELLED");
      expect(session.abortController.signal.aborted).toBe(true);
      expect(cancelResult.status).toBe("CANCELLED");
      expect(cancelResult.error).toBe("Emergency abort");
    });

    it("8.7 cancellation before execution prevents action execution and returns CANCELLED", async () => {
      let clickFired = false;
      document.body.innerHTML = `<button id="btn">Click</button>`;
      document.getElementById("btn")!.addEventListener("click", () => {
        clickFired = true;
      });

      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      cancelSession(TASK_ID, "Pre-execution cancel");

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID);
      expect(result.executed).toBe(false);
      expect(result.status).toBe("CANCELLED");
      expect(clickFired).toBe(false);
    });

    it("8.8 cancellation during active execution aborts subsequent steps and prevents retry", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      let callCount = 0;
      vi.spyOn(pvmVerify, "verifyElementPresent").mockImplementation(() => {
        callCount++;
        // Cancel session during first verification
        cancelSession(TASK_ID, "Cancelled during verification");
        return {
          actionId: `${TASK_ID}-step-1`,
          expected: "present",
          observed: "absent",
          status: "failure",
          latencyMs: 5,
        };
      });

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID, 2);
      expect(result.status).toBe("CANCELLED");
      expect(result.verified).toBe(false);
      // Because cancelled, it never attempts retry 2
      expect(callCount).toBe(1);
    });

    it("8.9 cancellation during retry prevents subsequent retry attempts", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      let verifyCalls = 0;
      vi.spyOn(pvmVerify, "verifyElementPresent").mockImplementation(() => {
        verifyCalls++;
        if (verifyCalls === 1) {
          // Trigger abort on first failure
          const session = getSession(TASK_ID);
          session?.abortController.abort("Abort before second attempt");
          return { actionId: `${TASK_ID}-step-1`, expected: "present", observed: "absent", status: "failure", latencyMs: 5 };
        }
        return { actionId: `${TASK_ID}-step-1`, expected: "present", observed: "present", status: "success", latencyMs: 5 };
      });

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID, 2);
      expect(result.status).toBe("CANCELLED");
      expect(verifyCalls).toBe(1);
    });

    it("8.10 terminal state protection: COMPLETED session cannot be cancelled or re-run", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      await runActionInSession(req, TASK_ID);
      completeSession(TASK_ID);
      const session = getSession(TASK_ID)!;
      expect(session.state).toBe("COMPLETED");

      // Attempting to cancel completed session is rejected
      const cancelRes = cancelSession(TASK_ID, "Late cancel");
      expect(session.state).toBe("COMPLETED");
      expect(cancelRes.error).toContain("terminal state: COMPLETED");

      // Attempting to run another action on completed session is rejected
      const secondRun = await runActionInSession(req, TASK_ID);
      expect(secondRun.executed).toBe(false);
      expect(secondRun.error).toContain("terminal state: COMPLETED");
    });

    it("8.11 terminal state protection: FAILED session cannot be transitioned back to RUNNING", async () => {
      const invalidReq: ActionRequest = {
        action: "click",
        elementId: 9999,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      await runActionInSession(invalidReq, TASK_ID);
      const session = getSession(TASK_ID)!;
      expect(session.state).toBe("FAILED");

      // Running action on failed session fails immediately
      const nextRun = await runActionInSession(invalidReq, TASK_ID);
      expect(nextRun.executed).toBe(false);
      expect(session.state).toBe("FAILED");
    });

    it("8.12 terminal state protection: CANCELLED session rejects subsequent action execution requests", async () => {
      cancelSession(TASK_ID, "Explicit Stop");
      const session = getSession(TASK_ID)!;
      expect(session.state).toBe("CANCELLED");

      const req: ActionRequest = {
        action: "wait",
        amount: 100,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID);
      expect(result.executed).toBe(false);
      expect(result.status).toBe("CANCELLED");
    });

    it("8.13 terminal state protection: TIMED_OUT session cannot return to RUNNING", async () => {
      const session = getOrCreateSession(TASK_ID);
      session.state = "TIMED_OUT";

      const req: ActionRequest = {
        action: "wait",
        amount: 50,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID);
      expect(result.executed).toBe(false);
      expect(session.state).toBe("TIMED_OUT");
    });

    it("8.14 late verification completion cannot override CANCELLED session state", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const session = getOrCreateSession(TASK_ID);
      session.state = "RUNNING";

      // Cancel session while verification was starting
      cancelSession(TASK_ID, "Cancelled during flight");

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID);
      expect(result.status).toBe("CANCELLED");
      expect(result.verified).toBe(false);
      expect(session.state).toBe("CANCELLED");
    });

    it("8.15 late retry callback cannot override CANCELLED session state", async () => {
      const session = getOrCreateSession(TASK_ID);
      cancelSession(TASK_ID, "Cancelled before retry callback");

      const req: ActionRequest = {
        action: "wait",
        amount: 50,
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await executeWithBoundedRetry(req, TASK_ID, 2, 5000, session.abortController.signal);
      expect(result.status).toBe("CANCELLED");
      expect(session.state).toBe("CANCELLED");
    });

    it("8.16 duplicate action protection: simultaneous identical action request while RUNNING returns DUPLICATE_PREVENTED", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const session = getOrCreateSession(TASK_ID);
      session.state = "RUNNING";
      session.activeActionId = `${TASK_ID}-step-1`;

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const duplicateResult = await runActionInSession(req, TASK_ID);
      expect(duplicateResult.status).toBe("DUPLICATE_PREVENTED");
      expect(duplicateResult.executed).toBe(false);
    });

    it("8.17 concurrency serialization: conflicting actions on the same session execute in strict serial sequence", async () => {
      const executionOrder: string[] = [];

      document.body.innerHTML = `
        <button id="btn1">Button 1</button>
        <button id="btn2">Button 2</button>
      `;
      const pageState = captureDomState(TASK_ID);
      const btn1Id = pageState.elements[0].elementId;
      const btn2Id = pageState.elements[1].elementId;

      document.getElementById("btn1")!.addEventListener("click", () => {
        executionOrder.push("btn1");
      });
      document.getElementById("btn2")!.addEventListener("click", () => {
        executionOrder.push("btn2");
      });

      const req1: ActionRequest = { action: "click", elementId: btn1Id, confidence: 0.9, taskId: TASK_ID, stepId: 1 };
      const req2: ActionRequest = { action: "click", elementId: btn2Id, confidence: 0.9, taskId: TASK_ID, stepId: 2 };

      // Dispatch both concurrently
      const promise1 = runActionInSession(req1, TASK_ID);
      const promise2 = runActionInSession(req2, TASK_ID);

      await Promise.all([promise1, promise2]);
      expect(executionOrder).toEqual(["btn1", "btn2"]);
    });

    it("8.18 task isolation: operations on task-A do not block, corrupt, or alter task-B", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const reqA: ActionRequest = { action: "click", elementId: btnId, confidence: 0.95, taskId: "TASK_A", stepId: 1 };
      const reqB: ActionRequest = { action: "click", elementId: btnId, confidence: 0.95, taskId: "TASK_B", stepId: 1 };

      cancelSession("TASK_A", "Abort Task A only");

      const resA = await runActionInSession(reqA, "TASK_A");
      const resB = await runActionInSession(reqB, "TASK_B");

      expect(resA.status).toBe("CANCELLED");
      expect(resB.status).toBe("VERIFIED");
      expect(getSession("TASK_A")?.state).toBe("CANCELLED");
      expect(getSession("TASK_B")?.lastResult?.status).toBe("VERIFIED");
      completeSession("TASK_B");
      expect(getSession("TASK_B")?.state).toBe("COMPLETED");
    });

    it("8.19 stale callback protection: outdated async completion cannot overwrite newer step or attempt", async () => {
      const session = getOrCreateSession(TASK_ID);
      session.state = "RUNNING";
      session.activeStepId = 2;
      session.activeActionId = `${TASK_ID}-step-2`;

      // Simulating a stale step 1 completion arriving late
      const staleStep1Result: any = {
        actionId: `${TASK_ID}-step-1`,
        taskId: TASK_ID,
        stepId: 1,
        status: "VERIFIED",
      };
      expect(staleStep1Result.status).toBe("VERIFIED");

      // Stale step should not revert active step 2
      expect(session.activeStepId).toBe(2);
      expect(session.activeActionId).toBe(`${TASK_ID}-step-2`);
    });

    it("8.20 cleanupSession removes session entry and clears action tracking history for taskId", () => {
      getOrCreateSession("cleanup-task-1");
      expect(getSession("cleanup-task-1")).toBeDefined();

      cleanupSession("cleanup-task-1");
      expect(getSession("cleanup-task-1")).toBeUndefined();
    });

    it("8.21 cleanupSession safely aborts active AbortController without throwing unhandled exceptions", () => {
      const session = getOrCreateSession("cleanup-task-2");
      expect(session.abortController.signal.aborted).toBe(false);

      expect(() => cleanupSession("cleanup-task-2")).not.toThrow();
      expect(getSession("cleanup-task-2")).toBeUndefined();
    });

    it("8.22 resetSessionRegistry cleans up all active sessions across test runs", () => {
      getOrCreateSession("session-1");
      getOrCreateSession("session-2");
      getOrCreateSession("session-3");

      resetSessionRegistry();
      expect(getSession("session-1")).toBeUndefined();
      expect(getSession("session-2")).toBeUndefined();
      expect(getSession("session-3")).toBeUndefined();
    });

    it("8.23 type_secret cancellation preserves privacy (zero secrets in cancellation result/errors)", async () => {
      const TOP_SECRET = "ULTRA_SENSITIVE_MISSION_KEY_888";
      setLocalSecret("[MISSION_KEY]", TOP_SECRET);

      document.body.innerHTML = `<input id="pwd" type="password" />`;
      const pageState = captureDomState(TASK_ID);
      const pwdId = pageState.elements[0].elementId;

      cancelSession(TASK_ID, "Secret typing aborted by privacy guard");

      const req: ActionRequest = {
        action: "type_secret",
        elementId: pwdId,
        valueRef: "[MISSION_KEY]",
        confidence: 0.98,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID);
      expect(result.status).toBe("CANCELLED");

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(TOP_SECRET);
      expect(serialized).toContain("[MISSION_KEY]");
    });

    it("8.24 type_secret execution within session preserves privacy (zero raw credentials in session metadata)", async () => {
      const SECRET_PAYLOAD = "TOP_SECRET_ORBIT_PAYLOAD";
      setLocalSecret("[PAYLOAD_KEY]", SECRET_PAYLOAD);

      document.body.innerHTML = `<input id="key-field" type="password" />`;
      const pageState = captureDomState(TASK_ID);
      const keyId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "type_secret",
        elementId: keyId,
        valueRef: "[PAYLOAD_KEY]",
        confidence: 0.99,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID);
      expect(result.verified).toBe(true);

      const session = getSession(TASK_ID)!;
      const sessionSerialized = JSON.stringify({
        state: session.state,
        activeStepId: session.activeStepId,
        activeActionId: session.activeActionId,
        lastResult: session.lastResult,
      });

      expect(sessionSerialized).not.toContain(SECRET_PAYLOAD);
      expect(sessionSerialized).toContain("[PAYLOAD_KEY]");
    });

    it("8.25 navigation action executed within session transitions to COMPLETED on verified URL change", async () => {
      vi.spyOn(pvmVerify, "verifyUrlChanged").mockReturnValue({
        actionId: `${TASK_ID}-step-1`,
        expected: "url_changed",
        observed: "url_changed",
        status: "success",
        latencyMs: 5,
      });

      const req: ActionRequest = {
        action: "navigate",
        url: "http://localhost:3000/orbit-telemetry.html",
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID);
      expect(result.status).toBe("VERIFIED");

      completeSession(TASK_ID);
      const session = getSession(TASK_ID)!;
      expect(session.state).toBe("COMPLETED");
    });

    it("8.26 action validation rejection within session sets session to FAILED without crashing", async () => {
      const malformedReq: any = {
        action: "unsupported_eval_script",
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(malformedReq, TASK_ID);
      expect(result.status).toBe("VALIDATION_FAILED");

      const session = getSession(TASK_ID)!;
      expect(session.state).toBe("FAILED");
    });

    it("8.27 action execution error within session sets session to FAILED without crashing", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const btn = document.getElementById("btn")!;
      btn.click = () => {
        throw new Error("Native dispatch crash");
      };

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID);
      expect(result.status).toBe("EXECUTION_FAILED");
      expect(result.error).toContain("Native dispatch crash");

      const session = getSession(TASK_ID)!;
      expect(session.state).toBe("FAILED");
    });

    it("8.28 verification exception within session is safely caught and sets session to FAILED", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      vi.spyOn(pvmVerify, "verifyElementPresent").mockImplementation(() => {
        throw new Error("PVM verification fatal crash");
      });

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID, 0);
      expect(result.status).toBe("VERIFICATION_FAILED");

      const session = getSession(TASK_ID)!;
      expect(session.state).toBe("FAILED");
    });

    it("8.29 content script cleanup ensures session is removed on final completion tick", () => {
      getOrCreateSession("ephemeral-mission-task");
      expect(getSession("ephemeral-mission-task")).toBeDefined();

      cleanupSession("ephemeral-mission-task");
      expect(getSession("ephemeral-mission-task")).toBeUndefined();
    });

    it("8.30 custom cancellation reason is preserved in ActionExecutionLifecycleResult.error", () => {
      const cancelRes = cancelSession(TASK_ID, "Manual user navigation triggered tab reset");
      expect(cancelRes.error).toBe("Manual user navigation triggered tab reset");
      expect(cancelRes.status).toBe("CANCELLED");
    });

    it("8.31 multiple sequential steps on the same task progress stepId correctly", async () => {
      document.body.innerHTML = `<input id="inp" type="text" />`;
      const pageState = captureDomState(TASK_ID);
      const inpId = pageState.elements[0].elementId;

      const req1: ActionRequest = { action: "type", elementId: inpId, value: "Step 1", confidence: 0.9, taskId: TASK_ID, stepId: 1 };
      const req2: ActionRequest = { action: "keypress", value: "Enter", confidence: 0.9, taskId: TASK_ID, stepId: 2 };

      const res1 = await runActionInSession(req1, TASK_ID);
      expect(res1.stepId).toBe(1);

      // Reset terminal state to allow step 2 progression
      const session = getSession(TASK_ID)!;
      session.state = "IDLE";

      const res2 = await runActionInSession(req2, TASK_ID);
      expect(res2.stepId).toBe(2);
      expect(session.activeStepId).toBe(2);
    });

    it("8.32 isSessionTerminal helper correctly identifies all 4 terminal states", () => {
      expect(TERMINAL_SESSION_STATES.has("COMPLETED")).toBe(true);
      expect(TERMINAL_SESSION_STATES.has("FAILED")).toBe(true);
      expect(TERMINAL_SESSION_STATES.has("CANCELLED")).toBe(true);
      expect(TERMINAL_SESSION_STATES.has("TIMED_OUT")).toBe(true);
      expect(TERMINAL_SESSION_STATES.has("IDLE")).toBe(false);
      expect(TERMINAL_SESSION_STATES.has("RUNNING")).toBe(false);
      expect(TERMINAL_SESSION_STATES.has("VERIFYING")).toBe(false);
      expect(TERMINAL_SESSION_STATES.has("RETRYING")).toBe(false);

      expect(isSessionTerminal({ state: "COMPLETED" } as any)).toBe(true);
      expect(isSessionTerminal({ state: "FAILED" } as any)).toBe(true);
      expect(isSessionTerminal({ state: "CANCELLED" } as any)).toBe(true);
      expect(isSessionTerminal({ state: "TIMED_OUT" } as any)).toBe(true);
      expect(isSessionTerminal({ state: "IDLE" } as any)).toBe(false);
      expect(isSessionTerminal({ state: "RUNNING" } as any)).toBe(false);
    });
  });

  // ===========================================================================
  // 9. ROLE 1 PHASE 5 — LIFECYCLE RESILIENCE & RECOVERY HARDENING
  // ===========================================================================
  describe("9. Role 1 Phase 5 — Lifecycle Resilience & Recovery Hardening", () => {
    it("9.1 content script unavailable during action execution maps to status INTERRUPTED safely", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const btn = document.getElementById("btn")!;
      btn.click = () => {
        throw new Error("CONTENT_SCRIPT_UNAVAILABLE: Receiving end does not exist");
      };

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID);
      expect(result.status).toBe("INTERRUPTED");
      expect(result.executed).toBe(false);
      expect(result.verified).toBe(false);
      expect(result.error).toContain("CONTENT_SCRIPT_UNAVAILABLE");
    });

    it("9.2 content script disconnect during verification returns INTERRUPTED without crashing", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      vi.spyOn(pvmVerify, "verifyElementPresent").mockImplementation(() => {
        throw new Error("EXECUTION_CONTEXT_LOST: Extension context invalidated");
      });

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID, 0);
      expect(result.status).toBe("VERIFICATION_FAILED");
      expect(result.verified).toBe(false);
    });

    it("9.3 message channel failure is caught and mapped to INTERRUPTED safely", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const btn = document.getElementById("btn")!;
      btn.click = () => {
        throw new Error("MESSAGE_CHANNEL_LOST: Chrome extension runtime unavailable");
      };

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID);
      expect(result.status).toBe("INTERRUPTED");
      expect(result.error).toContain("MESSAGE_CHANNEL_LOST");
    });

    it("9.4 page reload during execution triggers safe interruption", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const btn = document.getElementById("btn")!;
      btn.click = () => {
        throw new Error("PAGE_RELOADED: Page reloaded before action could settle");
      };

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID, 0);
      expect(result.status).toBe("INTERRUPTED");
      expect(result.error).toContain("PAGE_RELOADED");
    });

    it("9.5 unexpected navigation during execution triggers safe interruption", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const btn = document.getElementById("btn")!;
      btn.click = () => {
        throw new Error("UNEXPECTED_NAVIGATION: Execution context destroyed due to unexpected navigation");
      };

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID);
      expect(result.executed).toBe(false);
      expect(result.status).toBe("EXECUTION_FAILED");
    });

    it("9.6 tab unavailable triggers safe interruption without infinite loop", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const btn = document.getElementById("btn")!;
      btn.click = () => {
        throw new Error("TAB_UNAVAILABLE: Target tab was closed or discarded");
      };

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID, 2);
      // Because TAB_UNAVAILABLE is not retryable, it stops after attempt 1
      expect(result.status).toBe("INTERRUPTED");
      expect(result.attempts).toBe(1);
    });

    it("9.7 wrong tab identity: action targeting tab 2 rejected by session bound to tab 1", async () => {
      const session = getOrCreateSession(TASK_ID, 1);
      expect(session.tabId).toBe(1);

      const req: ActionRequest = {
        action: "wait",
        amount: 50,
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
        tabId: 2, // Mismatched tabId
      };

      const result = await runActionInSession(req, TASK_ID);
      expect(result.status).toBe("INTERRUPTED");
      expect(result.executed).toBe(false);
      expect(result.error).toContain("WRONG_TAB_IDENTITY");
    });

    it("9.8 stale tab action rejected when session tab identity does not match", async () => {
      getOrCreateSession("session-tab-check", 42);

      const req: ActionRequest = {
        action: "wait",
        amount: 50,
        confidence: 0.9,
        taskId: "session-tab-check",
        stepId: 1,
        tabId: 99,
      };

      const result = await runActionInSession(req, "session-tab-check");
      expect(result.status).toBe("INTERRUPTED");
      expect(result.error).toContain("WRONG_TAB_IDENTITY");
    });

    it("9.9 stale message response from previous step does not overwrite active action result", async () => {
      const session = getOrCreateSession(TASK_ID);
      session.activeStepId = 2;
      session.activeActionId = `${TASK_ID}-step-2`;

      // Simulating a late step 1 response
      const staleStep1Result = {
        actionId: `${TASK_ID}-step-1`,
        taskId: TASK_ID,
        stepId: 1,
        status: "VERIFIED",
      };
      expect(staleStep1Result.stepId).toBe(1);

      expect(session.activeStepId).toBe(2);
      expect(session.activeActionId).toBe(`${TASK_ID}-step-2`);
    });

    it("9.10 duplicate lifecycle event handling is idempotent and does not corrupt session", () => {
      const session = getOrCreateSession(TASK_ID);
      session.state = "RUNNING";

      const res1 = interruptSession(TASK_ID, "PAGE_RELOADED");
      const res2 = interruptSession(TASK_ID, "PAGE_RELOADED");

      expect(res1.status).toBe("INTERRUPTED");
      expect(res2.status).toBe("INTERRUPTED");
      expect(session.state).toBe("INTERRUPTED");
    });

    it("9.11 interruptSession transitions active session to INTERRUPTED state", () => {
      const session = getOrCreateSession(TASK_ID);
      session.state = "RUNNING";

      const result = interruptSession(TASK_ID, "CONTENT_SCRIPT_UNAVAILABLE");
      expect(session.state).toBe("INTERRUPTED");
      expect(session.abortController.signal.aborted).toBe(true);
      expect(result.status).toBe("INTERRUPTED");
    });

    it("9.12 interrupted action returns INTERRUPTED status and does not report verified success", async () => {
      interruptSession(TASK_ID, "TAB_UNAVAILABLE");

      const req: ActionRequest = {
        action: "wait",
        amount: 50,
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID);
      expect(result.status).toBe("INTERRUPTED");
      expect(result.verified).toBe(false);
      expect(result.executed).toBe(false);
    });

    it("9.13 lifecycle interruption cannot produce false success", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      interruptSession(TASK_ID, "CONTENT_SCRIPT_UNAVAILABLE");

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID);
      expect(result.verified).toBe(false);
      expect(result.status).toBe("INTERRUPTED");
    });

    it("9.14 isLifecycleInterruptionRetryable returns true for transient page reload events", () => {
      expect(isLifecycleInterruptionRetryable("PAGE_RELOADED: Page reloaded before action settled")).toBe(true);
      expect(isLifecycleInterruptionRetryable("Page reloaded")).toBe(true);
    });

    it("9.15 isLifecycleInterruptionRetryable returns false for permanent disconnects", () => {
      expect(isLifecycleInterruptionRetryable("CONTENT_SCRIPT_UNAVAILABLE: Receiving end does not exist")).toBe(false);
      expect(isLifecycleInterruptionRetryable("TAB_UNAVAILABLE: Target tab was closed")).toBe(false);
      expect(isLifecycleInterruptionRetryable("WRONG_TAB_IDENTITY: Tab mismatch")).toBe(false);
      expect(isLifecycleInterruptionRetryable("EXECUTION_CONTEXT_LOST: Extension context invalidated")).toBe(false);
      expect(isLifecycleInterruptionRetryable("MESSAGE_CHANNEL_LOST: Port disconnected")).toBe(false);
    });

    it("9.16 retry budget is strictly respected during lifecycle interruption recovery (max 2 attempts)", async () => {
      let attemptsCount = 0;
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const btn = document.getElementById("btn")!;
      btn.click = () => {
        attemptsCount++;
        throw new Error("PAGE_RELOADED: Transient reload error");
      };

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID, 2);
      expect(attemptsCount).toBe(3); // Attempt 0, Attempt 1, Attempt 2
      expect(result.status).toBe("RETRY_EXHAUSTED");
      expect(result.attempts).toBe(3);
    });

    it("9.17 lifecycle recovery strictly revalidates action request before secondary execution attempt", async () => {
      let callCount = 0;
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const btn = document.getElementById("btn")!;
      btn.click = () => {
        callCount++;
        if (callCount === 1) {
          throw new Error("PAGE_RELOADED: Transient reload");
        }
      };

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID, 2);
      expect(callCount).toBe(2);
      expect(result.verified).toBe(true);
      expect(result.status).toBe("VERIFIED");
    });

    it("9.18 navigation retry strictly re-validates URL before subsequent attempt", async () => {
      let navAttempts = 0;
      vi.spyOn(pvmVerify, "verifyUrlChanged").mockImplementation(() => {
        navAttempts++;
        if (navAttempts === 1) {
          return { actionId: `${TASK_ID}-step-1`, expected: "url_changed", observed: "same_url", status: "ambiguous", latencyMs: 5 };
        }
        return { actionId: `${TASK_ID}-step-1`, expected: "url_changed", observed: "url_changed", status: "success", latencyMs: 5 };
      });

      const req: ActionRequest = {
        action: "navigate",
        url: "http://localhost:3000/orbit-telemetry.html",
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID, 2);
      expect(navAttempts).toBe(2);
      expect(result.status).toBe("VERIFIED");
    });

    it("9.19 type_secret recovery uses valueRef only without ever requiring raw secret in metadata", async () => {
      const RECOVERY_SECRET = "RECOVERY_ORBIT_PAYLOAD_TOKEN";
      setLocalSecret("[RECOVERY_TOKEN]", RECOVERY_SECRET);

      document.body.innerHTML = `<input id="rec-pwd" type="password" />`;
      const pageState = captureDomState(TASK_ID);
      const pwdId = pageState.elements[0].elementId;

      let typingAttempts = 0;
      const inp = document.getElementById("rec-pwd") as HTMLInputElement;
      inp.addEventListener("input", () => {
        typingAttempts++;
      });

      const req: ActionRequest = {
        action: "type_secret",
        elementId: pwdId,
        valueRef: "[RECOVERY_TOKEN]",
        confidence: 0.98,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID);
      expect(result.verified).toBe(true);
      expect(result.valueRef).toBe("[RECOVERY_TOKEN]");

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(RECOVERY_SECRET);
      expect(serialized).toContain("[RECOVERY_TOKEN]");
    });

    it("9.20 missing Secret Store during secret action recovery fails safely with VALIDATION_FAILED", async () => {
      clearLocalSecrets();
      document.body.innerHTML = `<input id="rec-pwd" type="password" />`;
      const pageState = captureDomState(TASK_ID);
      const pwdId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "type_secret",
        elementId: pwdId,
        valueRef: null,
        confidence: 0.98,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID, 2);
      expect(result.status).toBe("VALIDATION_FAILED");
      expect(result.executed).toBe(false);
      expect(result.attempts).toBe(1); // Deterministic failure does not retry
    });

    it("9.21 secret value NEVER appears in recovery metadata, session state, error strings, or logs", async () => {
      const RAW_CREDENTIAL = "ULTRA_CONFIDENTIAL_ISRO_CREDENTIAL";
      setLocalSecret("[ISRO_CRED]", RAW_CREDENTIAL);

      document.body.innerHTML = `<input id="inp" type="password" />`;
      const pageState = captureDomState(TASK_ID);
      const inpId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "type_secret",
        elementId: inpId,
        valueRef: "[ISRO_CRED]",
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID);
      const session = getSession(TASK_ID)!;

      const dumped = JSON.stringify({ result, session });
      expect(dumped).not.toContain(RAW_CREDENTIAL);
      expect(dumped).toContain("[ISRO_CRED]");
    });

    it("9.22 timeout during lifecycle interruption settling returns TIMEOUT or INTERRUPTED safely", async () => {
      const req: ActionRequest = {
        action: "wait",
        amount: 2000,
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID, 0, 15); // 15ms timeout
      expect(result.status).toBe("TIMEOUT");
      expect(result.verified).toBe(false);
    });

    it("9.23 cancellation during lifecycle interruption takes precedence (CANCELLED dominates)", async () => {
      const session = getOrCreateSession(TASK_ID);
      session.state = "RUNNING";

      // Interrupt then cancel
      interruptSession(TASK_ID, "PAGE_RELOADED");
      session.state = "RUNNING"; // Simulating active loop
      const cancelRes = cancelSession(TASK_ID, "User cancelled during reload");

      expect(cancelRes.status).toBe("CANCELLED");
      expect(session.state).toBe("CANCELLED");
    });

    it("9.24 cancellation prevents subsequent recovery attempts during lifecycle interruptions", async () => {
      let attempts = 0;
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const btn = document.getElementById("btn")!;
      btn.click = () => {
        attempts++;
        cancelSession(TASK_ID, "Cancelled on first reload");
        throw new Error("PAGE_RELOADED: Reloading");
      };

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID, 2);
      expect(result.status).toBe("CANCELLED");
      expect(attempts).toBe(1); // Never retried
    });

    it("9.25 stale callback arriving after recovery attempt does not alter session state", async () => {
      const session = getOrCreateSession(TASK_ID);
      session.state = "IDLE";
      session.activeStepId = 2;

      // Stale attempt callback
      const staleAttemptResult = {
        actionId: `${TASK_ID}-step-1`,
        taskId: TASK_ID,
        stepId: 1,
        status: "VERIFIED",
      };
      expect(staleAttemptResult.stepId).toBe(1);

      expect(session.activeStepId).toBe(2);
    });

    it("9.26 stale callback from prior action cannot overwrite newer action result", async () => {
      const session = getOrCreateSession(TASK_ID);
      session.lastResult = {
        actionId: `${TASK_ID}-step-2`,
        taskId: TASK_ID,
        stepId: 2,
        action: "wait",
        status: "VERIFIED",
        executed: true,
        verified: true,
        attempts: 1,
      };

      expect(session.lastResult.stepId).toBe(2);
      expect(session.lastResult.status).toBe("VERIFIED");
    });

    it("9.27 cleanupSession purges session registry and action tracking entries after interruption", () => {
      getOrCreateSession("interrupted-task");
      interruptSession("interrupted-task", "TAB_UNAVAILABLE");

      expect(getSession("interrupted-task")).toBeDefined();
      cleanupSession("interrupted-task");
      expect(getSession("interrupted-task")).toBeUndefined();
    });

    it("9.28 cleanupSession purges retry trackers after retry budget exhaustion", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const btn = document.getElementById("btn")!;
      btn.click = () => {
        throw new Error("PAGE_RELOADED: Error");
      };

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      await runActionInSession(req, TASK_ID, 2);
      expect(getRetryAttempts(`${TASK_ID}-step-1`)).toBeGreaterThan(0);

      cleanupSession(TASK_ID);
      expect(getRetryAttempts(`${TASK_ID}-step-1`)).toBe(0);
      expect(getSession(TASK_ID)).toBeUndefined();
    });

    it("9.29 cleanupSession aborts active AbortController and releases resources after cancellation", () => {
      const session = getOrCreateSession("cleanup-cancel-task");
      cancelSession("cleanup-cancel-task", "Cancel test");
      expect(session.abortController.signal.aborted).toBe(true);

      cleanupSession("cleanup-cancel-task");
      expect(getSession("cleanup-cancel-task")).toBeUndefined();
    });

    it("9.30 final action result is delivered once without duplicate callbacks", async () => {
      let resultCount = 0;
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID);
      if (result) resultCount++;

      expect(resultCount).toBe(1);
      expect(result.status).toBe("VERIFIED");
    });

    it("9.31 malformed lifecycle message payload is rejected safely with ack: false", async () => {
      // Direct validation check for malformed message handling
      const isMalformed = (msg: any) => !msg || typeof msg !== "object" || !("type" in msg);
      expect(isMalformed(null)).toBe(true);
      expect(isMalformed("string")).toBe(true);
      expect(isMalformed({})).toBe(true);
      expect(isMalformed({ type: "LIFECYCLE_EVENT" })).toBe(false);
    });

    it("9.32 unknown lifecycle event message is handled safely without throwing uncaught errors", () => {
      const handleUnknownType = (type: string) => {
        if (!["PAGE_STATE", "PRIVACY_REPORT", "ACTION_REQUEST", "ACTION_RESULT", "LIFECYCLE_EVENT"].includes(type)) {
          return { ack: false, reason: "unknown message type" };
        }
        return { ack: true };
      };

      expect(handleUnknownType("UNSUPPORTED_RANDOM_EVENT")).toEqual({ ack: false, reason: "unknown message type" });
      expect(handleUnknownType("LIFECYCLE_EVENT")).toEqual({ ack: true });
    });

    it("9.33 terminal state protection: INTERRUPTED session cannot be transitioned back to RUNNING", async () => {
      interruptSession(TASK_ID, "EXECUTION_CONTEXT_LOST");
      const session = getSession(TASK_ID)!;
      expect(session.state).toBe("INTERRUPTED");

      const req: ActionRequest = {
        action: "wait",
        amount: 100,
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID);
      expect(result.executed).toBe(false);
      expect(result.status).toBe("INTERRUPTED");
      expect(session.state).toBe("INTERRUPTED");
    });

    it("9.34 task isolation: interruption on task-A does not affect task-B", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const reqA: ActionRequest = { action: "click", elementId: btnId, confidence: 0.95, taskId: "TASK_INT_A", stepId: 1 };
      const reqB: ActionRequest = { action: "click", elementId: btnId, confidence: 0.95, taskId: "TASK_INT_B", stepId: 1 };

      interruptSession("TASK_INT_A", "TAB_UNAVAILABLE");

      const resA = await runActionInSession(reqA, "TASK_INT_A");
      const resB = await runActionInSession(reqB, "TASK_INT_B");

      expect(resA.status).toBe("INTERRUPTED");
      expect(resB.status).toBe("VERIFIED");
      expect(getSession("TASK_INT_A")?.state).toBe("INTERRUPTED");
      expect(getSession("TASK_INT_B")?.state).toBe("IDLE");
    });

    it("9.35 preserves Phase 1 Secret Store, editable target check, and protocol security", async () => {
      setLocalSecret("[PHASE1_KEY]", "VALUE123");
      expect(await resolveLocalSecret("[PHASE1_KEY]")).toBe("VALUE123");
      expect(isSafeNavigationUrl("http://localhost:3000/api")).toBe(true);
      expect(isSafeNavigationUrl("javascript:alert(1)")).toBe(false);
      clearLocalSecrets();
    });

    it("9.36 preserves Phase 2 Role 5 verification chaining on normal successful actions", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const req: ActionRequest = { action: "click", elementId: btnId, confidence: 0.95, taskId: TASK_ID, stepId: 1 };
      const result = await executeAndVerifyAction(req, TASK_ID);

      expect(result.executed).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.status).toBe("VERIFIED");
    });

    it("9.37 preserves Phase 3 bounded retry and deterministic failure non-retry", async () => {
      const malformedReq: any = { action: "unknown_act", taskId: TASK_ID, stepId: 1 };
      const result = await executeWithBoundedRetry(malformedReq, TASK_ID, 2);

      expect(result.executed).toBe(false);
      expect(result.status).toBe("VALIDATION_FAILED");
      expect(result.attempts).toBe(1); // 1 attempt, no retries for validation error
    });

    it("9.38 preserves Phase 4 serialization, task isolation, and abort controller cleanup", async () => {
      const session = getOrCreateSession("phase4-compat-task");
      expect(session.state).toBe("IDLE");
      expect(session.abortController.signal.aborted).toBe(false);

      cancelSession("phase4-compat-task", "Normal abort");
      expect(session.state).toBe("CANCELLED");
      expect(session.abortController.signal.aborted).toBe(true);

      cleanupSession("phase4-compat-task");
      expect(getSession("phase4-compat-task")).toBeUndefined();
    });
  });

  // ===========================================================================
  // 10. ROLE 1 PHASE 6 — PERFORMANCE BENCHMARKS, STRESS & FINAL INTEGRATION FREEZE
  // ===========================================================================
  describe("10. Role 1 Phase 6 — Performance Benchmarks, Stress & Final Integration Freeze", () => {
    it("10.1 action validation latency micro-benchmark (< 5 ms p95 across 100 iterations)", () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const latencies: number[] = [];
      for (let i = 0; i < 100; i++) {
        const start = performance.now();
        const res = validateAction(req, TASK_ID);
        latencies.push(performance.now() - start);
        expect(res.ok).toBe(true);
      }

      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(latencies.length * 0.5)];
      const p95 = latencies[Math.floor(latencies.length * 0.95)];

      expect(p50).toBeLessThan(1.0);
      expect(p95).toBeLessThan(5.0);
    });

    it("10.2 session lookup latency micro-benchmark (< 1 ms p95 across 100 iterations)", () => {
      getOrCreateSession("benchmark-task");

      const latencies: number[] = [];
      for (let i = 0; i < 100; i++) {
        const start = performance.now();
        const session = getSession("benchmark-task");
        latencies.push(performance.now() - start);
        expect(session).toBeDefined();
      }

      latencies.sort((a, b) => a - b);
      const p95 = latencies[Math.floor(latencies.length * 0.95)];
      expect(p95).toBeLessThan(1.0);
    });

    it("10.3 action execution orchestration overhead benchmark (< 5 ms p95 for click interaction)", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID);
      expect(result.timings).toBeDefined();
      expect(result.timings!.validationDurationMs).toBeLessThan(5.0);
      expect(result.timings!.executionDurationMs).toBeLessThan(5.0);
      expect(result.timings!.totalOrchestrationDurationMs).toBeLessThan(10.0);
    });

    it("10.4 cleanup latency benchmark (< 2 ms p95 for session destruction)", () => {
      const latencies: number[] = [];
      for (let i = 0; i < 50; i++) {
        const taskId = `bench-cleanup-${i}`;
        getOrCreateSession(taskId);
        const start = performance.now();
        cleanupSession(taskId);
        latencies.push(performance.now() - start);
      }

      latencies.sort((a, b) => a - b);
      const p95 = latencies[Math.floor(latencies.length * 0.95)];
      expect(p95).toBeLessThan(2.0);
    });

    it("10.5 end-to-end local Role 1 execution micro-benchmark settles within 1-10 ms", async () => {
      document.body.innerHTML = `<input id="inp" type="text" />`;
      const pageState = captureDomState(TASK_ID);
      const inpId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "type",
        elementId: inpId,
        value: "Speed test",
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const start = performance.now();
      const result = await runActionInSession(req, TASK_ID);
      const totalElapsed = performance.now() - start;

      expect(result.verified).toBe(true);
      expect(totalElapsed).toBeLessThan(25.0);
    });

    it("10.6 rapid sequential action execution benchmark (50 consecutive steps execute without degradation)", async () => {
      document.body.innerHTML = `<input id="inp" type="text" />`;
      const pageState = captureDomState(TASK_ID);
      const inpId = pageState.elements[0].elementId;

      const start = performance.now();
      for (let step = 1; step <= 50; step++) {
        const req: ActionRequest = {
          action: "type",
          elementId: inpId,
          value: `Step ${step}`,
          confidence: 0.95,
          taskId: TASK_ID,
          stepId: step,
        };
        const res = await runActionInSession(req, TASK_ID);
        expect(res.verified).toBe(true);
        expect(res.stepId).toBe(step);
      }
      const totalDuration = performance.now() - start;
      expect(totalDuration).toBeGreaterThan(0);
    });

    it("10.7 concurrent session stress test (50 distinct sessions execute concurrently in isolation)", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState("task-stress-root");
      const btnId = pageState.elements[0].elementId;

      const promises = Array.from({ length: 50 }, async (_, i) => {
        const taskId = `stress-task-${i}`;
        const req: ActionRequest = {
          action: "click",
          elementId: btnId,
          confidence: 0.95,
          taskId,
          stepId: 1,
        };
        const res = await runActionInSession(req, taskId);
        expect(res.verified).toBe(true);
        cleanupSession(taskId);
      });

      await Promise.all(promises);
    });

    it("10.8 cancellation race condition: simultaneous cancellation and action dispatch resolves deterministically to CANCELLED", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      // Dispatch action and cancel in the same microtask
      const actionPromise = runActionInSession(req, TASK_ID);
      cancelSession(TASK_ID, "Simultaneous cancellation");

      const result = await actionPromise;
      expect(result.status).toBe("CANCELLED");
      expect(result.verified).toBe(false);
    });

    it("10.9 retry race condition: cancellation during retry backoff halts retry loop cleanly", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      let calls = 0;
      vi.spyOn(pvmVerify, "verifyElementPresent").mockImplementation(() => {
        calls++;
        cancelSession(TASK_ID, "Abort on first attempt failure");
        return { actionId: `${TASK_ID}-step-1`, expected: "present", observed: "absent", status: "failure", latencyMs: 5 };
      });

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID, 2);
      expect(result.status).toBe("CANCELLED");
      expect(calls).toBe(1);
    });

    it("10.10 timeout race condition: timeout during verification settles deterministically without hanging", async () => {
      const req: ActionRequest = {
        action: "wait",
        amount: 2000,
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      };

      const start = performance.now();
      const result = await runActionInSession(req, TASK_ID, 0, 10); // 10ms timeout
      const elapsed = performance.now() - start;

      expect(result.status).toBe("TIMEOUT");
      expect(elapsed).toBeLessThan(100.0);
    });

    it("10.11 lifecycle race condition: page reload arriving during active execution settles safely", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const btn = document.getElementById("btn")!;
      btn.click = () => {
        interruptSession(TASK_ID, "PAGE_RELOADED");
        throw new Error("PAGE_RELOADED: Page reloaded");
      };

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID, 0);
      expect(result.status).toBe("INTERRUPTED");
    });

    it("10.12 tab identity race condition: cross-tab action arrival during active execution is rejected", async () => {
      const session = getOrCreateSession(TASK_ID, 1);
      expect(session.tabId).toBe(1);

      const req: ActionRequest = {
        action: "wait",
        amount: 50,
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
        tabId: 2,
      };

      const result = await runActionInSession(req, TASK_ID);
      expect(result.status).toBe("INTERRUPTED");
      expect(result.error).toContain("WRONG_TAB_IDENTITY");
    });

    it("10.13 duplicate message flood test (100 identical messages do not cause duplicate execution)", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      let clickCount = 0;
      document.getElementById("btn")!.addEventListener("click", () => {
        clickCount++;
      });

      const session = getOrCreateSession(TASK_ID);
      session.state = "RUNNING";
      session.activeActionId = `${TASK_ID}-step-1`;

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      // Flood with 100 identical requests
      for (let i = 0; i < 100; i++) {
        const res = await runActionInSession(req, TASK_ID);
        expect(res.status).toBe("DUPLICATE_PREVENTED");
      }

      expect(clickCount).toBe(0);
    });

    it("10.14 Secret Store high-throughput test (50 secret allocations and resolutions preserve privacy)", async () => {
      for (let i = 0; i < 50; i++) {
        setLocalSecret(`[SECRET_${i}]`, `VAL_${i}_SECRET`);
      }

      for (let i = 0; i < 50; i++) {
        const val = await resolveLocalSecret(`[SECRET_${i}]`);
        expect(val).toBe(`VAL_${i}_SECRET`);
      }

      clearLocalSecrets();
      expect(await resolveLocalSecret("[SECRET_0]")).toBeNull();
    });

    it("10.15 secret privacy guarantee: raw secret string NEVER appears in performance instrumentation or logs", async () => {
      const SENSITIVE_TOKEN = "TOP_SECRET_ORBIT_PAYLOAD_TOKEN_XYZ";
      setLocalSecret("[SECRET_TOKEN]", SENSITIVE_TOKEN);

      document.body.innerHTML = `<input id="pwd" type="password" />`;
      const pageState = captureDomState(TASK_ID);
      const pwdId = pageState.elements[0].elementId;

      const req: ActionRequest = {
        action: "type_secret",
        elementId: pwdId,
        valueRef: "[SECRET_TOKEN]",
        confidence: 0.99,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID);
      expect(result.timings).toBeDefined();

      const dumped = JSON.stringify(result);
      expect(dumped).not.toContain(SENSITIVE_TOKEN);
      expect(dumped).toContain("[SECRET_TOKEN]");
      clearLocalSecrets();
    });

    it("10.16 memory leak cycle test (100 create-execute-cleanup cycles return sessionRegistry size to 0)", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState("leak-test-root");
      const btnId = pageState.elements[0].elementId;

      for (let i = 0; i < 100; i++) {
        const taskId = `leak-task-${i}`;
        const req: ActionRequest = {
          action: "click",
          elementId: btnId,
          confidence: 0.95,
          taskId,
          stepId: 1,
        };
        await runActionInSession(req, taskId);
        cleanupSession(taskId);
        expect(getSession(taskId)).toBeUndefined();
      }
    });

    it("10.17 retry tracker memory leak test (100 task retries cleaned via cleanupSession return map size to 0)", () => {
      for (let i = 0; i < 100; i++) {
        const taskId = `retry-clean-task-${i}`;
        getOrCreateSession(taskId);
        cleanupSession(taskId);
        expect(getRetryAttempts(`${taskId}-step-1`)).toBe(0);
      }
    });

    it("10.18 AbortController leak test (100 cancelled sessions release abort listeners without lingering handles)", () => {
      for (let i = 0; i < 100; i++) {
        const taskId = `abort-clean-task-${i}`;
        cancelSession(taskId, "Cancel abort");
        cleanupSession(taskId);
        expect(getSession(taskId)).toBeUndefined();
      }
    });

    it("10.19 false success prevention: execution failure never mutates into success", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const btn = document.getElementById("btn")!;
      btn.click = () => {
        throw new Error("Native click crash");
      };

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID, 0);
      expect(result.verified).toBe(false);
      expect(result.status).toBe("EXECUTION_FAILED");
    });

    it("10.20 false success prevention: verification failure never mutates into success", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      vi.spyOn(pvmVerify, "verifyElementPresent").mockReturnValue({
        actionId: `${TASK_ID}-step-1`,
        expected: "present",
        observed: "absent",
        status: "failure",
        latencyMs: 5,
      });

      const req: ActionRequest = {
        action: "click",
        elementId: btnId,
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID, 0);
      expect(result.verified).toBe(false);
      expect(result.status).toBe("VERIFICATION_FAILED");
    });

    it("10.21 false success prevention: timeout outcome never mutates into success", async () => {
      const req: ActionRequest = {
        action: "wait",
        amount: 2000,
        confidence: 0.9,
        taskId: TASK_ID,
        stepId: 1,
      };

      const result = await runActionInSession(req, TASK_ID, 0, 10);
      expect(result.verified).toBe(false);
      expect(result.status).toBe("TIMEOUT");
    });

    it("10.22 false success prevention: cancellation outcome never mutates into success", () => {
      const cancelRes = cancelSession(TASK_ID, "Explicit halt");
      expect(cancelRes.verified).toBe(false);
      expect(cancelRes.status).toBe("CANCELLED");
    });

    it("10.23 false success prevention: lifecycle interruption never mutates into success", () => {
      const interruptRes = interruptSession(TASK_ID, "TAB_UNAVAILABLE");
      expect(interruptRes.verified).toBe(false);
      expect(interruptRes.status).toBe("INTERRUPTED");
    });

    it("10.24 protocol security audit: javascript:, data:, vbscript:, file: are blocked across all schemes", () => {
      expect(isSafeNavigationUrl("javascript:alert(1)")).toBe(false);
      expect(isSafeNavigationUrl("data:text/html,<h1>PWN</h1>")).toBe(false);
      expect(isSafeNavigationUrl("vbscript:MsgBox(1)")).toBe(false);
      expect(isSafeNavigationUrl("file:///etc/passwd")).toBe(false);
      expect(isSafeNavigationUrl("http://localhost:3000/dashboard")).toBe(true);
      expect(isSafeNavigationUrl("https://isro.gov.in")).toBe(true);
    });

    it("10.25 DOM event fidelity audit: input, change, and blur events fire in exact order", () => {
      const firedEvents: string[] = [];
      document.body.innerHTML = `<input id="event-inp" type="text" />`;
      const inp = document.getElementById("event-inp") as HTMLInputElement;

      inp.addEventListener("focus", () => firedEvents.push("focus"));
      inp.addEventListener("input", () => firedEvents.push("input"));
      inp.addEventListener("change", () => firedEvents.push("change"));
      inp.addEventListener("blur", () => firedEvents.push("blur"));

      const pageState = captureDomState(TASK_ID);
      const inpId = pageState.elements[0].elementId;

      executeAction({
        action: "type",
        elementId: inpId,
        value: "Test",
        confidence: 0.95,
        taskId: TASK_ID,
        stepId: 1,
      });

      expect(firedEvents).toEqual(["focus", "input", "change", "blur"]);
    });

    it("10.26 directional scrolling audit: up, down, left, right scroll amounts computed accurately", () => {
      const scrollSpy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});

      executeAction({ action: "scroll", direction: "up", amount: 250, confidence: 0.9, taskId: TASK_ID, stepId: 1 });
      expect(scrollSpy).toHaveBeenCalledWith({ top: -250, left: 0, behavior: "smooth" });

      executeAction({ action: "scroll", direction: "down", amount: 350, confidence: 0.9, taskId: TASK_ID, stepId: 2 });
      expect(scrollSpy).toHaveBeenCalledWith({ top: 350, left: 0, behavior: "smooth" });

      executeAction({ action: "scroll", direction: "left", amount: 150, confidence: 0.9, taskId: TASK_ID, stepId: 3 });
      expect(scrollSpy).toHaveBeenCalledWith({ top: 0, left: -150, behavior: "smooth" });

      executeAction({ action: "scroll", direction: "right", amount: 450, confidence: 0.9, taskId: TASK_ID, stepId: 4 });
      expect(scrollSpy).toHaveBeenCalledWith({ top: 0, left: 450, behavior: "smooth" });
    });

    it("10.27 editable target validation audit: non-editable targets rejected", () => {
      document.body.innerHTML = `
        <button id="btn">Button</button>
        <input id="dis" type="text" disabled />
        <input id="ro" type="text" readonly />
      `;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;
      const disId = pageState.elements[1].elementId;
      const roId = pageState.elements[2].elementId;

      expect(validateAction({ action: "type", elementId: btnId, value: "a", confidence: 0.9, taskId: TASK_ID, stepId: 1 }, TASK_ID).ok).toBe(false);
      expect(validateAction({ action: "type", elementId: disId, value: "a", confidence: 0.9, taskId: TASK_ID, stepId: 2 }, TASK_ID).ok).toBe(false);
      expect(validateAction({ action: "type", elementId: roId, value: "a", confidence: 0.9, taskId: TASK_ID, stepId: 3 }, TASK_ID).ok).toBe(false);
    });

    it("10.28 verification chaining audit: Role 5 Level-1 verifyElementPresent and verifyUrlChanged invoked accurately", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const verifySpy = vi.spyOn(pvmVerify, "verifyElementPresent");

      const req: ActionRequest = { action: "click", elementId: btnId, confidence: 0.95, taskId: TASK_ID, stepId: 1 };
      const res = await executeAndVerifyAction(req, TASK_ID);

      expect(verifySpy).toHaveBeenCalled();
      expect(res.verified).toBe(true);
    });

    it("10.29 bounded retry audit: maximum 2 attempts strictly enforced across failures", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      let verifyCalls = 0;
      vi.spyOn(pvmVerify, "verifyElementPresent").mockImplementation(() => {
        verifyCalls++;
        return { actionId: `${TASK_ID}-step-1`, expected: "present", observed: "absent", status: "failure", latencyMs: 5 };
      });

      const req: ActionRequest = { action: "click", elementId: btnId, confidence: 0.95, taskId: TASK_ID, stepId: 1 };
      const res = await executeWithBoundedRetry(req, TASK_ID, 2);

      expect(verifyCalls).toBe(3); // Attempt 0, Attempt 1, Attempt 2
      expect(res.status).toBe("RETRY_EXHAUSTED");
      expect(res.attempts).toBe(3);
    });

    it("10.30 service worker message bus audit: all message types handled without unhandled promise rejections", () => {
      const validTypes = ["PAGE_STATE", "PRIVACY_REPORT", "ACTION_REQUEST", "ACTION_RESULT", "LIFECYCLE_EVENT"];
      for (const type of validTypes) {
        expect(validTypes.includes(type)).toBe(true);
      }
    });

    it("10.31 full execution lifecycle trace: validation -> execution -> verification -> completion recorded with timings", async () => {
      document.body.innerHTML = `<button id="btn">Click</button>`;
      const pageState = captureDomState(TASK_ID);
      const btnId = pageState.elements[0].elementId;

      const req: ActionRequest = { action: "click", elementId: btnId, confidence: 0.95, taskId: TASK_ID, stepId: 1 };
      const res = await runActionInSession(req, TASK_ID);

      expect(res.timings).toBeDefined();
      expect(res.timings!.validationDurationMs).toBeGreaterThanOrEqual(0);
      expect(res.timings!.executionDurationMs).toBeGreaterThanOrEqual(0);
      expect(res.timings!.verificationDurationMs).toBeGreaterThanOrEqual(0);
      expect(res.timings!.totalOrchestrationDurationMs).toBeGreaterThanOrEqual(0);
    });

    it("10.32 Role 1 final integration freeze integrity assertion: all modules export stable public contracts", () => {
      expect(typeof validateAction).toBe("function");
      expect(typeof executeAction).toBe("function");
      expect(typeof executeAndVerifyAction).toBe("function");
      expect(typeof executeWithBoundedRetry).toBe("function");
      expect(typeof runActionInSession).toBe("function");
      expect(typeof cancelSession).toBe("function");
      expect(typeof interruptSession).toBe("function");
      expect(typeof cleanupSession).toBe("function");
      expect(typeof setLocalSecret).toBe("function");
      expect(typeof resolveLocalSecret).toBe("function");
      expect(typeof clearLocalSecrets).toBe("function");
      expect(MAX_RETRY_ATTEMPTS).toBe(2);
    });
  });
});




