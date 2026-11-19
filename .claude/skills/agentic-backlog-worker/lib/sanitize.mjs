// Ticket ids, titles, reasons, PRs and branches come from Linear or an agent: untrusted. One
// line, no HTML, no code spans, and nothing that can split a table cell or open a link. Shared
// by the debrief (worker.mjs) and the SessionStart hook (backlog-worker-status.mjs).
export const clean = (s) => String(s ?? '')
  .replace(/[\r\n\t]+/g, ' ')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/`/g, "'")
  .replace(/([|[\]])/g, '\\$1')
  .trim();
