/**
 * lib/graphql.ts — the GraphQL v4 surface: a small parser and executor for the documents gh
 * and github-mcp-server send (viewer, repository, issues, pull requests, the __type probes,
 * node(id:), the five mutations, and operation batching).
 *
 * A GraphQL-level failure (an unknown field, a bad argument) is a 200 whose body carries
 * `errors`; it is not an HTTP error. An unknown repository reads `data.repository = null`
 * with no errors. Unauthenticated requests never reach this module (app.ts answers 401).
 */
import {
  globalId,
  parseGlobalId,
  VIEWER,
  type ForgeStore,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { parseCommit } from './git.ts';

export interface GraphqlResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------------------------
// a small GraphQL parser (the subset the suite's documents use)
// ---------------------------------------------------------------------------------------------

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Record<string, GqlValue> };

interface GqlSelection {
  alias?: string;
  name: string;
  args?: Record<string, GqlValue>;
  selections?: GqlSelection[];
  /** Inline fragment: `... on Type { ... }` — `name` is the type, `fragment` is true. */
  fragment?: boolean;
}

interface GqlOperation {
  kind: 'query' | 'mutation';
  name?: string;
  selections: GqlSelection[];
}

class GqlParseError extends Error {}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:!=$&@='.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          out += source[j + 1];
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j])) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    throw new GqlParseError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new GqlParseError('unexpected end of document');
    this.pos += 1;
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new GqlParseError(`expected ${token}, got ${got}`);
  }

  parseDocument(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const first = this.peek();
    if (first === 'query' || first === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
      const maybeName = this.peek();
      if (maybeName !== undefined && maybeName !== '(' && maybeName !== '{') name = this.next();
    }
    if (this.peek() === '(') this.parseVariableDefinitions();
    return { kind, name, selections: this.parseSelectionSet() };
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token === '(') depth += 1;
      else if (token === ')') depth -= 1;
    }
  }

  parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === undefined) throw new GqlParseError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  parseSelection(): GqlSelection {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const typeName = this.next();
        return { name: typeName, fragment: true, selections: this.parseSelectionSet() };
      }
      throw new GqlParseError('named fragment spreads are not supported');
    }
    const first = this.next();
    let alias: string | undefined;
    let name = first;
    if (this.peek() === ':') {
      this.next();
      alias = first;
      name = this.next();
    }
    let args: Record<string, GqlValue> | undefined;
    if (this.peek() === '(') args = this.parseArguments();
    let selections: GqlSelection[] | undefined;
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { alias, name, args, selections };
  }

  parseArguments(): Record<string, GqlValue> {
    this.expect('(');
    const args: Record<string, GqlValue> = {};
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }

  parseValue(): GqlValue {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const values: GqlValue[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: Record<string, GqlValue> = {};
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields[name] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    return { kind: 'enum', value: token };
  }
}

function evalValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
      return value.value;
    case 'int':
      return value.value;
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((entry) => evalValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value.fields)) out[key] = evalValue(entry, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// schema description for __type
// ---------------------------------------------------------------------------------------------

interface TypeInfo {
  kind: 'OBJECT' | 'ENUM';
  fields?: string[];
  enumValues?: string[];
}

const SCHEMA: Record<string, TypeInfo> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'comments', 'labels', 'url', 'repository', 'assignees', 'milestone', 'locked'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRef', 'baseRef', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'author', 'url', 'repository', 'comments', 'commits', 'additions', 'deletions', 'changedFiles'],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'url', 'isPrivate', 'defaultBranch', 'labels', 'branches'],
  },
  User: {
    kind: 'OBJECT',
    fields: ['id', 'login', 'name', 'email', 'url', 'avatarUrl'],
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: ['path', 'additions', 'deletions', 'changeType'],
  },
  SearchType: {
    kind: 'ENUM',
    enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'ORGANIZATION'],
  },
  IssueState: {
    kind: 'ENUM',
    enumValues: ['OPEN', 'CLOSED'],
  },
  PullRequestState: {
    kind: 'ENUM',
    enumValues: ['OPEN', 'CLOSED', 'MERGED'],
  },
  MergeableState: {
    kind: 'ENUM',
    enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  },
  OrderDirection: {
    kind: 'ENUM',
    enumValues: ['ASC', 'DESC'],
  },
  IssueOrderField: {
    kind: 'ENUM',
    enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  },
  RepositoryPermission: {
    kind: 'ENUM',
    enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  },
};

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

