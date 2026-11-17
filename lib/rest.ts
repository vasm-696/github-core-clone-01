/**
 * lib/rest.ts — the REST v3 surface: repositories, branches, commits, contents, labels,
 * issues, pull requests and the protocol checks' endpoints.
 *
 * Ownership is the token's viewer (adaiversen): a repository under any other owner answers
 * 404, never 403. Every reply is JSON with a string `message` on errors; DELETE answers 204
 * with no body. Lists paginate with `page`/`per_page` and a same-origin `Link` header.
 */
import {
  globalId,
  VIEWER,
  type ForgeStore,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { isObjectId, parseCommit } from './git.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  empty?: boolean;
}

type Json = Record<string, unknown>;

function notFound(message = 'Not Found'): RestResult {
  return { status: 404, body: { message } };
}

function badRequest(message: string): RestResult {
  return { status: 400, body: { message } };
}

function parseJsonBody(body: Buffer): { ok: true; value: Json } | { ok: false; result: RestResult } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, result: badRequest('request body must be a JSON object') };
    }
    return { ok: true, value: value as Json };
  } catch {
    return { ok: false, result: badRequest('malformed JSON body') };
  }
}

function baseUrlOf(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

function pageParams(url: URL): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const perPageRaw = Number.parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30;
  const perPage = Math.min(100, Math.max(1, perPageRaw));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], url: URL, total: number): { page: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(url);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const links: string[] = [];
  const make = (p: number, rel: string): string => `<${baseUrlOf(url)}${url.pathname}?${new URLSearchParams({ ...Object.fromEntries(url.searchParams), page: String(p), per_page: String(perPage) }).toString()}>; rel="${rel}"`;
  if (page < lastPage) links.push(make(page + 1, 'next'));
  if (page > 1) links.push(make(page - 1, 'prev'));
  links.push(make(1, 'first'));
  links.push(make(lastPage, 'last'));
  return { page: [...slice], headers: links.length ? { link: links.join(', ') } : {} };
}

// ---------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------

function userJson(login: string, id: number): Json {
  return {
    login,
    id,
    node_id: globalId('User', id),
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: 'User',
    site_admin: false,
  };
}

function repoJson(repo: Repo, url: URL): Json {
  const base = baseUrlOf(url);
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, repo.owner === VIEWER.login ? VIEWER.id : 0),
    private: repo.isPrivate,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function issueJson(repo: Repo, issue: Issue, url: URL): Json {
  const base = baseUrlOf(url);
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(issue.user, issue.user === VIEWER.login ? VIEWER.id : 0),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { id: 0, node_id: globalId('Label', `${repo.id}:${name}`), name, color: label?.color ?? 'ededed', description: label?.description ?? '', default: true };
    }),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    active_lock_reason: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    state_reason: null,
  };
}

function pullJson(repo: Repo, pull: PullRequest, url: URL): Json {
  const base = baseUrlOf(url);
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(pull.user, pull.user === VIEWER.login ? VIEWER.id : 0),
    labels: [],
    milestone: null,
    locked: false,
    active_lock_reason: null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: userJson(repo.owner, VIEWER.id),
      repo: repoJson(repo, url),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: userJson(repo.owner, VIEWER.id),
      repo: repoJson(repo, url),
    },
    merged: pull.merged,
    mergeable: pull.mergeable,
    mergeable_state: pull.mergeable ? 'clean' : 'dirty',
    merged_by: null,
    comments: 0,
    review_comments: 0,
    commits: 1,
    additions: pull.files.reduce((sum, file) => sum + file.additions, 0),
    deletions: pull.files.reduce((sum, file) => sum + file.deletions, 0),
    changed_files: pull.files.length,
    author_association: 'OWNER',
  };
}

function commitJson(repo: Repo, sha: string): Json | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const ident = (text: string): { name: string; email: string; date: string } => {
    const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(text);
    if (!match) return { name: text, email: '', date: repo.createdAt };
    return {
      name: match[1],
      email: match[2],
      date: new Date(Number.parseInt(match[3], 10) * 1000).toISOString().replace('.000Z', 'Z'),
    };
  };
  return {
    sha,
    commit: {
      author: ident(commit.author),
      committer: ident(commit.committer),
      message: commit.message,
      tree: { sha: commit.tree },
      url: '',
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: '',
    html_url: '',
    parents: commit.parents.map((parent) => ({ sha: parent, url: '' })),
  };
}

