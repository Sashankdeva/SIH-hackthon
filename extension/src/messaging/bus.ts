import type { ActionRequest } from "../action/types";
import type { PageState } from "../perception/types";
import type { PrivacyReport } from "../privacy/types";
import type { VerificationResult } from "../pvm/types";

/**
 * Typed message contract between content script, background service
 * worker, and popup. Every module imports its message shape from here
 * rather than inlining ad-hoc objects — one place to change when a
 * payload shape changes.
 */
export type Message =
  | { type: "PAGE_STATE"; payload: PageState }
  | { type: "PRIVACY_REPORT"; payload: PrivacyReport }
  | { type: "ACTION_REQUEST"; payload: ActionRequest }
  | { type: "ACTION_RESULT"; payload: VerificationResult }
  | {
      type: "LIFECYCLE_EVENT";
      payload: { event: string; taskId?: string; tabId?: number; details?: string };
    };

export async function sendMessage<T extends Message>(message: T): Promise<unknown> {
  if (
    typeof chrome === "undefined" ||
    !chrome.runtime ||
    typeof chrome.runtime.sendMessage !== "function"
  ) {
    throw new Error("MESSAGE_CHANNEL_LOST: Chrome extension runtime unavailable");
  }
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (
      errMsg.includes("Receiving end does not exist") ||
      errMsg.includes("Could not establish connection")
    ) {
      throw new Error(`CONTENT_SCRIPT_UNAVAILABLE: ${errMsg}`);
    }
    if (errMsg.includes("Extension context invalidated")) {
      throw new Error(`EXECUTION_CONTEXT_LOST: ${errMsg}`);
    }
    throw new Error(`MESSAGE_CHANNEL_LOST: ${errMsg}`);
  }
}

export function onMessage(
  handler: (
    message: Message,
    sender: chrome.runtime.MessageSender
  ) => void | Promise<unknown>
): void {
  if (
    typeof chrome === "undefined" ||
    !chrome.runtime ||
    typeof chrome.runtime.onMessage?.addListener !== "function"
  ) {
    return;
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      const result = handler(message as Message, sender);
      if (result instanceof Promise) {
        result
          .then(sendResponse)
          .catch((err) => {
            sendResponse({
              ack: false,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        return true; // keep the message channel open for the async response
      }
    } catch (err) {
      sendResponse({
        ack: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    return false;
  });
}
