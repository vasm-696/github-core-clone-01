/**
 * lib/mcp.ts — the MCP endpoint (JSON-RPC 2.0, Streamable HTTP). (Stub for now.)
 */
import type { ForgeStore } from './store.ts';

export interface McpResult {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

export async function handleMcp(_store: ForgeStore, _body: Buffer): Promise<McpResult> {
  return {
    status: 200,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'not implemented' } }), 'utf8'),
  };
}
