export function log(message: string, data?: Record<string, unknown>, timestamp?: string): void {
  const entry: Record<string, unknown> = { ts: timestamp ?? new Date().toISOString(), message, ...data };
  console.log(JSON.stringify(entry));
}
