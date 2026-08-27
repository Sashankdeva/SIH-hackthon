/**
 * Privacy inspector UI — Day 3 task, PS26171_Role3_Privacy.pdf.
 * This panel is informational only; the Privacy Firewall
 * (privacy/sanitizedContext.ts) is the real enforcement point, and this
 * view must never display raw sensitive values, only redaction tokens
 * and allow/block status.
 */
const reportEl = document.getElementById("report");

if (reportEl) {
  reportEl.textContent = "No page captured yet — open a tab with the extension active.";
}