/** The commits reachable from `tip`, tip first, following every parent. */
function history(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------------------------

export async function handleRest(store: ForgeStore, method: string, url: URL, body: Buffer): Promise<RestResult> {
  const segments = url.pathname.split('/').filter(Boolean);
  // segments[0] is 'api', segments[1] is 'v3'.
  const rest = segments.slice(2);

  const needBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
  let parsed: Json = {};
  if (needBody) {
    const result = parseJsonBody(body);
    if (!result.ok) return result.result;
    parsed = result.value;
  }

  // GET /api/v3/ — the API root.
  if (rest.length === 0 && method === 'GET') {
    return {
      status: 200,
      body: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta' && method === 'GET') {
    return { status: 200, body: { installed_version: '1.0.0' } };
  }
  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
    return {
      status: 200,
      body: {
        login: VIEWER.login,
        id: VIEWER.id,
        node_id: globalId('User', VIEWER.id),
        name: VIEWER.name,
        email: VIEWER.email,
        type: 'User',
        site_admin: false,
      },
    };
  }
  // GET /api/v3/user/repos, POST /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const repos = store.listRepos(VIEWER.login);
      const { page, headers } = paginate(repos, url, repos.length);
      return { status: 200, body: page.map((repo) => repoJson(repo, url)), headers };
    }
    if (method === 'POST') {
      const name = typeof parsed.name === 'string' ? parsed.name : '';
      if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        return { status: 422, body: { message: 'Invalid repository name' } };
      }
      if (store.getRepo(VIEWER.login, name)) {
        return { status: 422, body: { message: 'name already exists on this account' } };
      }
      const repo = store.createRepo(VIEWER.login, name, {
        description: typeof parsed.description === 'string' ? parsed.description : '',
        isPrivate: parsed.private === true,
        defaultBranch: typeof parsed.default_branch === 'string' && parsed.default_branch ? parsed.default_branch : 'main',
      });
      return { status: 201, body: repoJson(repo, url) };
    }
  }

  // /api/v3/repos/{owner}/{name}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = decodeURIComponent(rest[1]);
    const name = decodeURIComponent(rest[2]);
    const tail = rest.slice(3);
    const repo = store.getRepo(owner, name);
    if (!repo) return notFound('Not Found');
    return handleRepo(store, repo, method, url, tail, parsed, body);
  }

  return notFound('Not Found');
}

