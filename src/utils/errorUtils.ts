export function extractErrorMessage(error: any): string {
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

function extractFromObject(obj: any): string {
  if (!obj) return 'An unknown error occurred.';

  // 1. Direct message or error.message
  const msg =
    obj.message || (obj.error && typeof obj.error === 'object' ? obj.error.message : obj.error);

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
  const code = obj.code || obj.status || (obj.error && obj.error.code);
  if (code && typeof code !== 'object') {
    const statusText = obj.statusText || obj.status || (obj.error && obj.error.status);
    return `Error ${code}${statusText ? ': ' + statusText : ''}`;
  }

  // 3. Fallback to a generic message if we can't find a good string
  return 'The API returned an error. Please check your configuration or try again.';
}
