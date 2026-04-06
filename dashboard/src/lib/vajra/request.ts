export type VajraParams = Record<string, string | number | boolean | undefined>;

export function buildVajraUrl(endpoint: string, params?: VajraParams): string {
  const search = new URLSearchParams();
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        search.set(key, String(value));
      }
    }
  }

  const query = search.toString();
  return query ? `/api/vajra/${endpoint}?${query}` : `/api/vajra/${endpoint}`;
}

async function parseErrorMessage(response: Response): Promise<string> {
  const json = await response.json().catch(() => null as unknown);
  if (json && typeof json === "object" && "error" in json) {
    return String((json as { error?: unknown }).error ?? `HTTP ${response.status}`);
  }

  return `HTTP ${response.status}`;
}

export async function requestVajraJson<T>(
  endpoint: string,
  opts?: {
    method?: "GET" | "PUT" | "POST" | "DELETE";
    params?: VajraParams;
    body?: unknown;
  },
): Promise<T> {
  const response = await fetch(buildVajraUrl(endpoint, opts?.params), {
    method: opts?.method ?? "GET",
    cache: "no-store",
    headers: opts?.body !== undefined
      ? {
          "content-type": "application/json",
        }
      : undefined,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }

  return response.json() as Promise<T>;
}