interface Ctx {
  store: ForgeStore;
  errors: Array<{ message: string }>;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): string {
  if (pull.state === 'open') return 'OPEN';
  return pull.merged ? 'MERGED' : 'CLOSED';
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.id}:${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return globalId('PullRequest', `${repo.id}:${pull.number}`);
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', repo.id);
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`).toString('base64');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || !cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

/** Resolve a selection set against a value of a named type. */
function resolveSelections(ctx: Ctx, typeName: string, source: unknown, selections: GqlSelection[], variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.fragment) {
      // Inline fragment `... on Type { ... }`: applies when the source is that type.
      if (selection.name === typeName || (selection.name === 'Node' && ['Repository', 'Issue', 'PullRequest'].includes(typeName))) {
        Object.assign(out, resolveSelections(ctx, typeName, source, selection.selections ?? [], variables));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const args: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(selection.args ?? {})) args[name] = evalValue(value, variables);
    out[key] = resolveField(ctx, typeName, source, selection.name, args, selection.selections ?? [], variables);
  }
  return out;
}

function unknownField(ctx: Ctx, typeName: string, field: string): null {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".` });
  return null;
}

function resolveField(
  ctx: Ctx,
  typeName: string,
  source: unknown,
  field: string,
  args: Record<string, unknown>,
  selections: GqlSelection[],
  variables: Record<string, unknown>,
): unknown {
  const store = ctx.store;
  switch (typeName) {
    case 'Query': {
      if (field === 'viewer') {
        return resolveSelections(ctx, 'User', { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email }, selections, variables);
      }
      if (field === 'repository') {
        const owner = args.owner as string;
        const name = args.name as string;
        const repo = store.getRepo(owner, name);
        if (!repo) return null;
        return resolveSelections(ctx, 'Repository', repo, selections, variables);
      }
      if (field === 'node') {
        const parsed = parseGlobalId(String(args.id ?? ''));
        if (!parsed) return null;
        if (parsed.kind === 'Repository') {
          const repo = [...store.repos.values()].find((entry) => entry.id === Number.parseInt(parsed.value, 10));
          if (!repo) return null;
          return resolveSelections(ctx, 'Repository', repo, selections, variables);
        }
        if (parsed.kind === 'Issue') {
          const [repoId, number] = parsed.value.split(':');
          const repo = [...store.repos.values()].find((entry) => entry.id === Number.parseInt(repoId, 10));
          const issue = repo?.issues.get(Number.parseInt(number, 10));
          if (!repo || !issue) return null;
          return resolveSelections(ctx, 'Issue', { repo, issue }, selections, variables);
        }
        if (parsed.kind === 'PullRequest') {
          const [repoId, number] = parsed.value.split(':');
          const repo = [...store.repos.values()].find((entry) => entry.id === Number.parseInt(repoId, 10));
          const pull = repo?.pulls.get(Number.parseInt(number, 10));
          if (!repo || !pull) return null;
          return resolveSelections(ctx, 'PullRequest', { repo, pull }, selections, variables);
        }
        return null;
      }
      if (field === '__type') {
        const info = SCHEMA[String(args.name ?? '')];
        if (!info) return null;
        return resolveSelections(ctx, '__Type', { name: String(args.name), ...info }, selections, variables);
      }
      if (field === '__schema') return null;
      return unknownField(ctx, 'Query', field);
    }
    case '__Type': {
      const sourceRecord = source as { name: string; kind: string; fields?: string[]; enumValues?: string[] };
      if (field === 'name') return sourceRecord.name;
      if (field === 'kind') return sourceRecord.kind;
      if (field === 'fields') {
        const fields = (sourceRecord.fields ?? []).map((name) => ({ name }));
        return fields.map((entry) => resolveSelections(ctx, '__Field', entry, selections, variables));
      }
      if (field === 'enumValues') {
        const values = (sourceRecord.enumValues ?? []).map((name) => ({ name }));
        return values.map((entry) => resolveSelections(ctx, '__EnumValue', entry, selections, variables));
      }
      return unknownField(ctx, '__Type', field);
    }
    case '__Field':
    case '__EnumValue': {
      if (field === 'name') return (source as { name: string }).name;
      return unknownField(ctx, typeName, field);
    }
    case 'User': {
      const user = source as { login: string; id: number; name?: string; email?: string };
      if (field === 'login') return user.login;
      if (field === 'id') return globalId('User', user.id);
      if (field === 'name') return user.name ?? user.login;
      if (field === 'email') return user.email ?? '';
      if (field === 'url') return `https://github.com/${user.login}`;
      if (field === 'avatarUrl') return `https://avatars.githubusercontent.com/u/${user.id}?v=4`;
      return unknownField(ctx, 'User', field);
    }
    case 'Repository': {
      const repo = source as Repo;
      if (field === 'id') return repoGlobalId(repo);
      if (field === 'databaseId') return repo.id;
      if (field === 'name') return repo.name;
      if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field === 'owner') {
        return resolveSelections(ctx, 'User', { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0 }, selections, variables);
      }
      if (field === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (!tip) return null;
        return resolveSelections(ctx, 'Ref', { name: repo.defaultBranch }, selections, variables);
      }
      if (field === 'viewerPermission') return 'ADMIN';
      if (field === 'hasIssuesEnabled') return true;
      if (field === 'description') return repo.description;
      if (field === 'isPrivate') return repo.isPrivate;
      if (field === 'createdAt') return repo.createdAt;
      if (field === 'updatedAt') return repo.updatedAt;
      if (field === 'url') return `https://github.com/${repo.owner}/${repo.name}`;
      if (field === 'issue') {
        const issue = repo.issues.get(Number(args.number));
        if (!issue) return null;
        return resolveSelections(ctx, 'Issue', { repo, issue }, selections, variables);
      }
      if (field === 'issues') return issuesConnection(ctx, repo, args, selections, variables);
      if (field === 'pullRequests') return pullsConnection(ctx, repo, args, selections, variables);
      if (field === 'pullRequest') {
        const pull = repo.pulls.get(Number(args.number));
        if (!pull) return null;
        return resolveSelections(ctx, 'PullRequest', { repo, pull }, selections, variables);
      }
      return unknownField(ctx, 'Repository', field);
    }
    case 'Ref': {
      if (field === 'name') return (source as { name: string }).name;
      return unknownField(ctx, 'Ref', field);
    }
    case 'Issue': {
      const { repo, issue } = source as { repo: Repo; issue: Issue };
      if (field === 'id') return issueGlobalId(repo, issue);
      if (field === 'number') return issue.number;
      if (field === 'title') return issue.title;
      if (field === 'state') return issueState(issue);
      if (field === 'body') return issue.body;
      if (field === 'createdAt') return issue.createdAt;
      if (field === 'updatedAt') return issue.updatedAt;
      if (field === 'closedAt') return issue.closedAt;
      if (field === 'author') {
        return resolveSelections(ctx, 'User', { login: issue.user, id: issue.user === VIEWER.login ? VIEWER.id : 0 }, selections, variables);
      }
      if (field === 'url') return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      if (field === 'repository') return resolveSelections(ctx, 'Repository', repo, selections, variables);
      return unknownField(ctx, 'Issue', field);
    }
    case 'IssueConnection': {
      const connection = source as { nodes: Array<{ repo: Repo; issue: Issue }>; hasNextPage: boolean; endCursor: string | null };
      if (field === 'nodes') {
        return connection.nodes.map((entry) => resolveSelections(ctx, 'Issue', entry, selections, variables));
      }
      if (field === 'pageInfo') {
        return resolveSelections(ctx, 'PageInfo', { hasNextPage: connection.hasNextPage, endCursor: connection.endCursor }, selections, variables);
      }
      if (field === 'totalCount') return connection.nodes.length;
      return unknownField(ctx, 'IssueConnection', field);
    }
    case 'PullRequest': {
      const { repo, pull } = source as { repo: Repo; pull: PullRequest };
      if (field === 'id') return pullGlobalId(repo, pull);
      if (field === 'number') return pull.number;
      if (field === 'title') return pull.title;
      if (field === 'body') return pull.body;
      if (field === 'state') return pullState(pull);
      if (field === 'merged') return pull.merged;
      if (field === 'headRefName') return pull.headRef;
      if (field === 'baseRefName') return pull.baseRef;
      if (field === 'mergeable') return pull.mergeable ? 'MERGEABLE' : 'CONFLICTING';
      if (field === 'createdAt') return pull.createdAt;
      if (field === 'updatedAt') return pull.updatedAt;
      if (field === 'closedAt') return pull.closedAt;
      if (field === 'mergedAt') return pull.mergedAt;
      if (field === 'author') {
        return resolveSelections(ctx, 'User', { login: pull.user, id: pull.user === VIEWER.login ? VIEWER.id : 0 }, selections, variables);
      }
      if (field === 'url') return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
      if (field === 'repository') return resolveSelections(ctx, 'Repository', repo, selections, variables);
      if (field === 'files') {
        const first = typeof args.first === 'number' ? args.first : pull.files.length;
        const nodes = pull.files.slice(0, first).map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions }));
        const connection = { nodes, hasNextPage: pull.files.length > nodes.length, endCursor: null };
        return resolveSelections(ctx, 'PullRequestChangedFileConnection', connection, selections, variables);
      }
      return unknownField(ctx, 'PullRequest', field);
    }
    case 'PullRequestConnection': {
      const connection = source as { nodes: Array<{ repo: Repo; pull: PullRequest }>; hasNextPage: boolean; endCursor: string | null };
      if (field === 'nodes') {
        return connection.nodes.map((entry) => resolveSelections(ctx, 'PullRequest', entry, selections, variables));
      }
      if (field === 'pageInfo') {
        return resolveSelections(ctx, 'PageInfo', { hasNextPage: connection.hasNextPage, endCursor: connection.endCursor }, selections, variables);
      }
      if (field === 'totalCount') return connection.nodes.length;
      return unknownField(ctx, 'PullRequestConnection', field);
    }
    case 'PullRequestChangedFileConnection': {
      const connection = source as { nodes: Array<{ path: string; additions: number; deletions: number }>; hasNextPage: boolean; endCursor: string | null };
      if (field === 'nodes') {
        return connection.nodes.map((entry) => resolveSelections(ctx, 'PullRequestChangedFile', entry, selections, variables));
      }
      if (field === 'pageInfo') {
        return resolveSelections(ctx, 'PageInfo', { hasNextPage: connection.hasNextPage, endCursor: connection.endCursor }, selections, variables);
      }
      if (field === 'totalCount') return connection.nodes.length;
      return unknownField(ctx, 'PullRequestChangedFileConnection', field);
    }
    case 'PullRequestChangedFile': {
      const file = source as { path: string; additions: number; deletions: number };
      if (field === 'path') return file.path;
      if (field === 'additions') return file.additions;
      if (field === 'deletions') return file.deletions;
      return unknownField(ctx, 'PullRequestChangedFile', field);
    }
    case 'PageInfo': {
      const info = source as { hasNextPage: boolean; endCursor: string | null };
      if (field === 'hasNextPage') return info.hasNextPage;
      if (field === 'endCursor') return info.endCursor;
      if (field === 'hasPreviousPage') return false;
      if (field === 'startCursor') return info.endCursor;
      return unknownField(ctx, 'PageInfo', field);
    }
    default:
      if (
        typeName === 'CreateIssuePayload' ||
        typeName === 'CloseIssuePayload' ||
        typeName === 'CreatePullRequestPayload' ||
        typeName === 'MergePullRequestPayload' ||
        typeName === 'AddCommentPayload' ||
        typeName === 'IssueCommentEdge' ||
        typeName === 'IssueComment'
      ) {
        return resolvePayloadField(ctx, typeName, source, field, selections, variables);
      }
      return unknownField(ctx, typeName, field);
  }
}

