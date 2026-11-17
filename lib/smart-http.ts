/**
 * lib/smart-http.ts — the git smart-HTTP surface: info/refs advertisements (protocol v2 and
 * v0), upload-pack (ls-refs and fetch, v2 and v0) and receive-pack (v0 only).
 *
 * The wire format is git's: pkt-line framing, side-band-64k pack transport, report-status
 * push reports. The suite's client is the other end of every exchange here, so this module
 * answers exactly the requests it sends.
 */
import {
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  verifyPackChecksum,
  writePack,
  ZERO_OID,
  type GitObject,
} from './git.ts';
import { VIEWER, type ForgeStore, type Repo } from './store.ts';

const AGENT = 'forge/1.0';

function sortRefs(refs: Array<{ oid: string; name: string }>): Array<{ oid: string; name: string }> {
  return [...refs].sort((a, b) => {
    if (a.name === 'HEAD') return -1;
    if (b.name === 'HEAD') return 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/** Every ref the repo holds, HEAD first, with peeled lines for annotated tags. */
function refList(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const out: Array<{ oid: string; name: string; peeled?: string }> = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip) out.push({ oid: defaultTip, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: { oid: string; name: string; peeled?: string } = { oid, name };
    const object = repo.objects.get(oid);
    if (object?.type === 'tag') entry.peeled = parseTag(object.data).object;
    out.push(entry);
  }
  return out;
}

function uploadPackCapsV0(repo: Repo): string {
  return [
    'side-band-64k',
    'multi_ack_detailed',
    'thin-pack',
    'ofs-delta',
    'shallow',
    `agent=${AGENT}`,
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
    'object-format=sha1',
  ].join(' ');
}

function receivePackCapsV0(): string {
  return ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`, 'object-format=sha1'].join(' ');
}

/** A v0 ref advertisement: preamble, flush, ref lines (capabilities on the first), flush. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? uploadPackCapsV0(repo) : receivePackCapsV0();
  const refs = refList(repo);
  const items: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  if (refs.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\u0000${caps}\n`);
  } else {
    refs.forEach((ref, index) => {
      const line = index === 0 ? `${ref.oid} ${ref.name}\u0000${caps}\n` : `${ref.oid} ${ref.name}\n`;
      items.push(line);
      if (ref.peeled) items.push(`${ref.peeled} ${ref.name}^{}\n`);
    });
  }
  items.push('flush');
  return encodePktLines(items as Array<string | 'flush'>);
}

/** A v2 capability advertisement: preamble, flush, `version 2`, capability lines, flush. */
function v2Advertisement(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

export interface GitRouteResult {
  status: number;
  contentType: string;
  body: Buffer;
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(
  repo: Repo | undefined,
  service: 'git-upload-pack' | 'git-receive-pack',
  wantsV2: boolean,
): GitRouteResult {
  if (!repo) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
  }
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && wantsV2) {
    return { status: 200, contentType, body: v2Advertisement() };
  }
  return { status: 200, contentType, body: v0Advertisement(repo, service) };
}

// ---------------------------------------------------------------------------------------------
// upload-pack v2: ls-refs
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const refs = refList(repo);
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  if (refs.length === 0) {
    if (args.unborn) lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    return Buffer.concat([encodePktLines(lines), Buffer.from('0000', 'ascii')]);
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.symrefs && ref.name === 'HEAD') line += ` symref-target:refs/heads/${repo.defaultBranch}`;
    if (args.peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  return Buffer.concat([encodePktLines(lines), Buffer.from('0000', 'ascii')]);
}

// ---------------------------------------------------------------------------------------------
// fetch object selection
// ---------------------------------------------------------------------------------------------

interface FetchSelection {
  /** Objects to send, in a deterministic order. */
  objects: GitObject[];
  /** Commits at the shallow boundary of what was sent (their parents stay behind). */
  shallow: string[];
  /** Old boundaries that are now fully held because their parents were sent. */
  unshallow: string[];
}

/** Commits within `depth` of the wants (distance 0 is the want itself). */
function commitsWithinDepth(
  repo: Repo,
  wants: readonly string[],
  depth: number,
): { included: Set<string>; boundary: Set<string> } {
  const included = new Set<string>();
  const boundary = new Set<string>();
  const queue: Array<{ oid: string; distance: number }> = wants.map((oid) => ({ oid, distance: 0 }));
  const seen = new Set<string>();
  while (queue.length) {
    const { oid, distance } = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    included.add(oid);
    const parents = parseCommit(object.data).parents;
    if (distance + 1 >= depth) {
      if (parents.length) boundary.add(oid);
      continue;
    }
    for (const parent of parents) queue.push({ oid: parent, distance: distance + 1 });
  }
  return { included, boundary };
}

/** Commits the client holds: from the haves, stopping at its shallow boundaries. */
function heldCommits(repo: Repo, haves: readonly string[], shallowBoundaries: readonly string[]): Set<string> {
  const boundary = new Set(shallowBoundaries);
  const held = new Set<string>();
  const queue = [...haves];
  while (queue.length) {
    const oid = queue.pop()!;
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    held.add(oid);
    if (boundary.has(oid)) continue;
    queue.push(...parseCommit(object.data).parents);
  }
  return held;
}

/** Objects a client holding exactly `commits` has: each commit and its full tree, descending
 * into a parent only when that parent is also in the set — a shallow boundary stops the walk,
 * so the ancestors below it are not held. */
function collectCommitObjects(repo: Repo, commits: ReadonlySet<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const addTree = (treeOid: string): void => {
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree' || out.has(treeOid)) return;
    out.set(treeOid, object);
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') addTree(entry.oid);
      else if (entry.mode !== '160000') {
        const blob = repo.objects.get(entry.oid);
        if (blob) out.set(entry.oid, blob);
      }
    }
  };
  const queue = [...commits];
  const seen = new Set<string>();
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'tag') {
      out.set(oid, object);
      queue.push(parseTag(object.data).object);
      continue;
    }
    if (object.type !== 'commit') {
      out.set(oid, object);
      continue;
    }
    out.set(oid, object);
    const commit = parseCommit(object.data);
    addTree(commit.tree);
    for (const parent of commit.parents) {
      if (commits.has(parent)) queue.push(parent);
    }
  }
  return out;
}