async function handleRepo(
  store: ForgeStore,
  repo: Repo,
  method: string,
  url: URL,
  tail: string[],
  parsed: Json,
  body: Buffer,
): Promise<RestResult> {
  // GET /repos/{o}/{r}, PATCH, DELETE
  if (tail.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo, url) };
    if (method === 'PATCH') {
      if (typeof parsed.description === 'string') repo.description = parsed.description;
      if (typeof parsed.default_branch === 'string' && parsed.default_branch) repo.defaultBranch = parsed.default_branch;
      if (typeof parsed.private === 'boolean') repo.isPrivate = parsed.private;
      repo.updatedAt = store.nowIso();
      return { status: 200, body: repoJson(repo, url) };
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      return { status: 204, body: null, empty: true };
    }
    return notFound('Not Found');
  }

  // GET /repos/{o}/{r}/branches
  if (tail.length === 1 && tail[0] === 'branches' && method === 'GET') {
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length))
      .sort();
    return {
      status: 200,
      body: branches.map((branch) => ({
        name: branch,
        commit: { sha: repo.refs.get(`refs/heads/${branch}`)!, url: '' },
        protected: false,
      })),
    };
  }

  // GET /repos/{o}/{r}/branches/{branch}
  if (tail.length === 2 && tail[0] === 'branches' && method === 'GET') {
    const branch = decodeURIComponent(tail[1]);
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (!sha) return notFound('Branch not found');
    return {
      status: 200,
      body: {
        name: branch,
        commit: { sha, url: '' },
        protected: false,
      },
    };
  }

  // GET /repos/{o}/{r}/commits[?sha=]
  if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
    const ref = url.searchParams.get('sha') ?? repo.defaultBranch;
    let tip: string | undefined;
    if (isObjectId(ref)) tip = ref;
    else tip = repo.refs.get(`refs/heads/${ref}`);
    if (!tip) return { status: 200, body: [] };
    const commits = history(repo, tip).map((sha) => commitJson(repo, sha)).filter((entry): entry is Json => entry !== null);
    const { page } = paginate(commits, url, commits.length);
    return { status: 200, body: page };
  }

  // GET /repos/{o}/{r}/git/refs/{ref...} — e.g. heads/main
  if (tail.length >= 3 && tail[0] === 'git' && tail[1] === 'refs' && method === 'GET') {
    const ref = `refs/${tail.slice(2).map((segment) => decodeURIComponent(segment)).join('/')}`;
    const sha = repo.refs.get(ref);
    if (!sha) return notFound('Reference not found');
    return { status: 200, body: { ref, object: { sha, type: 'commit', url: '' } } };
  }

  // POST /repos/{o}/{r}/git/refs
  if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs' && method === 'POST') {
    const ref = typeof parsed.ref === 'string' ? parsed.ref : '';
    const sha = typeof parsed.sha === 'string' ? parsed.sha : '';
    if (!ref.startsWith('refs/') || !isObjectId(sha)) {
      return { status: 422, body: { message: 'Invalid ref or sha' } };
    }
    if (repo.refs.has(ref)) return { status: 422, body: { message: 'Reference already exists' } };
    if (!repo.objects.has(sha)) return { status: 422, body: { message: 'Object does not exist' } };
    repo.refs.set(ref, sha);
    return { status: 201, body: { ref, object: { sha, type: 'commit', url: '' } } };
  }

  // /repos/{o}/{r}/contents/{path...}
  if (tail[0] === 'contents') {
    const path = tail.slice(1).map((segment) => decodeURIComponent(segment)).join('/');
    return handleContents(store, repo, method, url, path, parsed);
  }

  // /repos/{o}/{r}/labels
  if (tail.length === 1 && tail[0] === 'labels') {
    if (method === 'GET') {
      return {
        status: 200,
        body: [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: label.description })),
      };
    }
    if (method === 'POST') {
      const name = typeof parsed.name === 'string' ? parsed.name : '';
      if (!name) return { status: 422, body: { message: 'Label name is required' } };
      const existing = repo.labels.get(name);
      if (existing) {
        if (typeof parsed.color === 'string') existing.color = parsed.color;
        if (typeof parsed.description === 'string') existing.description = parsed.description;
        return { status: 201, body: { name: existing.name, color: existing.color, description: existing.description } };
      }
      const label = {
        name,
        color: typeof parsed.color === 'string' ? parsed.color : 'ededed',
        description: typeof parsed.description === 'string' ? parsed.description : '',
      };
      repo.labels.set(name, label);
      return { status: 201, body: { name: label.name, color: label.color, description: label.description } };
    }
  }

  // /repos/{o}/{r}/issues...
  if (tail[0] === 'issues') return handleIssues(store, repo, method, url, tail.slice(1), parsed);

  // /repos/{o}/{r}/pulls...
  if (tail[0] === 'pulls') return handlePulls(store, repo, method, url, tail.slice(1), parsed);

  return notFound('Not Found');
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function resolveRefTip(repo: Repo, ref: string | null): string | null {
  if (!ref) return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (isObjectId(ref)) {
    const object = repo.objects.get(ref);
    return object?.type === 'commit' ? ref : null;
  }
  return repo.refs.get(`refs/heads/${ref}`) ?? null;
}

