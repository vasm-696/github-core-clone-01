/**
 * lib/store.ts — the forge's in-memory store: repositories, git objects and refs, issues, pull
 * requests, labels and comments. One process, no persistence: every trial starts empty and the
 * suite builds what it needs through the API.
 *
 * The trial's viewer is fixed for this competition (the kit's scenario seed is a constant, so
 * the scenario's viewer is always the same user): adaiversen (id 1000). The stranger whose
 * repositories must answer 404 is olgabauer (id 1002).
 */
import {
  buildCommit,
  buildTree,
  hashObject,
  isObjectId,
  parseCommit,
  parseTree,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const TEAMMATE = { login: 'quinnkeller', id: 1001, name: 'quinn keller', email: 'quinnkeller@example.invalid' } as const;
export const STRANGER = { login: 'olgabauer', id: 1002, name: 'olga bauer', email: 'olgabauer@example.invalid' } as const;
export const ORG = 'faint-meadow-org';

export const VIEWER_IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

/** The scenario's default issue labels; every new repository starts with them, as on GitHub. */
export const DEFAULT_LABELS: ReadonlyArray<{ name: string; color: string; description: string }> = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
];

/** The trial's fixed opening time; every timestamp the forge emits derives from it. */
export function trialNowMs(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  if (Number.isFinite(parsed)) return parsed;
  return Date.parse('2026-11-14T06:30:00Z');
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: IssueComment[];
}