/** A want oid that is a tag resolves to the tag object plus its target commit. */
function resolveWantTags(repo: Repo, wants: readonly string[]): { tips: string[]; tags: string[] } {
  const tips: string[] = [];
  const tags: string[] = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object?.type === 'tag') {
      tags.push(want);
      tips.push(parseTag(object.data).object);
    } else {
      tips.push(want);
    }
  }
  return { tips, tags };
}

function sortObjects(objects: GitObject[]): GitObject[] {
  return [...objects].sort((a, b) => {
    const ha = hashObject(a.type, a.data);
    const hb = hashObject(b.type, b.data);
    return ha < hb ? -1 : ha > hb ? 1 : 0;
  });
}

function selectFetchObjects(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | undefined,
): FetchSelection {
  if (depth === undefined) {
    const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
    const wanted = collectReachable(wants, lookup, { allowMissing: true });
    const held = collectReachable(haves, lookup, { allowMissing: true });
    const objects: GitObject[] = [];
    for (const oid of wanted) {
      if (held.has(oid)) continue;
      const object = lookup(oid);
      if (object) objects.push(object);
    }
    return { objects: sortObjects(objects), shallow: [], unshallow: [] };
  }
  const { tips, tags } = resolveWantTags(repo, wants);
  const { included, boundary } = commitsWithinDepth(repo, tips, depth);
  const held = heldCommits(repo, haves, shallowBoundaries);
  const sent = new Set([...included].filter((oid) => !held.has(oid)));
  const sentObjects = collectCommitObjects(repo, sent);
  const heldObjects = collectCommitObjects(repo, held);
  const objects: GitObject[] = [];
  for (const [oid, object] of sentObjects) {
    if (!heldObjects.has(oid)) objects.push(object);
  }
  for (const tag of tags) {
    const object = repo.objects.get(tag);
    if (object && !sentObjects.has(tag) && !heldObjects.has(tag)) objects.push(object);
  }
  // A boundary the client already held stays a boundary only if it is still a cutoff; a
  // boundary whose parents are now sent (or held) is unshallow.
  const shallow: string[] = [];
  for (const oid of boundary) {
    if (sent.has(oid)) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const old of shallowBoundaries) {
    const object = repo.objects.get(old);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length && parents.every((p) => sent.has(p) || held.has(p))) unshallow.push(old);
  }
  return { objects: sortObjects(objects), shallow, unshallow };
}