function handleContents(
  store: ForgeStore,
  repo: Repo,
  method: string,
  url: URL,
  path: string,
  parsed: Json,
): RestResult {
  if (method === 'PUT') {
    const message = typeof parsed.message === 'string' ? parsed.message : `Update ${path}`;
    const contentB64 = typeof parsed.content === 'string' ? parsed.content : '';
    if (!contentB64) return { status: 422, body: { message: 'content is required' } };
    let content: Buffer;
    try {
      content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    } catch {
      return badRequest('content is not valid base64');
    }
    const branch = typeof parsed.branch === 'string' && parsed.branch ? parsed.branch : repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const tipTree = tip ? parseCommit(repo.objects.get(tip)!.data).tree : null;
    const currentBlob = tipTree ? store.blobAt(repo, tipTree, path) : null;
    const givenSha = typeof parsed.sha === 'string' ? parsed.sha : undefined;
    if (currentBlob) {
      if (!givenSha) return { status: 409, body: { message: 'sha was not supplied' } };
      if (givenSha.toLowerCase() !== currentBlob.toLowerCase()) {
        return { status: 409, body: { message: 'sha does not match the current file' } };
      }
    } else if (givenSha) {
      return { status: 409, body: { message: 'sha does not match the current file' } };
    }
    const blobOid = store.putObject(repo, 'blob', content);
    const newTree = store.setPath(repo, tipTree, path, blobOid);
    const commitOid = store.commitOnBranch(repo, branch, newTree, tip ? [tip] : [], message);
    return {
      status: currentBlob ? 200 : 201,
      body: {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: blobOid,
          size: content.length,
          url: '',
          html_url: '',
          git_url: '',
          download_url: null,
          type: 'file',
          encoding: 'base64',
          content: content.toString('base64'),
        },
        commit: { sha: commitOid },
      },
    };
  }
  if (method === 'GET') {
    const ref = url.searchParams.get('ref');
    const tip = resolveRefTip(repo, ref);
    if (!tip) return notFound('Not Found');
    const tree = parseCommit(repo.objects.get(tip)!.data).tree;
    const blobOid = path ? store.blobAt(repo, tree, path) : null;
    if (blobOid) {
      const object = repo.objects.get(blobOid)!;
      return {
        status: 200,
        body: {
          name: path.split('/').pop() ?? path,
          path,
          sha: blobOid,
          size: object.data.length,
          url: '',
          html_url: '',
          git_url: '',
          download_url: null,
          type: 'file',
          encoding: 'base64',
          content: object.data.toString('base64'),
        },
      };
    }
    const entries = store.treeEntriesAt(repo, tree, path);
    if (!entries) return notFound('Not Found');
    return {
      status: 200,
      body: entries.map((entry) => ({
        name: entry.name,
        path: path ? `${path}/${entry.name}` : entry.name,
        sha: entry.oid,
        size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
        url: '',
        html_url: '',
        git_url: '',
        download_url: null,
        type: entry.mode === '40000' ? 'dir' : 'file',
      })),
    };
  }
  if (method === 'DELETE') {
    const givenSha = typeof parsed.sha === 'string' ? parsed.sha : undefined;
    const message = typeof parsed.message === 'string' ? parsed.message : `Delete ${path}`;
    const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (!tip) return notFound('Not Found');
    const tree = parseCommit(repo.objects.get(tip)!.data).tree;
    const currentBlob = store.blobAt(repo, tree, path);
    if (!currentBlob) return notFound('Not Found');
    if (givenSha && givenSha.toLowerCase() !== currentBlob.toLowerCase()) {
      return { status: 409, body: { message: 'sha does not match the current file' } };
    }
    const newTree = store.setPath(repo, tree, path, null);
    const commitOid = store.commitOnBranch(repo, repo.defaultBranch, newTree, [tip], message);
    return { status: 200, body: { commit: { sha: commitOid } } };
  }
  return notFound('Not Found');
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

function handleIssues(
  store: ForgeStore,
  repo: Repo,
  method: string,
  url: URL,
  tail: string[],
  parsed: Json,
): RestResult {
  // POST /issues, GET /issues
  if (tail.length === 0) {
    if (method === 'POST') {
      const title = typeof parsed.title === 'string' ? parsed.title : '';
      const bodyText = typeof parsed.body === 'string' ? parsed.body : '';
      const labels = Array.isArray(parsed.labels) ? parsed.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) {
          return { status: 422, body: { message: `Validation Failed: label ${label} does not exist` } };
        }
      }
      repo.issueCounter += 1;
      const now = store.nowIso();
      const issue: Issue = {
        number: repo.issueCounter,
        id: repo.id * 100000 + repo.issueCounter,
        title,
        body: bodyText,
        state: 'open',
        labels,
        user: VIEWER.login,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        comments: [],
      };
      repo.issues.set(issue.number, issue);
      return { status: 201, body: issueJson(repo, issue, url) };
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => {
        const byNumber = a.number - b.number;
        return sort === 'created' && direction === 'asc' ? byNumber : -byNumber;
      });
      const { page } = paginate(issues, url, issues.length);
      return { status: 200, body: page.map((issue) => issueJson(repo, issue, url)) };
    }
    return notFound('Not Found');
  }
  // /issues/{n}...
  const number = Number.parseInt(tail[0], 10);
  if (!Number.isInteger(number)) return notFound('Not Found');
  const issue = repo.issues.get(number);
  if (!issue) return notFound('Not Found');
  if (tail.length === 1) {
    if (method === 'GET') return { status: 200, body: issueJson(repo, issue, url) };
    if (method === 'PATCH') {
      if (parsed.state === 'open' || parsed.state === 'closed') {
        issue.state = parsed.state;
        issue.closedAt = parsed.state === 'closed' ? store.nowIso() : null;
      }
      if (typeof parsed.title === 'string') issue.title = parsed.title;
      if (typeof parsed.body === 'string') issue.body = parsed.body;
      if (Array.isArray(parsed.labels)) {
        const labels = parsed.labels.filter((l): l is string => typeof l === 'string');
        for (const label of labels) {
          if (!repo.labels.has(label)) return { status: 422, body: { message: `Validation Failed: label ${label} does not exist` } };
        }
        issue.labels = labels;
      }
      issue.updatedAt = store.nowIso();
      return { status: 200, body: issueJson(repo, issue, url) };
    }
    return notFound('Not Found');
  }
  // /issues/{n}/comments
  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'POST') {
      const bodyText = typeof parsed.body === 'string' ? parsed.body : '';
      repo.commentCounter += 1;
      const now = store.nowIso();
      const comment = { id: repo.commentCounter, body: bodyText, user: VIEWER.login, createdAt: now, updatedAt: now };
      issue.comments.push(comment);
      return {
        status: 201,
        body: {
          id: comment.id,
          node_id: globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`),
          body: comment.body,
          user: userJson(VIEWER.login, VIEWER.id),
          created_at: comment.createdAt,
          updated_at: comment.updatedAt,
        },
      };
    }
    if (method === 'GET') {
      return {
        status: 200,
        body: issue.comments.map((comment) => ({
          id: comment.id,
          node_id: globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`),
          body: comment.body,
          user: userJson(VIEWER.login, VIEWER.id),
          created_at: comment.createdAt,
          updated_at: comment.updatedAt,
        })),
      };
    }
  }
  return notFound('Not Found');
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

