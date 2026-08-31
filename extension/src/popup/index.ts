import type { PrivacyReport } from "../privacy/types";
import type { VerificationResult } from "../pvm/types";
import { loadProfile, saveProfile, type Profile, type ProfileField } from "../privacy/profileStore";
import type { ActiveTaskState } from "../action/types";

/**
 * Privacy inspector UI — Day 3, PS26171_Role3_Privacy.pdf /
 * PS26171_Role6_Integration.pdf. Informational only; the Privacy
 * Firewall (privacy/sanitizedContext.ts) is the real enforcement point.
 * This view must never display raw sensitive values — everything read
 * out of storage here is already a category label or a redaction
 * token, never a real value, because that's all the background script
 * ever persists (see background/index.ts).
 */
interface StoredState {
  latestStatus?: "allowed" | "blocked";
  latestPrivacyReport?: PrivacyReport;
  // ISSUE-17: taskId removed — popup does not use it and storing it is unnecessary
  // structural metadata. Only missingElementIds are needed for the display.
  latestBlockedPayload?: { missingElementIds: number[] };
  latestVerification?: VerificationResult;
  latestPayloadSha256?: string;
  updatedAt?: number;
}

function el(tag: string, opts: { text?: string; className?: string } = {}): HTMLElement {
  const node = document.createElement(tag);
  if (opts.text) node.textContent = opts.text;
  if (opts.className) node.className = opts.className;
  return node;
}

function render(state: StoredState, container: HTMLElement): void {
  container.innerHTML = "";

  if (!state.updatedAt) {
    container.appendChild(el("p", { text: "No page captured yet — open a tab with the extension active." }));
    return;
  }

  const statusRow = el("div", { className: "status-row" });
  if (state.latestStatus === "blocked") {
    statusRow.appendChild(el("span", { className: "badge badge-blocked", text: "BLOCKED" }));
    statusRow.appendChild(
      el("span", { className: "status-text", text: "Redaction coverage was incomplete — nothing was sent." })
    );
  } else if (state.latestStatus === "allowed") {
    statusRow.appendChild(el("span", { className: "badge badge-allowed", text: "SANITIZED" }));
    statusRow.appendChild(el("span", { className: "status-text", text: "Only redaction tokens left the browser." }));
  }
  container.appendChild(statusRow);

  const report = state.latestPrivacyReport;
  if (report && report.redactions.length > 0) {
    const section = el("div", { className: "section" });
    section.appendChild(el("h2", { text: `Redacted this page (${report.redactions.length})` }));
    const list = el("ul");
    for (const r of report.redactions) {
      list.appendChild(el("li", { text: `${r.category} → ${r.token} (${r.method})` }));
    }
    section.appendChild(list);
    container.appendChild(section);
  } else if (state.latestStatus === "allowed") {
    container.appendChild(el("p", { className: "muted", text: "No sensitive fields detected on this page." }));
  }

  if (state.latestBlockedPayload) {
    const section = el("div", { className: "section" });
    section.appendChild(
      el("p", {
        className: "muted",
        text: `Missing redaction for element id(s): ${state.latestBlockedPayload.missingElementIds.join(", ")}`,
      })
    );
    container.appendChild(section);
  }

  const verification = state.latestVerification;
  if (verification) {
    const section = el("div", { className: "section" });
    section.appendChild(el("h2", { text: "Last action" }));
    const statusClass =
      verification.status === "success" ? "badge-allowed" : verification.status === "failure" ? "badge-blocked" : "badge-ambiguous";
    const row = el("div", { className: "status-row" });
    row.appendChild(el("span", { className: `badge ${statusClass}`, text: verification.status.toUpperCase() }));
    row.appendChild(el("span", { className: "status-text", text: `${verification.latencyMs}ms` }));
    section.appendChild(row);
    container.appendChild(section);
  }

  if (state.latestPayloadSha256) {
    const section = el("div", { className: "section" });
    section.appendChild(el("h2", { text: "Proof — outbound payload hash" }));
    section.appendChild(
      el("p", {
        className: "muted",
        text: "Compare this against the same request's entry in server/logs/reason_requests.jsonl. A match proves this exact hash is what the server actually received.",
      })
    );
    const hashBox = el("p", { className: "hash", text: state.latestPayloadSha256 });
    section.appendChild(hashBox);
    container.appendChild(section);
  }

  container.appendChild(el("p", { className: "timestamp", text: `Updated ${new Date(state.updatedAt).toLocaleTimeString()}` }));
}

