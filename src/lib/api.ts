const BACKEND_URL = import.meta.env.VITE_BACKEND_URL;

export async function apiFetch(
  path: string,
  accessToken: string | null,
  options: RequestInit = {}
) {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  if (accessToken) {
    headers.set("Authorization", `Bearer ${accessToken}`);
  }

  const res = await fetch(`${BACKEND_URL}${path}`, { ...options, headers });
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(data?.error ?? `Request failed with status ${res.status}`);
  }

  return data;
}