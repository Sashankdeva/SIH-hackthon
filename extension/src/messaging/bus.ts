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
  | { type: "PRIVACY_BLOCKED"; payload: { taskId: string; missingElementIds: number[] } }
  /** Popup -> content script: the user typed a task and pressed Run. */
  | { type: "RUN_TASK"; payload: { task: string } }
  | { type: "ACTION_REQUEST"; payload: ActionRequest }
  | { type: "ACTION_RESULT"; payload: VerificationResult };

export function sendMessage<T extends Message>(message: T): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
}

export function onMessage(
  handler: (message: Message, sender: chrome.runtime.MessageSender) => void | Promise<unknown>
): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const result = handler(message as Message, sender);
    if (result instanceof Promise) {
      result.then(sendResponse);
      return true; // keep the message channel open for the async response
    }
    return false;
  });
}
