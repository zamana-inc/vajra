function stripNullish(value: unknown): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => stripNullish(entry))
      .filter((entry) => entry !== undefined);
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, stripNullish(entry)] as const)
      .filter(([, entry]) => entry !== undefined);

    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  return value;
}

export function stageMetaObject(value: {
  command?: string | null;
  visit?: number | null;
  type?: string | null;
  status?: string | null;
  reasoningEffort?: string | null;
  result?: Record<string, unknown>;
}): Record<string, unknown> {
  return (stripNullish({
    command: value.command,
    visit: value.visit,
    type: value.type,
    status: value.status,
    reasoningEffort: value.reasoningEffort,
    result: value.result,
  }) as Record<string, unknown> | undefined) ?? {};
}
