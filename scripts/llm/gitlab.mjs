// Creates or updates a single LLM review note on the merge request (found by its marker).
import { MARKER } from './render.mjs';

export async function upsertMergeRequestNote(env, body, fetchImpl = fetch) {
  const base = `${env.CI_API_V4_URL}/projects/${env.CI_PROJECT_ID}/merge_requests/${env.CI_MERGE_REQUEST_IID}/notes`;
  const headers = { 'PRIVATE-TOKEN': env.RG_GITLAB_TOKEN, 'content-type': 'application/json' };
  const call = async (url, init) => {
    const response = await fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`GitLab API ${init?.method ?? 'GET'} ${response.status}`);
    return response.json();
  };
  const notes = await call(`${base}?per_page=100&sort=desc&order_by=updated_at`);
  const existing = notes.find(n => !n.system && typeof n.body === 'string' && n.body.startsWith(MARKER));
  if (existing) { await call(`${base}/${existing.id}`, { method: 'PUT', body: JSON.stringify({ body }) }); return 'updated'; }
  await call(base, { method: 'POST', body: JSON.stringify({ body }) });
  return 'created';
}
