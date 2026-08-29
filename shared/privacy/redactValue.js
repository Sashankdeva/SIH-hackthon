/**
 * shared/privacy/redactValue.js
 *
 * Tier-1 deterministic redaction.
 * Takes a DOM state object and a list of PII matches, and produces
 * a new DOM state object with sensitive values redacted.
 *
 * Phase scope: redaction ONLY — no network payloads, no profile access.
 */

/**
 * Redacts detected PII from a DOM state object.
 *
 * @param {{ fields: Record<string, string> }} domState
 * @param {Array<{ value: string, field: string, matchedRule: string }>} matches
 * @returns {{ fields: Record<string, string> }}
 */
export function redactValue(domState, matches) {
  if (!domState || !domState.fields || typeof domState.fields !== "object") {
    throw new TypeError("redactValue: domState must be an object with a `fields` map");
  }

  // Fast path: if no matches, return the exact same object (non-destructive guarantee)
  if (!matches || !Array.isArray(matches) || matches.length === 0) {
    return domState;
  }

  const redactedFields = { ...domState.fields };
  let hasChanges = false;

  // Group matches by field to handle multiple redactions in the same field
  const matchesByField = {};
  for (const match of matches) {
    if (!matchesByField[match.field]) {
      matchesByField[match.field] = [];
    }
    matchesByField[match.field].push(match);
  }

  for (const [field, fieldMatches] of Object.entries(matchesByField)) {
    if (!(field in redactedFields)) continue;
    
    let currentValue = redactedFields[field];
    if (typeof currentValue !== "string") {
      currentValue = String(currentValue ?? "");
    }
    const originalValue = currentValue;

    // Sort matches by length descending so larger matches (like a 16-digit CC) 
    // are replaced before their subsets (like a 12-digit Aadhaar subset)
    fieldMatches.sort((a, b) => b.value.length - a.value.length);

    // Apply redactions
    for (const match of fieldMatches) {
      if (!match.value || !match.matchedRule) continue;
      
      // Extract rule id from matchedRule (e.g. 'tier1-email:"jane@example.com"' -> 'tier1-email')
      const colonIndex = match.matchedRule.indexOf(':');
      if (colonIndex === -1) continue;
      
      const ruleId = match.matchedRule.substring(0, colonIndex);
      const placeholder = `[REDACTED:${ruleId}]`;
      
      // Replace all occurrences of the match value with the placeholder
      currentValue = currentValue.replaceAll(match.value, placeholder);
    }

    if (currentValue !== originalValue) {
      redactedFields[field] = currentValue;
      hasChanges = true;
    }
  }

  // If we processed matches but none of them actually changed anything 
  // (e.g. because they were already redacted or field didn't exist), return original.
  if (!hasChanges) {
    return domState;
  }

  return { fields: redactedFields };
}