export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface PullRequest {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  files: PullFile[];
  mergeable: boolean;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  issueCounter: number;
  pulls: Map<number, PullRequest>;
  pullCounter: number;
  labels: Map<string, Label>;
  commentCounter: number;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function globalId(kind: string, id: string | number): string {
  return Buffer.from(`${kind}:${id}`).toString('base64');
}

export function parseGlobalId(id: string): { kind: string; value: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    return { kind: decoded.slice(0, colon), value: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

export class ForgeStore {
  readonly repos = new Map<string, Repo>();
  private repoCounter = 0;
  private objectCounter = 0;
  /** Monotonic clock: every created object gets a strictly increasing timestamp. */
  private tick = 0;

  /** The next timestamp, one second after the previous one, as an ISO string. */
  nowIso(): string {
    const ms = trialNowMs() + this.tick * 1000;
    this.tick += 1;
    return new Date(ms).toISOString().replace('.000Z', 'Z');
  }

  /** The next timestamp as unix seconds (for git commit objects). */
  nowSec(): number {
    return Math.floor(trialNowMs() / 1000) + this.tick;
  }

  createRepo(owner: string, name: string, opts: { description?: string; isPrivate?: boolean; defaultBranch?: string } = {}): Repo {
    const key = repoKey(owner, name);
    if (this.repos.has(key)) throw new Error(`repo ${key} already exists`);
    this.repoCounter += 1;
    const now = this.nowIso();
    const repo: Repo = {
      id: this.repoCounter,
      name,
      owner,
      description: opts.description ?? '',
      isPrivate: opts.isPrivate ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      createdAt: now,
      updatedAt: now,
      pushedAt: now,
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      issueCounter: 0,
      pulls: new Map(),
      pullCounter: 0,
      labels: new Map(DEFAULT_LABELS.map((label) => [label.name, { ...label }])),
      commentCounter: 0,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  /** Store an object; returns its id. */
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** The tip of a ref, or the zero id when it does not exist. */
  refTip(repo: Repo, ref: string): string {
    return repo.refs.get(ref) ?? ZERO_OID;
  }

  /** The commit at the tip of a branch, or null when the branch is unborn. */
  branchCommit(repo: Repo, branch: string): string | null {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    return tip && tip !== ZERO_OID ? tip : null;
  }

  // -------------------------------------------------------------------------------------------
  // trees
  // -------------------------------------------------------------------------------------------

  /** The tree entries at a path inside a tree (`''` is the root), or null when absent. */
  treeEntriesAt(repo: Repo, treeOid: string, path: string): TreeEntry[] | null {
    if (!isObjectId(treeOid)) return null;
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return null;
    if (!path) return parseTree(object.data);
    const parts = path.split('/').filter(Boolean);
    let current = treeOid;
    for (const part of parts) {
      const obj = repo.objects.get(current);
      if (!obj || obj.type !== 'tree') return null;
      const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
      if (!entry) return null;
      current = entry.oid;
    }
    const leaf = repo.objects.get(current);
    if (!leaf || leaf.type !== 'tree') return null;
    return parseTree(leaf.data);
  }

  /** The blob id at a path in a tree, or null when the path is not a file. */
  blobAt(repo: Repo, treeOid: string, path: string): string | null {
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) return null;
    const parent = parts.slice(0, -1).join('/');
    const entries = this.treeEntriesAt(repo, treeOid, parent);
    if (!entries) return null;
    const entry = entries.find((e) => e.name === parts[parts.length - 1]);
    if (!entry || entry.mode === '40000') return null;
    return entry.oid;
  }

  /**
   * A new tree with `path` set to `blobOid` (or removed when `blobOid` is null), built from
   * `treeOid` (or an empty tree when null). Returns the new tree's id.
   */
  setPath(repo: Repo, treeOid: string | null, path: string, blobOid: string | null): string {
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) throw new Error('empty path');
    const build = (current: string | null, depth: number): string => {
      const entries = current ? parseTree(repo.objects.get(current)!.data) : [];
      const name = parts[depth];
      const isLeaf = depth === parts.length - 1;
      const out: TreeEntry[] = [];
      let replaced = false;
      for (const entry of entries) {
        if (entry.name !== name) {
          out.push(entry);
          continue;
        }
        replaced = true;
        if (isLeaf) {
          if (blobOid) out.push({ mode: '100644', name, oid: blobOid });
        } else {
          const child = this.setPath(repo, entry.oid, parts.slice(depth + 1).join('/'), blobOid);
          // An emptied directory drops out of its parent.
          const childObj = repo.objects.get(child);
          if (childObj && parseTree(childObj.data).length > 0) out.push({ mode: '40000', name, oid: child });
        }
      }
      if (!replaced) {
        if (isLeaf) {
          if (blobOid) out.push({ mode: '100644', name, oid: blobOid });
        } else {
          const child = this.setPath(repo, null, parts.slice(depth + 1).join('/'), blobOid);
          out.push({ mode: '40000', name, oid: child });
        }
      }
      const data = buildTree(out);
      return this.putObject(repo, 'tree', data);
    };
    return build(treeOid, 0);
  }

  /** A flat map of path → blob id for every file in a tree. */
  flattenTree(repo: Repo, treeOid: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') out.set(path, entry.oid);
      }
    };
    walk(treeOid, '');
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // commits
  // -------------------------------------------------------------------------------------------

  /** Create a commit on `branch` with `treeOid` and `parents`, and move the branch to it. */
  commitOnBranch(
    repo: Repo,
    branch: string,
    treeOid: string,
    parents: string[],
    message: string,
  ): string {
    const timestamp = this.nowSec();
    const data = buildCommit({
      tree: treeOid,
      parents,
      message,
      author: VIEWER_IDENTITY,
      committer: VIEWER_IDENTITY,
      timestamp,
    });
    const oid = this.putObject(repo, 'commit', data);
    repo.refs.set(`refs/heads/${branch}`, oid);
    repo.pushedAt = this.nowIso();
    this.objectCounter += 1;
    return oid;
  }

  /** The merge-base of two commits: the first common ancestor found walking both histories. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const queueA = [a];
    while (queueA.length) {
      const oid = queueA.pop()!;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const object = repo.objects.get(oid);
      if (object?.type === 'commit') queueA.push(...parseCommit(object.data).parents);
    }
    const queueB = [b];
    const seenB = new Set<string>();
    while (queueB.length) {
      const oid = queueB.pop()!;
      if (ancestorsA.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const object = repo.objects.get(oid);
      if (object?.type === 'commit') queueB.push(...parseCommit(object.data).parents);
    }
    return null;
  }

  /**
   * A three-way file merge of `baseTree` (the merge-base), `oursTree` and `theirsTree`. Returns
   * the merged tree's id, or null when the same file changed on both sides.
   */
  threeWayMerge(repo: Repo, baseTree: string, oursTree: string, theirsTree: string): string | null {
    const base = this.flattenTree(repo, baseTree);
    const ours = this.flattenTree(repo, oursTree);
    const theirs = this.flattenTree(repo, theirsTree);
    const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    let merged = this.putObject(repo, 'tree', buildTree([]));
    const mergedFiles = new Map<string, string>();
    for (const path of paths) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      if (o === t) {
        if (o) mergedFiles.set(path, o);
      } else if (b === o) {
        if (t) mergedFiles.set(path, t);
      } else if (b === t) {
        if (o) mergedFiles.set(path, o);
      } else {
        return null;
      }
    }
    for (const [path, oid] of [...mergedFiles.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
      merged = this.setPath(repo, merged, path, oid);
    }
    return merged;
  }

  /** The files changed between two trees, with per-file change counts. */
  diffFiles(repo: Repo, baseTree: string, headTree: string): PullFile[] {
    const base = this.flattenTree(repo, baseTree);
    const head = this.flattenTree(repo, headTree);
    const files: PullFile[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b === h) continue;
      const countLines = (oid: string | undefined): number => {
        if (!oid) return 0;
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'blob') return 0;
        const text = object.data.toString('utf8');
        return text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      };
      const baseLines = countLines(b);
      const headLines = countLines(h);
      let status: PullFile['status'] = 'modified';
      if (!b) status = 'added';
      else if (!h) status = 'removed';
      let additions = status === 'removed' ? 0 : Math.max(0, headLines - baseLines);
      let deletions = status === 'added' ? 0 : Math.max(0, baseLines - headLines);
      if (status === 'modified' && additions === 0 && deletions === 0) additions = 1;
      files.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return files;
  }
}
