import type { ActionRequest } from "../action/types";
import type { PageState } from "../perception/types";
import type { PrivacyReport } from "../privacy/types";
import type { VerificationResult } from "../pvm/types";

export interface ReasonRequestPayload {
  payload: Record<string, unknown>;
  serverUrl?: string;
  timeoutMs?: number;
}

export interface CompleteRequestPayload {
  payload: Record<string, unknown>;
  serverUrl?: string;
  timeoutMs?: number;
}

export interface HealthCheckPayload {
  serverUrl?: string;
  timeoutMs?: number;
}

export interface ProxyResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  errorClass?:
    | "network_error"
    | "request_timeout"
    | "http_error"
    | "auth_error"
    | "invalid_json"
    | "empty_response"
    | "service_worker_unavailable"
    | "server_error";
  /**
   * Safe, bounded error code taken from the server's JSON error body on a
   * non-2xx response (e.g. "invalid_request", "action_rejected"). Only set
   * when the value is a short slug ([a-z0-9_], <= 40 chars) — never a free-form
   * string and never a raw response body. Diagnostics only.
   */
  serverErrorCode?: string;
  /**
   * Bounded, allow-listed detail string from the server's JSON error body.
   * Only forwarded for a small set of known-safe serverErrorCode values and
   * truncated to a hard length cap. Redaction tokens ([EMAIL_01] …) are safe
   * by construction; raw typed values are never echoed here by the server.
   */
  serverDetail?: string;
}

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
  | { type: "ACTION_RESULT"; payload: VerificationResult }
  | {
      type: "LIFECYCLE_EVENT";
      payload: { event: string; taskId?: string; tabId?: number; details?: string };
    }
  | { type: "REASON_REQUEST"; payload: ReasonRequestPayload }
  | { type: "COMPLETE_REQUEST"; payload: CompleteRequestPayload }
  | { type: "HEALTH_CHECK"; payload: HealthCheckPayload }
  /**
   * Content script → background: "what tab am I running in?"
   * Background resolves via sender.tab.id and returns { tabId: number | null }.
   * Used by checkAndResumeActiveTask() for tab-ownership verification.
   */
  | { type: "GET_TAB_ID" };

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
    if (
      errMsg.includes("back/forward cache") ||
      errMsg.includes("message channel is closed") ||
      errMsg.includes("message port closed")
    ) {
      throw new Error(`BFCACHE_CHANNEL_CLOSED: ${errMsg}`);
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
