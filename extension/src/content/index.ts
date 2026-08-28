import { captureDomState } from "../perception/domCapture";
import { detectTier1 } from "../privacy/tier1DomRules";
import { redact } from "../privacy/redact";
import { buildSanitizedContext, toWireSanitizedContext } from "../privacy/sanitizedContext";
import { sendMessage } from "../messaging/bus";
import { fromWireActionResponse, type WireActionResponse } from "../action/types";
import { runActionInSession, cleanupSession } from "../action/session";

const taskId = crypto.randomUUID();

async function run(): Promise<void> {
  const pageState = captureDomState(taskId);
  await sendMessage({ type: "PAGE_STATE", payload: pageState });

  const detections = detectTier1(pageState.elements);
  const redactions = redact(detections);
  await sendMessage({
    type: "PRIVACY_REPORT",
    payload: { taskId, detections, redactions },
  });

  // Privacy Firewall: this is the only object allowed to leave the
  // browser. If it's null, redaction coverage failed and nothing is
  // sent — see privacy/sanitizedContext.ts.
  const sanitized = buildSanitizedContext(pageState, detections, redactions);
  if (!sanitized) {
    console.warn("[content] privacy firewall blocked transmission — incomplete redaction coverage");
    return;
  }

  // Convert to wire format conforming to shared/schemas/sanitized-context.schema.json
  const wirePayload = toWireSanitizedContext(sanitized);

  try {
    const response = await fetch("http://localhost:8000/reason", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(wirePayload),
    });

    if (response.ok) {
      const wireAction: WireActionResponse = await response.json();
      const actionReq = fromWireActionResponse(wireAction);
      const result = await runActionInSession(actionReq, taskId);
      if (result.verified) {
        console.log("[content] action executed and verified successfully:", result);
      } else {
        console.warn("[content] action execution/verification outcome:", result);
      }
    } else {
      console.warn("[content] server returned error status:", response.status);
    }
  } catch (err) {
    // Safe failure: server offline or network unavailable does not crash browser
    console.warn("[content] server connection unavailable:", err);
  } finally {
    // Cleanup temporary session resources
    cleanupSession(taskId);
  }
}

run().catch((err) => console.error("[content] pipeline execution failed", err));
