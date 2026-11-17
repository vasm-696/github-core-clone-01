/**
 * lib/mcp.ts — the MCP endpoint: JSON-RPC 2.0 over Streamable HTTP at POST /mcp.
 *
 * Two protocol eras, one handler (the suite's client probes in this order):
 *   modern 2026-07-28 — `server/discover` returns the identity, capabilities and
 *           supportedVersions in one request; no handshake, no session.
 *   legacy 2025-11-25 and earlier — `initialize` (echo the offered revision) then the
 *           `notifications/initialized` notification.
 *
 * The six tools mirror github-mcp-server's documented names and argument names, and act on
 * the same store as REST and GraphQL, so a repository or issue made over MCP is the same
 * object over REST (rest-parity). Every tool result carries both a text block and
 * structuredContent holding the same JSON, so the suite can read it either way.
 *
 * Failures: an unknown tool is JSON-RPC -32602 (never HTTP 500); a tools/call missing a
 * required argument answers isError:true; a body that is not JSON answers HTTP 400 with
 * JSON-RPC -32700. Authentication never reaches this module (app.ts answers 401 first).
 */
import {
  globalId,
  VIEWER,
  type ForgeStore,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { parseCommit } from './git.ts';

export interface McpResult {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// ---------------------------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the new repository (the viewer when omitted).' },
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo, as an alternative to owner and repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo, as an alternative to owner and repo.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo, as an alternative to owner and repo.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo, as an alternative to owner and repo.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo, as an alternative to owner and repo.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

// ---------------------------------------------------------------------------------------------
// serializers (GitHub-shaped, the same objects REST returns)
// ---------------------------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color, description: label.description })),
    user: { login: issue.user, id: issue.user === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    user: { login: pull.user, id: pull.user === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/repos/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------------------------
// tool execution
// ---------------------------------------------------------------------------------------------

type ToolOutcome = { ok: true; payload: unknown } | { ok: false; message: string };

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

/** owner/repo out of the arguments: the named properties, or a full_name split. */
function ownerRepoOf(args: Record<string, unknown>): { owner: string; repo: string } {
  const fullName = textOf(args.full_name);
  let owner = textOf(args.owner) || textOf(args.owner_login);
  let repo = textOf(args.repo) || textOf(args.repository);
  if ((!owner || !repo) && fullName.includes('/')) {
    const [namedOwner, namedRepo] = fullName.split('/', 2);
    owner = owner || namedOwner;
    repo = repo || namedRepo;
  }
  return { owner, repo };
}

function missingArgs(args: Record<string, unknown>, required: string[]): string[] {
  return required.filter((name) => {
    const value = args[name];
    if (value === undefined || value === null) return true;
    if (typeof value === 'string' && value === '') return true;
    return false;
  });
}

function createPull(store: ForgeStore, repo: Repo, input: { title: string; body: string; head: string; base: string }): PullRequest {
  const headSha = repo.refs.get(`refs/heads/${input.head}`)!;
  const baseSha = repo.refs.get(`refs/heads/${input.base}`)!;
  const headTree = parseCommit(repo.objects.get(headSha)!.data).tree;
  const baseTree = parseCommit(repo.objects.get(baseSha)!.data).tree;
  const baseOfMerge = store.mergeBase(repo, headSha, baseSha);
  const mergeBaseTree = baseOfMerge ? parseCommit(repo.objects.get(baseOfMerge)!.data).tree : baseTree;
  const files = store.diffFiles(repo, baseTree, headTree);
  const mergeable = store.threeWayMerge(repo, mergeBaseTree, baseTree, headTree) !== null;
  repo.pullCounter += 1;
  const now = store.nowIso();
  const pull: PullRequest = {
    number: repo.pullCounter,
    id: repo.id * 100000 + repo.pullCounter,
    title: input.title,
    body: input.body,
    state: 'open',
    headRef: input.head,
    headSha,
    baseRef: input.base,
    baseSha,
    merged: false,
    mergeCommitSha: null,
    mergedAt: null,
    user: VIEWER.login,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    files,
    mergeable,
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

function mergePull(store: ForgeStore, repo: Repo, pull: PullRequest): ToolOutcome {
  if (pull.state !== 'open') return { ok: false, message: `Pull request #${pull.number} is already ${pull.state}.` };
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return { ok: false, message: 'The head or base branch no longer exists.' };
  const baseOfMerge = store.mergeBase(repo, headTip, baseTip);
  const mergeBaseTree = baseOfMerge ? parseCommit(repo.objects.get(baseOfMerge)!.data).tree : parseCommit(repo.objects.get(baseTip)!.data).tree;
  const baseTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const mergedTree = store.threeWayMerge(repo, mergeBaseTree, baseTree, headTree);
  if (mergedTree === null) return { ok: false, message: 'Merge conflict.' };
  const mergeSha = store.commitOnBranch(repo, pull.baseRef, mergedTree, [baseTip], `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = mergeSha;
  pull.mergedAt = store.nowIso();
  pull.closedAt = pull.mergedAt;
  pull.updatedAt = pull.mergedAt;
  return { ok: true, payload: pullJson(repo, pull) };
}

function runTool(store: ForgeStore, name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const missing = missingArgs(args, ['name']);
      if (missing.length) return { ok: false, message: `Missing required argument: ${missing.join(', ')}.` };
      const repoName = textOf(args.name);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName)) return { ok: false, message: `Invalid repository name: ${repoName}.` };
      const owner = textOf(args.owner) || VIEWER.login;
      if (store.getRepo(owner, repoName)) return { ok: false, message: `Repository ${owner}/${repoName} already exists.` };
      const repo = store.createRepo(owner, repoName, {
        description: textOf(args.description),
        isPrivate: args.private === true,
      });
      return { ok: true, payload: repoJson(repo) };
    }
    case 'get_repo': {
      const missing = missingArgs(args, ['owner', 'repo']);
      if (missing.length && !textOf(args.full_name)) return { ok: false, message: `Missing required argument: ${missing.join(', ')}.` };
      const { owner, repo: repoName } = ownerRepoOf(args);
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { ok: false, message: `Repository ${owner}/${repoName} not found.` };
      return { ok: true, payload: repoJson(repo) };
    }
    case 'create_issue': {
      const missing = missingArgs(args, ['owner', 'repo', 'title']);
      if (missing.length && !textOf(args.full_name)) return { ok: false, message: `Missing required argument: ${missing.join(', ')}.` };
      const { owner, repo: repoName } = ownerRepoOf(args);
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { ok: false, message: `Repository ${owner}/${repoName} not found.` };
      repo.issueCounter += 1;
      const now = store.nowIso();
      const issue: Issue = {
        number: repo.issueCounter,
        id: repo.id * 100000 + repo.issueCounter,
        title: textOf(args.title),
        body: textOf(args.body),
        state: 'open',
        labels: [],
        user: VIEWER.login,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        comments: [],
      };
      repo.issues.set(issue.number, issue);
      return { ok: true, payload: issueJson(repo, issue) };
    }
    case 'list_issues': {
      const missing = missingArgs(args, ['owner', 'repo']);
      if (missing.length && !textOf(args.full_name)) return { ok: false, message: `Missing required argument: ${missing.join(', ')}.` };
      const { owner, repo: repoName } = ownerRepoOf(args);
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { ok: false, message: `Repository ${owner}/${repoName} not found.` };
      const state = textOf(args.state) || 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.number - a.number)
        .map((issue) => issueJson(repo, issue));
      return { ok: true, payload: issues };
    }
    case 'create_pull_request': {
      const missing = missingArgs(args, ['owner', 'repo', 'title', 'head', 'base']);
      if (missing.length && !textOf(args.full_name)) return { ok: false, message: `Missing required argument: ${missing.join(', ')}.` };
      const { owner, repo: repoName } = ownerRepoOf(args);
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { ok: false, message: `Repository ${owner}/${repoName} not found.` };
      const head = textOf(args.head);
      const base = textOf(args.base);
      if (!repo.refs.has(`refs/heads/${head}`)) return { ok: false, message: `Head branch ${head} does not exist.` };
      if (!repo.refs.has(`refs/heads/${base}`)) return { ok: false, message: `Base branch ${base} does not exist.` };
      const pull = createPull(store, repo, { title: textOf(args.title), body: textOf(args.body), head, base });
      return { ok: true, payload: pullJson(repo, pull) };
    }
    case 'merge_pull_request': {
      const pullNumber = numberOf(args.pull_number) ?? numberOf(args.number) ?? numberOf(args.pull_request_number);
      const missing = missingArgs(args, ['owner', 'repo']);
      if (missing.length && !textOf(args.full_name)) return { ok: false, message: `Missing required argument: ${missing.join(', ')}.` };
      if (pullNumber === null) return { ok: false, message: 'Missing required argument: pull_number.' };
      const { owner, repo: repoName } = ownerRepoOf(args);
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { ok: false, message: `Repository ${owner}/${repoName} not found.` };
      const pull = repo.pulls.get(pullNumber);
      if (!pull) return { ok: false, message: `Pull request #${pullNumber} not found.` };
      return mergePull(store, repo, pull);
    }
    default:
      return { ok: false, message: `Unknown tool: ${name}.` };
  }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------------------------

function rpcResult(id: unknown, result: unknown): McpResult {
  return {
    status: 200,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }), 'utf8'),
  };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResult {
  return {
    status,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), 'utf8'),
  };
}

/** The id a malformed body carried, when it can still be read out of the raw text. */
function idFromRawText(text: string): unknown {
  const match = /"id"\s*:\s*("[^"]*"|-?\d+)/.exec(text);
  if (!match) return null;
  const raw = match[1];
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return null;
    }
  }
  return Number.parseInt(raw, 10);
}

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

