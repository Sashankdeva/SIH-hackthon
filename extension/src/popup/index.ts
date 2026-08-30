import type { PrivacyReport } from "../privacy/types";
import type { VerificationResult } from "../pvm/types";
import { loadProfile, saveProfile, type Profile, type ProfileField } from "../privacy/profileStore";

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

/**
 * Task input — the agent does nothing until the user asks for
 * something here. Page-load redaction happens regardless (privacy
 * shouldn't wait to be asked), but reasoning and any action on the page
 * are gated behind this. See content/index.ts's analysePage vs runTask
 * split.
 */
const taskInput = document.getElementById("task-input") as HTMLInputElement | null;
const runButton = document.getElementById("run-task") as HTMLButtonElement | null;
const taskStatus = document.getElementById("task-status");

if (taskInput && runButton && taskStatus) {
  chrome.storage.local.get(["lastTask"], (result) => {
    taskInput.value = (result.lastTask as string | undefined) ?? "";
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
        payload: { task },
      })) as { ok: boolean; detail: string } | undefined;
      taskStatus.textContent = response?.detail ?? "No response from the page — try reloading it.";
    } catch (err) {
      // "Receiving end does not exist" means no content script is
      // listening in that tab. By far the most common cause is a stale
      // tab: reloading the extension orphans content scripts in
      // already-open pages, and the new one only injects on a fresh
      // page load. Say that outright rather than showing the raw error
      // — this is exactly the failure that would derail a live demo.
      const message = String(err);
      taskStatus.textContent = message.includes("Receiving end does not exist")
        ? "Not connected to this page — reload the page (F5), then Run again."
        : `Could not reach the page: ${message}`;
    } finally {
      runButton.disabled = false;
      // ISSUE-16: Clear lastTask after task completion (success or failure).
      // Task text may contain user intent — only pre-fill while a task is
      // actively pending. After completion the user can re-enter or modify.
      chrome.storage.local.remove("lastTask");
    }
  };

  runButton.addEventListener("click", submitTask);
  taskInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submitTask();
  });
}

/**
 * The user's own details, used to auto-fill redacted fields. Chrome
 * exposes no API for reading its saved autofill profiles, so this is
 * our own store — see privacy/profileStore.ts for why that's the
 * correct design here rather than a workaround.
 */
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

/**
 * Demoing on a laptop with no local GPU: point serverUrl at the GPU
 * laptop's LAN address instead of running Ollama locally. The target
 * origin must also be added to manifest.json's host_permissions before
 * rebuilding — this setting alone doesn't bypass that. See
 * server/README.md, "Demoing without a local GPU."
 */
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
