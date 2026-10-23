// Minimal JSON fetch helper. Follows at most 3 redirects (handled by fetch itself).
export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return (await res.json()) as T;
}
