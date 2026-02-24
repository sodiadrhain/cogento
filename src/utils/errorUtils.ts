export function extractErrorMessage(error: unknown): string {
  if (!error) return 'An unknown error occurred.';

  // If it's a string, try to parse it as JSON once, then treat as object
  if (typeof error === 'string') {
    try {
      const parsed = JSON.parse(error);
      return extractFromObject(parsed);
    } catch {
      return error;
    }
  }

  return extractFromObject(error);
}

function extractFromObject(obj: unknown): string {
  if (!obj || typeof obj !== 'object') return 'An unknown error occurred.';

  const record = obj as Record<string, unknown>;

  // 1. Direct message or error.message
  const msg =
    record.message ||
    (record.error && typeof record.error === 'object'
      ? (record.error as Record<string, unknown>).message
      : record.error);

  if (msg && typeof msg === 'string') {
    // If the message itself is stringified JSON (common in Gemini), parse it
    if (msg.trim().startsWith('{')) {
      try {
        const inner = JSON.parse(msg);
        return extractFromObject(inner);
      } catch {
        return msg;
      }
    }
    return msg;
  }

  // 2. Common code/status fields
  const code =
    record.code ||
    record.status ||
    (record.error && (record.error as Record<string, unknown>).code);
  if (code && typeof code !== 'object') {
    const statusText =
      record.statusText ||
      record.status ||
      (record.error && (record.error as Record<string, unknown>).status);
    return `Error ${code}${statusText ? ': ' + statusText : ''}`;
  }

  // 3. Fallback to a generic message if we can't find a good string
  return 'The API returned an error. Please check your configuration or try again.';
}
