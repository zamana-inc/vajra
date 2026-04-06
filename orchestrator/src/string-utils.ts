export function normalizeLowercase(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeLowercaseText(value: unknown): string {
  return normalizeLowercase(String(value ?? ""));
}

export function normalizeRequiredLowercase(value: string, fieldName: string): string {
  const normalized = normalizeLowercase(value);
  if (!normalized) {
    throw new Error(`${fieldName} must be non-empty`);
  }
  return normalized;
}
