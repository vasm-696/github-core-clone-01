/**
 * lib/rest.ts — the REST v3 surface. (Stub for now; the full implementation lands next.)
 */
import type { ForgeStore } from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export async function handleRest(
  _store: ForgeStore,
  _method: string,
  _url: URL,
  _body: Buffer,
): Promise<RestResult> {
  return { status: 404, body: { message: 'Not Found' } };
}
