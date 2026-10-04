const SEARCH_READY_CHECK_TIMEOUT_MS = 2500;

export async function isSearchReady(): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), SEARCH_READY_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch('/api/search/ready', {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeoutId);
  }
}