function handlePulls(
  store: ForgeStore,
  repo: Repo,
  method: string,
  url: URL,
  tail: string[],
  parsed: Json,
): RestResult {
  // POST /pulls, GET /pulls
  if (tail.length === 0) {
    if (method === 'POST') {
      const head = typeof parsed.head === 'string' ? parsed.head : '';
      const base = typeof parsed.base === 'string' ? parsed.base : repo.defaultBranch;
      const title = typeof parsed.title === 'string' ? parsed.title : '';
      const bodyText = typeof parsed.body === 'string' ? parsed.body : '';
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) {
        return { status: 422, body: { message: 'head or base branch does not exist' } };
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
        title,
        body: bodyText,
        state: 'open',
        headRef: head,
        headSha,
        baseRef: base,
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
      return { status: 201, body: pullJson(repo, pull, url) };
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.number - a.number);
      const { page } = paginate(pulls, url, pulls.length);
      return { status: 200, body: page.map((pull) => pullJson(repo, pull, url)) };
    }
    return notFound('Not Found');
  }
  const number = Number.parseInt(tail[0], 10);
  if (!Number.isInteger(number)) return notFound('Not Found');
  const pull = repo.pulls.get(number);
  if (!pull) return notFound('Not Found');
  // GET /pulls/{n}/files
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    return { status: 200, body: pull.files };
  }
  // PUT /pulls/{n}/merge
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pull.state !== 'open') return { status: 405, body: { message: 'Pull request is already closed' } };
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    if (!baseTip || !headTip) return { status: 404, body: { message: 'Not Found' } };
    const baseOfMerge = store.mergeBase(repo, headTip, baseTip);
    const mergeBaseTree = baseOfMerge ? parseCommit(repo.objects.get(baseOfMerge)!.data).tree : parseCommit(repo.objects.get(baseTip)!.data).tree;
    const baseTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const mergedTree = store.threeWayMerge(repo, mergeBaseTree, baseTree, headTree);
    if (mergedTree === null) {
      return { status: 405, body: { message: 'Merge conflict' } };
    }
    const message = typeof parsed.commit_message === 'string' && parsed.commit_message
      ? parsed.commit_message
      : `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
    const mergeSha = store.commitOnBranch(repo, pull.baseRef, mergedTree, [baseTip], message);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = mergeSha;
    pull.mergedAt = store.nowIso();
    pull.closedAt = pull.mergedAt;
    pull.updatedAt = pull.mergedAt;
    return { status: 200, body: { sha: mergeSha, merged: true, message: 'Pull request successfully merged' } };
  }
  // GET /pulls/{n}, PATCH /pulls/{n}
  if (tail.length === 1) {
    if (method === 'GET') return { status: 200, body: pullJson(repo, pull, url) };
    if (method === 'PATCH') {
      if (typeof parsed.title === 'string') pull.title = parsed.title;
      if (typeof parsed.body === 'string') pull.body = parsed.body;
      if (parsed.state === 'open' || parsed.state === 'closed') {
        pull.state = parsed.state;
        pull.closedAt = parsed.state === 'closed' ? store.nowIso() : null;
      }
      pull.updatedAt = store.nowIso();
      return { status: 200, body: pullJson(repo, pull, url) };
    }
  }
  return notFound('Not Found');
}
