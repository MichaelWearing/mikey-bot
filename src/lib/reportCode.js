// Handles a single URL/code, or several comma-separated ones (for a night that got
// logged across multiple WCL reports) — each part is resolved independently, then
// rejoined so analyzeReport() can split on commas and fetch them all.
export function extractReportCode(input) {
  return input
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      const urlMatch = trimmed.match(/reports\/([a-zA-Z0-9]+)/);
      return urlMatch ? urlMatch[1] : trimmed;
    })
    .filter(Boolean)
    .join(",");
}
