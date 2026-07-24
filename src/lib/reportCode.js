export function extractReportCode(input) {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/reports\/([a-zA-Z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  return trimmed;
}
