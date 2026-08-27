import { captureDomState } from "../perception/domCapture";
import { detectTier1 } from "../privacy/tier1DomRules";
import { redact } from "../privacy/redact";
import { buildSanitizedContext } from "../privacy/sanitizedContext";
import { sendMessage } from "../messaging/bus";

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
  console.log("[content] sanitized context ready to send:", sanitized);

  // Day 2 (Server AI + Extension): POST `sanitized` to the server's
  // /reason endpoint here once the schema is frozen, then hand the
  // response to action/validator.ts before executeAction() ever runs.
}

run().catch((err) => console.error("[content] capture failed", err));