const DEFAULT_SERVER_URL = "http://127.0.0.1:8787/reason";

/**
 * Renders the failed-task line. `lastDetail` already carries a safe, bounded
 * summary; when structured diagnostics are present we append a compact
 * `[stage · reason · HTTP nnn · code]` tag so the failing layer is visible
 * at a glance and copy-pasteable. Every part shown here is a slug or a
 * bounded string — never a raw payload.
 */
export function taskFailureText(active: ActiveTaskState): string {
  const base = active.lastDetail ?? "Task halted.";
  const f = active.failure;
  if (!f) return base;
  const tags: string[] = [f.stage.replace(/_/g, " ")];
  if (f.reason && f.reason !== f.stage) tags.push(f.reason.replace(/_/g, " "));
  if (f.httpStatus != null) tags.push(`HTTP ${f.httpStatus}`);
  if (f.serverErrorCode) tags.push(f.serverErrorCode);
  return `${base}  [${tags.join(" · ")}]`;
}

/**
 * Classifies tab communication errors into clean, actionable user feedback.
 */
export function formatTabErrorMessage(err: unknown): string {
  const message = String(err);
  if (
    message.includes("Receiving end does not exist") ||
    message.includes("Could not establish connection") ||
    message.includes("back/forward cache") ||
    message.includes("message channel is closed") ||
    message.includes("message port closed") ||
    message.includes("Extension context invalidated") ||
    message.includes("BFCACHE_CHANNEL_CLOSED") ||
    message.includes("CONTENT_SCRIPT_UNAVAILABLE")
  ) {
    return "Page navigation in progress or connection reset — reload the page and try again.";
  }
  return `Could not reach the page: ${message}`;
}