function issuesConnection(
  ctx: Ctx,
  repo: Repo,
  args: Record<string, unknown>,
  selections: GqlSelection[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  let issues = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state.toLowerCase())));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction ?? 'DESC';
  const field = orderBy?.field ?? 'CREATED_AT';
  issues.sort((a, b) => {
    const byNumber = a.number - b.number;
    if (field === 'CREATED_AT' || field === 'UPDATED_AT') return direction === 'ASC' ? byNumber : -byNumber;
    return direction === 'ASC' ? byNumber : -byNumber;
  });
  const afterNumber = cursorNumber(args.after);
  if (afterNumber !== null) {
    const index = issues.findIndex((issue) => issue.number === afterNumber);
    issues = index >= 0 ? issues.slice(index + 1) : issues;
  }
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > page.length;
  const endCursor = page.length ? cursorFor(page[page.length - 1].number) : null;
  const connection = { nodes: page.map((issue) => ({ repo, issue })), hasNextPage, endCursor };
  return resolveSelections(ctx, 'IssueConnection', connection, selections, variables);
}

function pullsConnection(
  ctx: Ctx,
  repo: Repo,
  args: Record<string, unknown>,
  selections: GqlSelection[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  let pulls = [...repo.pulls.values()].filter((pull) => pull.state === 'open');
  pulls.sort((a, b) => b.number - a.number);
  const first = typeof args.first === 'number' ? args.first : pulls.length;
  const page = pulls.slice(0, first);
  const hasNextPage = pulls.length > page.length;
  const endCursor = page.length ? cursorFor(page[page.length - 1].number) : null;
  const connection = { nodes: page.map((pull) => ({ repo, pull })), hasNextPage, endCursor };
  return resolveSelections(ctx, 'PullRequestConnection', connection, selections, variables);
}

// ---------------------------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------------------------

function findRepoByGlobalId(store: ForgeStore, id: unknown): Repo | null {
  const parsed = parseGlobalId(String(id ?? ''));
  if (!parsed || parsed.kind !== 'Repository') return null;
  return [...store.repos.values()].find((repo) => repo.id === Number.parseInt(parsed.value, 10)) ?? null;
}

function findIssueByGlobalId(store: ForgeStore, id: unknown): { repo: Repo; issue: Issue } | null {
  const parsed = parseGlobalId(String(id ?? ''));
  if (!parsed || parsed.kind !== 'Issue') return null;
  const [repoId, number] = parsed.value.split(':');
  const repo = [...store.repos.values()].find((entry) => entry.id === Number.parseInt(repoId, 10));
  const issue = repo?.issues.get(Number.parseInt(number, 10));
  return repo && issue ? { repo, issue } : null;
}

function findPullByGlobalId(store: ForgeStore, id: unknown): { repo: Repo; pull: PullRequest } | null {
  const parsed = parseGlobalId(String(id ?? ''));
  if (!parsed || parsed.kind !== 'PullRequest') return null;
  const [repoId, number] = parsed.value.split(':');
  const repo = [...store.repos.values()].find((entry) => entry.id === Number.parseInt(repoId, 10));
  const pull = repo?.pulls.get(Number.parseInt(number, 10));
  return repo && pull ? { repo, pull } : null;
}

function executeMutation(ctx: Ctx, operation: GqlOperation, variables: Record<string, unknown>): Record<string, unknown> {
  const store = ctx.store;
  const out: Record<string, unknown> = {};
  for (const selection of operation.selections) {
    const key = selection.alias ?? selection.name;
    const args: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(selection.args ?? {})) args[name] = evalValue(value, variables);
    if (selection.name === 'createIssue') {
      const input = (args.input ?? {}) as { repositoryId?: string; title?: string; body?: string };
      const repo = findRepoByGlobalId(store, input.repositoryId);
      if (!repo) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
        out[key] = null;
        continue;
      }
      repo.issueCounter += 1;
      const now = store.nowIso();
      const issue: Issue = {
        number: repo.issueCounter,
        id: repo.id * 100000 + repo.issueCounter,
        title: input.title ?? '',
        body: input.body ?? '',
        state: 'open',
        labels: [],
        user: VIEWER.login,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        comments: [],
      };
      repo.issues.set(issue.number, issue);
      out[key] = resolveSelections(ctx, 'CreateIssuePayload', { repo, issue }, selection.selections ?? [], variables);
      continue;
    }
    if (selection.name === 'closeIssue') {
      const input = (args.input ?? {}) as { issueId?: string };
      const found = findIssueByGlobalId(store, input.issueId);
      if (!found) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
        out[key] = null;
        continue;
      }
      found.issue.state = 'closed';
      found.issue.closedAt = store.nowIso();
      found.issue.updatedAt = found.issue.closedAt;
      out[key] = resolveSelections(ctx, 'CloseIssuePayload', found, selection.selections ?? [], variables);
      continue;
    }
    if (selection.name === 'createPullRequest') {
      const input = (args.input ?? {}) as { repositoryId?: string; baseRefName?: string; headRefName?: string; title?: string; body?: string };
      const repo = findRepoByGlobalId(store, input.repositoryId);
      const headSha = repo?.refs.get(`refs/heads/${input.headRefName ?? ''}`);
      const baseSha = repo?.refs.get(`refs/heads/${input.baseRefName ?? ''}`);
      if (!repo || !headSha || !baseSha) {
        ctx.errors.push({ message: 'Could not resolve to a Repository or the head/base branch does not exist.' });
        out[key] = null;
        continue;
      }
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
        title: input.title ?? '',
        body: input.body ?? '',
        state: 'open',
        headRef: input.headRefName ?? '',
        headSha,
        baseRef: input.baseRefName ?? '',
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
      out[key] = resolveSelections(ctx, 'CreatePullRequestPayload', { repo, pull }, selection.selections ?? [], variables);
      continue;
    }
    if (selection.name === 'mergePullRequest') {
      const input = (args.input ?? {}) as { pullRequestId?: string; mergeMethod?: string };
      const found = findPullByGlobalId(store, input.pullRequestId);
      if (!found) {
        ctx.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
        out[key] = null;
        continue;
      }
      const { repo, pull } = found;
      if (pull.state !== 'open') {
        ctx.errors.push({ message: 'Pull request is already closed.' });
        out[key] = resolveSelections(ctx, 'MergePullRequestPayload', found, selection.selections ?? [], variables);
        continue;
      }
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
      const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
      if (!baseTip || !headTip) {
        ctx.errors.push({ message: 'The head or base branch no longer exists.' });
        out[key] = null;
        continue;
      }
      const baseOfMerge = store.mergeBase(repo, headTip, baseTip);
      const mergeBaseTree = baseOfMerge ? parseCommit(repo.objects.get(baseOfMerge)!.data).tree : parseCommit(repo.objects.get(baseTip)!.data).tree;
      const baseTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
      const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
      const mergedTree = store.threeWayMerge(repo, mergeBaseTree, baseTree, headTree);
      if (mergedTree === null) {
        ctx.errors.push({ message: 'Merge conflict.' });
        out[key] = resolveSelections(ctx, 'MergePullRequestPayload', found, selection.selections ?? [], variables);
        continue;
      }
      const mergeSha = store.commitOnBranch(repo, pull.baseRef, mergedTree, [baseTip], `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergeCommitSha = mergeSha;
      pull.mergedAt = store.nowIso();
      pull.closedAt = pull.mergedAt;
      pull.updatedAt = pull.mergedAt;
      out[key] = resolveSelections(ctx, 'MergePullRequestPayload', found, selection.selections ?? [], variables);
      continue;
    }
    if (selection.name === 'addComment') {
      const input = (args.input ?? {}) as { subjectId?: string; body?: string };
      const found = findIssueByGlobalId(store, input.subjectId);
      if (!found) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
        out[key] = null;
        continue;
      }
      const { repo, issue } = found;
      repo.commentCounter += 1;
      const now = store.nowIso();
      const comment = { id: repo.commentCounter, body: input.body ?? '', user: VIEWER.login, createdAt: now, updatedAt: now };
      issue.comments.push(comment);
      out[key] = resolveSelections(
        ctx,
        'AddCommentPayload',
        { repo, issue, comment },
        selection.selections ?? [],
        variables,
      );
      continue;
    }
    ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "Mutation".` });
    out[key] = null;
  }
  return out;
}