/** The refs pointing at each want oid, for the wanted-refs section. */
function wantedRefs(repo: Repo, wants: readonly string[]): Array<{ oid: string; ref: string }> {
  const out: Array<{ oid: string; ref: string }> = [];
  for (const want of wants) {
    for (const [name, oid] of [...repo.refs.entries()].sort()) {
      if (oid === want) out.push({ oid: want, ref: name });
    }
  }
  return out;
}

/** Sideband band-1 packets carrying `data`, each at most 65515 bytes of payload. */
function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  if (data.length === 0) {
    out.push(encodePktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
    return out;
  }
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    out.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// upload-pack v2: fetch
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  done: boolean;
}

function ackLines(repo: Repo, wants: readonly string[], haves: readonly string[]): string[] {
  if (!haves.length) return ['NAK\n'];
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const wantedAncestors = collectReachable(wants, lookup, { allowMissing: true });
  for (const have of haves) {
    if (wantedAncestors.has(have) && repo.objects.has(have)) return [`ACK ${have}\n`, 'ready\n'];
  }
  return ['NAK\n'];
}

function handleFetchV2(repo: Repo, args: FetchArgs): Buffer {
  const selection = selectFetchObjects(repo, args.wants, args.haves, args.shallow, args.depth);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  const acks = ackLines(repo, args.wants, args.haves);
  parts.push(encodePktLines(['acknowledgments\n', ...acks, 'delim']));
  if (selection.shallow.length || selection.unshallow.length) {
    const lines = ['shallow-info\n'];
    for (const oid of selection.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of selection.unshallow) lines.push(`unshallow ${oid}\n`);
    parts.push(encodePktLines([...lines, 'delim']));
  }
  const refs = wantedRefs(repo, args.wants);
  if (refs.length) {
    const lines = ['wanted-refs\n'];
    for (const ref of refs) lines.push(`${ref.oid} ${ref.ref}\n`);
    parts.push(encodePktLines([...lines, 'delim']));
  }
  parts.push(encodePktLine('packfile\n'));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// upload-pack v0: fetch
// ---------------------------------------------------------------------------------------------

function handleFetchV0(repo: Repo, args: FetchArgs): Buffer {
  const selection = selectFetchObjects(repo, args.wants, args.haves, args.shallow, args.depth);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  const lines = ackLines(repo, args.wants, args.haves);
  for (const oid of selection.shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of selection.unshallow) lines.push(`unshallow ${oid}\n`);
  parts.push(encodePktLines(lines));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// upload-pack POST
// ---------------------------------------------------------------------------------------------

function parseV2Command(lines: string[]): { command: string; args: string[] } {
  const commandLine = lines[0] ?? '';
  const match = /^command=([a-z-]+)\n?$/.exec(commandLine.trim());
  if (!match) throw new Error(`bad v2 command line ${JSON.stringify(commandLine.slice(0, 40))}`);
  return { command: match[1], args: lines.slice(1) };
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(repo: Repo | undefined, body: Buffer, wantsV2: boolean): GitRouteResult {
  const contentType = 'application/x-git-upload-pack-result';
  if (!repo) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
  }
  try {
    const packets = decodePktLines(body);
    const lines = packets.filter((p) => p.kind === 'data').map((p) => (p.kind === 'data' ? p.payload.toString('utf8') : ''));
    if (wantsV2) {
      const { command, args } = parseV2Command(lines);
      const argLines: string[] = [];
      let seenDelim = false;
      for (const packet of packets) {
        if (packet.kind === 'delim') {
          seenDelim = true;
          continue;
        }
        if (packet.kind === 'data' && seenDelim) argLines.push(packet.payload.toString('utf8'));
      }
      if (command === 'ls-refs') {
        const lsArgs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
        for (const line of argLines) {
          const text = line.replace(/\n$/, '');
          if (text === 'peel') lsArgs.peel = true;
          else if (text === 'symrefs') lsArgs.symrefs = true;
          else if (text === 'unborn') lsArgs.unborn = true;
          else if (text.startsWith('ref-prefix ')) lsArgs.prefixes.push(text.slice('ref-prefix '.length));
        }
        return { status: 200, contentType, body: handleLsRefs(repo, lsArgs) };
      }
      if (command === 'fetch') {
        const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [], done: false };
        for (const line of argLines) {
          const text = line.replace(/\n$/, '');
          if (text.startsWith('want ')) fetchArgs.wants.push(text.slice(5).trim());
          else if (text.startsWith('have ')) fetchArgs.haves.push(text.slice(5).trim());
          else if (text.startsWith('shallow ')) fetchArgs.shallow.push(text.slice(8).trim());
          else if (text.startsWith('deepen ')) fetchArgs.depth = Number.parseInt(text.slice(7), 10);
          else if (text === 'done') fetchArgs.done = true;
        }
        if (!fetchArgs.wants.length) return { status: 200, contentType, body: Buffer.from('0000', 'ascii') };
        return { status: 200, contentType, body: handleFetchV2(repo, fetchArgs) };
      }
      return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: `unknown command ${command}` }), 'utf8') };
    }
    // v0: want lines (caps on the first), shallow/deepen lines, flush, have lines, done, flush.
    const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [], done: false };
    let section = 0;
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        section += 1;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8').replace(/\n$/, '');
      if (section === 0) {
        if (text.startsWith('want ')) {
          const rest = text.slice(5);
          const nul = rest.indexOf('\u0000');
          fetchArgs.wants.push((nul >= 0 ? rest.slice(0, nul) : rest).trim());
        } else if (text.startsWith('shallow ')) fetchArgs.shallow.push(text.slice(8).trim());
        else if (text.startsWith('deepen ')) fetchArgs.depth = Number.parseInt(text.slice(7), 10);
      } else {
        if (text.startsWith('have ')) fetchArgs.haves.push(text.slice(5).trim());
        else if (text === 'done') fetchArgs.done = true;
      }
    }
    if (!fetchArgs.wants.length) return { status: 200, contentType, body: Buffer.from('0000', 'ascii') };
    return { status: 200, contentType, body: handleFetchV0(repo, fetchArgs) };
  } catch (err) {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: (err as Error).message }), 'utf8') };
  }
}

