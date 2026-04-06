export function requireConfiguredApiKey(apiKey: string | undefined): string {
  const normalized = apiKey?.trim();
  if (normalized) {
    return normalized;
  }

  throw new Error("VAJRA_API_KEY must be set");
}
