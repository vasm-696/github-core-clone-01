/**
 * app.ts — the forge's HTTP server: one process, four surfaces.
 *
 *   git smart HTTP   /{owner}/{repo}.git   (upload-pack v2, receive-pack v0)
 *   REST v3          /api/v3              (repositories, issues, pull requests, contents)
 *   GraphQL v4       /api/graphql
 *   MCP              /mcp                 (JSON-RPC 2.0, Streamable HTTP)
 *
 * Every reply is JSON (never HTML) and carries a non-empty X-GitHub-Request-Id. Every route
 * except /healthz requires the trial's bearer token; without it the answer is 401.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ForgeStore, VIEWER } from './lib/store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './lib/smart-http.ts';
import { handleRest } from './lib/rest.ts';
import { handleGraphql } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';

export interface ForgeConfig {
  token: string;
}

const store = new ForgeStore();

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 256 * 1024 * 1024) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function jsonResponse(response: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}, empty = false): void {
  if (empty || status === 204) {
    response.writeHead(status, { 'x-github-request-id': randomUUID(), ...extraHeaders });
    response.end();
    return;
  }
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(payload.length),
    'x-github-request-id': randomUUID(),
    ...extraHeaders,
  });
  response.end(payload);
}

function rawResponse(response: ServerResponse, status: number, contentType: string, body: Buffer, extraHeaders: Record<string, string> = {}): void {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': randomUUID(),
    ...extraHeaders,
  });
  response.end(body);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(config: ForgeConfig): Server {
  const expectedToken = config.token;
  return createServer(async (request, response) => {
    const host = request.headers.host ?? 'localhost';
    const url = new URL(request.url ?? '/', `http://${host}`);
    const method = request.method ?? 'GET';
    try {
      // The env's boot probe: no token, always 200.
      if (method === 'GET' && url.pathname === '/healthz') {
        jsonResponse(response, 200, { ok: true });
        return;
      }
      // Every other route takes the trial's bearer token.
      const authorization = request.headers.authorization ?? '';
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (expectedToken !== '' && token !== expectedToken) {
        jsonResponse(response, 401, { message: 'Bad credentials' });
        return;
      }
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(url.pathname);
      if (gitMatch) {
        const [, owner, repoName, suffix] = gitMatch;
        const repo = store.getRepo(owner, repoName);
        if (suffix === '/info/refs') {
          const service = url.searchParams.get('service');
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
            jsonResponse(response, 400, { message: 'unknown service' });
            return;
          }
          const wantsV2 = (request.headers['git-protocol'] ?? '') === 'version=2';
          const result = handleInfoRefs(repo, service, wantsV2);
          rawResponse(response, result.status, result.contentType, result.body);
          return;
        }
        const body = await readBody(request);
        if (suffix === '/git-upload-pack' && method === 'POST') {
          const wantsV2 = (request.headers['git-protocol'] ?? '') === 'version=2';
          const result = handleUploadPack(repo, body, wantsV2);
          rawResponse(response, result.status, result.contentType, result.body);
          return;
        }
        if (suffix === '/git-receive-pack' && method === 'POST') {
          const result = handleReceivePack(store, repo, body);
          rawResponse(response, result.status, result.contentType, result.body);
          return;
        }
        jsonResponse(response, 404, { message: 'Not Found' });
        return;
      }
      if (url.pathname === '/api/graphql' && method === 'POST') {
        const body = await readBody(request);
        const result = await handleGraphql(store, body);
        jsonResponse(response, result.status, result.body, result.headers);
        return;
      }
      if (url.pathname === '/mcp' && method === 'POST') {
        const body = await readBody(request);
        const result = await handleMcp(store, body);
        rawResponse(response, result.status, result.contentType, result.body, result.headers);
        return;
      }
      if (url.pathname.startsWith('/api/v3')) {
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(request);
        const result = await handleRest(store, method, url, body);
        jsonResponse(response, result.status, result.body, result.headers, result.empty);
        return;
      }
      jsonResponse(response, 404, { message: 'Not Found' });
    } catch (err) {
      if (!response.headersSent) jsonResponse(response, 500, { message: (err as Error).message });
      else response.destroy();
    }
  });
}

export { store, VIEWER };