if (typeof document !== "undefined") {
  const container = document.getElementById("report");
  if (container) {
    chrome.storage.local.get(
      ["latestStatus", "latestPrivacyReport", "latestBlockedPayload", "latestVerification", "latestPayloadSha256", "updatedAt"],
      (state) => render(state as StoredState, container)
    );

    // Keep the popup live if it's open while a new page finishes its pipeline.
    chrome.storage.onChanged.addListener((_changes, areaName) => {
      if (areaName !== "local") return;
      chrome.storage.local.get(
        ["latestStatus", "latestPrivacyReport", "latestBlockedPayload", "latestVerification", "latestPayloadSha256", "updatedAt"],
        (state) => render(state as StoredState, container)
      );
    });
  }

  const taskInput = document.getElementById("task-input") as HTMLInputElement | null;
  const runButton = document.getElementById("run-task") as HTMLButtonElement | null;
  const taskStatus = document.getElementById("task-status");

  if (taskInput && runButton && taskStatus) {
    chrome.storage.local.get(["lastTask", "activeTask"], (result) => {
      taskInput.value = (result.lastTask as string | undefined) ?? "";
      const active = result.activeTask as ActiveTaskState | undefined;
      if (active) {
        if (active.status === "active" || active.status === "navigating") {
          runButton.disabled = true;
          taskStatus.textContent = active.status === "navigating"
            ? `Navigating to next page (step ${active.stepNumber})…`
            : `Running step ${active.stepNumber}…`;
        } else if (active.status === "completed") {
          taskStatus.textContent = active.lastDetail ?? "Task complete.";
        } else if (active.status === "failed") {
          taskStatus.textContent = taskFailureText(active);
        }
      }
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes.activeTask) return;
      const active = changes.activeTask.newValue as ActiveTaskState | undefined;
      if (active) {
        if (active.status === "active" || active.status === "navigating") {
          runButton.disabled = true;
          taskStatus.textContent = active.status === "navigating"
            ? `Navigating across pages (step ${active.stepNumber})…`
            : `Running step ${active.stepNumber}…`;
        } else if (active.status === "completed") {
          runButton.disabled = false;
          taskStatus.textContent = active.lastDetail ?? "Task complete.";
          chrome.storage.local.remove("lastTask");
        } else if (active.status === "failed") {
          runButton.disabled = false;
          taskStatus.textContent = taskFailureText(active);
          chrome.storage.local.remove("lastTask");
        }
      }
    });

    const submitTask = async () => {
      const task = taskInput.value.trim();
      if (!task) {
        taskStatus.textContent = "Type what you want done first.";
        return;
      }

      runButton.disabled = true;
      taskStatus.textContent = "Running…";
      chrome.storage.local.set({ lastTask: task });

      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error("no active tab");
        const response = (await chrome.tabs.sendMessage(tab.id, {
          type: "RUN_TASK",
          payload: { task, tabId: tab.id },
        })) as { ok: boolean; detail: string } | undefined;
        if (response?.detail) {
          taskStatus.textContent = response.detail;
        }
      } catch (err) {
        chrome.storage.local.get(["activeTask"], (res) => {
          const active = res?.activeTask as ActiveTaskState | undefined;
          if (active && (active.status === "active" || active.status === "navigating")) {
            taskStatus.textContent = `Navigating across pages (step ${active.stepNumber})…`;
          } else {
            taskStatus.textContent = formatTabErrorMessage(err);
            runButton.disabled = false;
          }
        });
      } finally {
        chrome.storage.local.get(["activeTask"], (res) => {
          const active = res?.activeTask as ActiveTaskState | undefined;
          if (!active || (active.status !== "active" && active.status !== "navigating")) {
            runButton.disabled = false;
            chrome.storage.local.remove("lastTask");
          }
        });
      }
    };

    runButton.addEventListener("click", submitTask);
    taskInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submitTask();
    });
  }

  const PROFILE_FIELDS: ProfileField[] = ["person_name", "email", "phone", "address"];
  const profileInputs = PROFILE_FIELDS.map(
    (field) => [field, document.getElementById(`p-${field}`) as HTMLInputElement | null] as const
  );
  const saveProfileButton = document.getElementById("save-profile");
  const profileStatus = document.getElementById("profile-status");

  if (saveProfileButton && profileStatus) {
    loadProfile().then((profile) => {
      for (const [field, input] of profileInputs) {
        if (input) input.value = profile[field] ?? "";
      }
    });

    saveProfileButton.addEventListener("click", async () => {
      const profile: Profile = {};
      for (const [field, input] of profileInputs) {
        const value = input?.value.trim();
        if (value) profile[field] = value;
      }
      await saveProfile(profile);
      const count = Object.keys(profile).length;
      profileStatus.textContent = `Saved ${count} field${count === 1 ? "" : "s"} — stored locally only.`;
      setTimeout(() => {
        profileStatus.textContent = "";
      }, 3000);
    });
  }

  const urlInput = document.getElementById("server-url") as HTMLInputElement | null;
  const saveButton = document.getElementById("save-server-url");
  const saveStatus = document.getElementById("save-status");

  if (urlInput && saveButton && saveStatus) {
    chrome.storage.local.get(["serverUrl"], (result) => {
      urlInput.value = (result.serverUrl as string | undefined) || DEFAULT_SERVER_URL;
    });

    saveButton.addEventListener("click", () => {
      const value = urlInput.value.trim() || DEFAULT_SERVER_URL;
      chrome.storage.local.set({ serverUrl: value }, () => {
        saveStatus.textContent = "Saved — reload the target page to use it.";
        setTimeout(() => {
          saveStatus.textContent = "";
        }, 3000);
      });
    });
  }

  // API key — the frozen server enforces X-API-Key on /reason. Stored under the
  // existing "apiKey" key that background/getStoredApiKey() already reads; the
  // raw value never leaves chrome.storage.local except as the outbound header
  // (background/executeRemoteJsonPost). Password-style input; never logged.
  const apiKeyInput = document.getElementById("api-key") as HTMLInputElement | null;
  const saveApiKeyButton = document.getElementById("save-api-key");
  const apiKeyStatus = document.getElementById("api-key-status");

  if (apiKeyInput && saveApiKeyButton && apiKeyStatus) {
    chrome.storage.local.get(["apiKey"], (result) => {
      apiKeyInput.value = (result.apiKey as string | undefined) ?? "";
    });

    saveApiKeyButton.addEventListener("click", () => {
      const value = apiKeyInput.value.trim();
      if (!value) {
        // Empty save clears the key rather than storing "" — background treats
        // a blank key as "not configured" and fails fast before any request.
        chrome.storage.local.remove("apiKey", () => {
          apiKeyStatus.textContent = "Cleared — no API key configured.";
          setTimeout(() => {
            apiKeyStatus.textContent = "";
          }, 3000);
        });
        return;
      }
      chrome.storage.local.set({ apiKey: value }, () => {
        apiKeyStatus.textContent = "Saved — reload the target page to use it.";
        setTimeout(() => {
          apiKeyStatus.textContent = "";
        }, 3000);
      });
    });
  }
}
