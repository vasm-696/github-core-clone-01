/**
 * lib/graphql.ts — the GraphQL v4 surface. (Stub for now; the full implementation lands next.)
 */
import type { ForgeStore } from './store.ts';

export interface GraphqlResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export async function handleGraphql(
  _store: ForgeStore,
  _body: Buffer,
): Promise<GraphqlResult> {
  return { status: 200, body: { errors: [{ message: 'not implemented' }] } };
}