// ---------------------------------------------------------------------------------------------
// receive-pack POST
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePack(store: ForgeStore, repo: Repo | undefined, body: Buffer): GitRouteResult {
  const contentType = 'application/x-git-receive-pack-result';
  if (!repo) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
  }
  try {
    // The command list is pkt-lined up to the first flush; the pack follows it raw.
    const flushIndex = findFlush(body);
    if (flushIndex < 0) throw new Error('receive-pack body has no command flush');
    const commandBytes = body.subarray(0, flushIndex);
    const packBytes = body.subarray(flushIndex + 4);
    const packets = decodePktLines(commandBytes);
    const commands: PushCommand[] = [];
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = text.indexOf('\u0000');
      const clean = nul >= 0 ? text.slice(0, nul) : text;
      const parts = clean.split(' ');
      if (parts.length !== 3 || !isObjectId(parts[0]) || !isObjectId(parts[1]) || !parts[2].startsWith('refs/')) {
        throw new Error(`bad push command ${JSON.stringify(clean.slice(0, 60))}`);
      }
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
    if (!commands.length) throw new Error('push needs at least one command');
    const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
    const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
    if (updatesRef) {
      if (packBytes.length === 0) throw new Error('push with updates carries no pack');
      if (!verifyPackChecksum(packBytes)) throw new Error('pack trailer does not match its bytes');
      const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    }
    const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === ZERO_OID) {
          results.push({ ref: command.ref, ok: false, reason: 'reference does not exist' });
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.refs.delete(command.ref);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (current === ZERO_OID) {
        if (command.oldOid !== ZERO_OID) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      if (command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (command.newOid === current) {
        results.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      // Fast-forward only: the new tip must descend from the old one.
      if (!isAncestor(current, command.newOid, lookup)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
    repo.pushedAt = store.nowIso();
    const lines = ['unpack ok\n'];
    for (const result of results) {
      lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
    }
    const report = encodePktLines(lines);
    const band = encodePktLine(Buffer.concat([Buffer.from([1]), report]));
    return { status: 200, contentType, body: Buffer.concat([band, Buffer.from('0000', 'ascii')]) };
  } catch (err) {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: (err as Error).message }), 'utf8') };
  }
}

/** The byte offset of the first flush packet in a pkt-line stream, or -1. */
function findFlush(body: Buffer): number {
  let offset = 0;
  while (offset + 4 <= body.length) {
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return -1;
    const length = Number.parseInt(head, 16);
    if (length === 0) return offset;
    if (length < 4 || length > 65520 || offset + length > body.length) return -1;
    offset += length;
  }
  return -1;
}
