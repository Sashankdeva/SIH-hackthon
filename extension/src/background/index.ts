import { onMessage } from "../messaging/bus";

/**
 * MV3 service workers are torn down after ~30s idle and wake with no
 * memory — never hold state in module-level variables here beyond a
 * single message-handling tick. Anything that must persist (for the
 * popup to read) goes to chrome.storage.local, not a variable in this
 * file. See PS26171_Role1_Extension.pdf, Day 2.
 */
onMessage((message, sender) => {
  if (!message || typeof message !== "object" || !("type" in message)) {
    return Promise.resolve({ ack: false, reason: "malformed message" });
  }

  switch (message.type) {
    case "PAGE_STATE":
      console.log("[background] page state from tab", sender.tab?.id, message.payload);
      return Promise.resolve({ ack: true });

    case "PRIVACY_REPORT":
      console.log("[background] privacy report", message.payload);
      return chrome.storage.local.set({
        latestPrivacyReport: message.payload,
        latestStatus: "allowed",
        updatedAt: Date.now(),
      });

    case "PRIVACY_BLOCKED":
      console.warn("[background] privacy firewall blocked a page", message.payload);
      return chrome.storage.local.set({
        latestStatus: "blocked",
        // ISSUE-17: store only missingElementIds — taskId is not read by the popup
        // and storing it is unnecessary structural metadata retention.
        latestBlockedPayload: { missingElementIds: (message.payload as { taskId: string; missingElementIds: number[] }).missingElementIds },
        updatedAt: Date.now(),
      });

    case "ACTION_REQUEST":
      console.log("[background] action request", message.payload);
      return Promise.resolve({ ack: true });

    case "ACTION_RESULT":
      console.log("[background] verification result", message.payload);
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        return chrome.storage.local.set({
          latestVerification: message.payload,
          updatedAt: Date.now(),
        }).then(() => ({ ack: true }));
      }
      return Promise.resolve({ ack: true });

    case "LIFECYCLE_EVENT":
      console.log("[background] lifecycle event from tab", sender.tab?.id, message.payload);
      return Promise.resolve({ ack: true, event: message.payload?.event });

    default:
      return Promise.resolve({ ack: false, reason: "unknown message type" });
  }
});

console.log("PrivyVision background service worker started.");
