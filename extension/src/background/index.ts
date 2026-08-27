import { onMessage } from "../messaging/bus";

/**
 * MV3 service workers are torn down after ~30s idle and wake with no
 * memory — never hold state in module-level variables here beyond a
 * single message-handling tick. Anything that must persist lives in
 * pvm/memory.ts (IndexedDB) or chrome.storage, not in this file. See
 * PS26171_Role1_Extension.pdf, Day 2.
 */
onMessage((message, sender) => {
  switch (message.type) {
    case "PAGE_STATE":
      console.log("[background] page state from tab", sender.tab?.id, message.payload);
      return Promise.resolve({ ack: true });
    case "PRIVACY_REPORT":
      console.log("[background] privacy report", message.payload);
      return Promise.resolve({ ack: true });
    case "ACTION_REQUEST":
      console.log("[background] action request", message.payload);
      return Promise.resolve({ ack: true });
    case "ACTION_RESULT":
      console.log("[background] verification result", message.payload);
      return Promise.resolve({ ack: true });
    default:
      return Promise.resolve({ ack: false, reason: "unknown message type" });
  }
});

console.log("PrivyVision background service worker started.");