// Mutation payload resolvers live inside resolveField's switch through these pseudo-types.
function resolvePayloadField(
  ctx: Ctx,
  typeName: string,
  source: unknown,
  field: string,
  selections: GqlSelection[],
  variables: Record<string, unknown>,
): unknown {
  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    const { repo, issue } = source as { repo: Repo; issue: Issue };
    if (field === 'issue') return resolveSelections(ctx, 'Issue', { repo, issue }, selections, variables);
    return unknownField(ctx, typeName, field);
  }
  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    const { repo, pull } = source as { repo: Repo; pull: PullRequest };
    if (field === 'pullRequest') return resolveSelections(ctx, 'PullRequest', { repo, pull }, selections, variables);
    return unknownField(ctx, typeName, field);
  }
  if (typeName === 'AddCommentPayload') {
    const { repo, issue, comment } = source as { repo: Repo; issue: Issue; comment: { id: number; body: string } };
    if (field === 'commentEdge') {
      return resolveSelections(ctx, 'IssueCommentEdge', { repo, issue, comment }, selections, variables);
    }
    return unknownField(ctx, typeName, field);
  }
  if (typeName === 'IssueCommentEdge') {
    const { repo, issue, comment } = source as { repo: Repo; issue: Issue; comment: { id: number; body: string } };
    if (field === 'node') {
      return resolveSelections(ctx, 'IssueComment', { repo, issue, comment }, selections, variables);
    }
    return unknownField(ctx, typeName, field);
  }
  if (typeName === 'IssueComment') {
    const { repo, issue, comment } = source as { repo: Repo; issue: Issue; comment: { id: number; body: string; createdAt: string; updatedAt: string } };
    if (field === 'id') return globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`);
    if (field === 'body') return comment.body;
    if (field === 'createdAt') return comment.createdAt;
    if (field === 'updatedAt') return comment.updatedAt;
    return unknownField(ctx, typeName, field);
  }
  return unknownField(ctx, typeName, field);
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

function executeOne(store: ForgeStore, query: string, variables: Record<string, unknown>): { data: unknown; errors: Array<{ message: string }> } {
  const ctx: Ctx = { store, errors: [] };
  let operation: GqlOperation;
  try {
    operation = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: (err as Error).message }] };
  }
  if (operation.kind === 'mutation') {
    const data = executeMutation(ctx, operation, variables);
    return { data, errors: ctx.errors };
  }
  const data = resolveSelections(ctx, 'Query', null, operation.selections, variables);
  return { data, errors: ctx.errors };
}

export async function handleGraphql(store: ForgeStore, body: Buffer): Promise<GraphqlResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return { status: 400, body: { errors: [{ message: 'request body must be valid JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return { data: null, errors: [{ message: 'each batched operation must be an object' }] };
      const { query, variables } = entry as { query?: unknown; variables?: unknown };
      if (typeof query !== 'string') return { data: null, errors: [{ message: 'each batched operation needs a query string' }] };
      return executeOne(store, query, (variables ?? {}) as Record<string, unknown>);
    });
    return { status: 200, body: results };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: { errors: [{ message: 'request body must be an object or an array of operations' }] } };
  }
  const { query, variables } = parsed as { query?: unknown; variables?: unknown };
  if (typeof query !== 'string') {
    return { status: 400, body: { errors: [{ message: 'query must be a string' }] } };
  }
  const result = executeOne(store, query, (variables ?? {}) as Record<string, unknown>);
  return { status: 200, body: result };
}