export async function handleMcp(store: ForgeStore, body: Buffer): Promise<McpResult> {
  const text = body.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // A body that is not JSON: HTTP 400 with JSON-RPC -32700.
    return rpcError(idFromRawText(text), -32700, 'Parse error', 400);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const request = parsed as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = 'id' in request ? request.id : undefined;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;

  // A message with no id is a notification: no JSON-RPC answer, HTTP 202.
  if (id === undefined) {
    return { status: 202, contentType: 'application/json', body: Buffer.alloc(0) };
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      instructions: 'A GitHub-compatible git forge: create repositories, issues and pull requests.',
      serverInfo: serverInfo(),
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    });
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = [...SUPPORTED_VERSIONS, ...LEGACY_VERSIONS].includes(offered) ? offered : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
    });
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    // The tools array is a module-level constant: two calls answer byte-identical lists.
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
    const known = TOOLS.some((tool) => tool.name === toolName);
    if (!known) return rpcError(id, -32602, `Unknown tool: ${toolName}.`);
    const outcome = runTool(store, toolName, args);
    if (!outcome.ok) {
      return rpcResult(id, {
        content: [{ type: 'text', text: outcome.message }],
        isError: true,
      });
    }
    return rpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify(outcome.payload) }],
      structuredContent: outcome.payload,
    });
  }
  return rpcError(id, -32601, `Method not found: ${method}.`);
}
