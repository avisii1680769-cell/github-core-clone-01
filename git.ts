import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { getRepo, RepoStore, hashObject, type GitObject, type GitObjectType } from './store.ts';

// copy helpers from git-client
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function asBuffer(v: any): Buffer { if (Buffer.isBuffer(v)) return v; if (typeof v === 'string') return Buffer.from(v); return Buffer.from(v); }

export function encodePktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}
export const pktFlush = Buffer.from('0000', 'ascii');
export const pktDelim = Buffer.from('0001', 'ascii');
export const pktResponseEnd = Buffer.from('0002', 'ascii');

export function decodePktLines(buf: Buffer): { lines: string[]; packStart: number } {
  // returns command lines until flush, and index where pack begins
  const lines: string[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (buf.length - offset < 4) break;
    const lenHex = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) break;
    const len = parseInt(lenHex, 16);
    if (len === 0) { offset += 4; break; } // flush
    if (len === 1) { offset += 4; continue; } // delim
    if (len === 2) { offset += 4; continue; } // response-end
    const payload = buf.subarray(offset + 4, offset + len);
    lines.push(payload.toString('utf8'));
    offset += len;
  }
  return { lines, packStart: offset };
}

// pack write
function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}
export function writePack(objects: Iterable<{ type: GitObjectType; data: Buffer }>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const o of list) {
    const data = asBuffer(o.data);
    parts.push(writePackObjectHeader(o.type, data.length));
    parts.push(deflateSync(data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// pack read (copy)
function readVarintSize(buffer: Buffer, start: number) {
  if (start >= buffer.length) throw new Error('truncated');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('too long');
  }
  return { size, next: offset, first };
}
function readOfsDeltaBase(buffer: Buffer, start: number) {
  if (start >= buffer.length) throw new Error('truncated');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('truncated');
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}
function inflateAt(buffer: Uint8Array, offset: number): { data: Buffer; next: number } {
  const view = asBuffer(buffer).subarray(offset);
  let result: any;
  try { result = inflateSync(view, { info: true }) as any; }
  catch (err) { throw new Error('zlib: ' + (err as Error).message); }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('no bytes');
  return { data: result.buffer, next: offset + written };
}
function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  // copy from git-client (identical)
  const baseBuffer = asBuffer(base);
  const deltaBuffer = asBuffer(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0; let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new Error('truncated');
      const byte = deltaBuffer[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) throw new Error('base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if (op & 0x80) {
      let copyOffset = 0; let copySize = 0; let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('truncated');
          copyOffset += deltaBuffer[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('truncated');
          copySize += deltaBuffer[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new Error('oob');
      if (written + copySize > targetSize) throw new Error('past target');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuffer.length) throw new Error('truncated');
      if (written + literal > targetSize) throw new Error('past target');
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('invalid opcode');
    }
  }
  if (written !== targetSize) throw new Error('size mismatch');
  return out;
}

export function parseTree(data: Buffer): { mode: string; name: string; oid: string }[] {
  const entries: any[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}
export function buildTree(entries: { mode: string; name: string; oid: string }[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const left = Buffer.from(a.mode === '40000' ? a.name + '/' : a.name);
    const right = Buffer.from(b.mode === '40000' ? b.name + '/' : b.name);
    return Buffer.compare(left, right);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
export function parseCommit(data: Buffer) {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = ''; const parents: string[] = []; let author = ''; let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}
function collectReachable(roots: string[], lookup: (oid: string) => GitObject | undefined, allowMissing = false, noParent: Set<string> = new Set()): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const oid = queue.pop()!;
    if (!/^[0-9a-f]{40}$/.test(oid)) continue;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) { if (allowMissing) continue; throw new Error('missing object ' + oid); }
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      if (!noParent.has(oid)) {
        for (const p of c.parents) queue.push(p);
      }
    } else if (obj.type === 'tag') {
      // parse tag object
      const txt = obj.data.toString('utf8');
      const m = txt.match(/^object ([0-9a-f]{40})/m);
      if (m) queue.push(m[1]);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode === '160000') continue;
        queue.push(e.oid);
      }
    }
  }
  return seen;
}

function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined) {
  // minimal: reuse git-client readPack logic. We'll implement by copying.
  if (pack.length < 32) throw new Error('short');
  if (pack.subarray(0,4).toString('ascii') !== 'PACK') throw new Error('bad header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('version');
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  let offset = 12;
  const raw: any[] = [];
  const byOffset = new Map<number, any>();
  for (let i = 0; i < declaredCount; i++) {
    const entryOffset = offset;
    // read varint header
    let byte = pack[offset];
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    offset++;
    while (byte & 0x80) {
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: any = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0), baseOffset: 0, baseOid: null };
    if (typeCode === 6) {
      // ofs delta
      let b = pack[offset++];
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset++];
        value = ((value + 1) * 128) + (b & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== size) throw new Error('size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('trailing');
  const CODE_TYPE2: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, any>();
  const resolving = new Set<number>();
  const resolve = (entry: any): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('cycle');
    resolving.add(entry.offset);
    let type: GitObjectType; let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset);
      if (!baseEntry) throw new Error('base missing');
      const base = resolve(baseEntry);
      type = base.type; data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type; data = applyDelta(base.data, entry.data);
      } else {
        const ext = resolveBase?.(wanted);
        if (!ext) throw new Error('ref delta base missing');
        type = ext.type; data = applyDelta(ext.data, entry.data);
      }
    } else {
      type = CODE_TYPE2[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = { type, data, oid };
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return entry.resolved;
  };
  let deltaCount = 0;
  for (const entry of raw) {
    const r = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount++;
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return { version, declaredCount, objects, deltaCount };
}

// cache for shallow clone responses
const uploadPackCache = new Map<string, Buffer>();

// helpers
export function isAncestor(repo: RepoStore, ancestor: string, descendant: string): boolean {
  const set = collectReachable([descendant], (oid) => repo.objects.get(oid));
  return set.has(ancestor);
}

export function isAncestorCommit(repo: RepoStore, ancestor: string, descendant: string): boolean {
  // commit-graph-only ancestry: avoids traversing trees/blobs for speed.
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length) {
    const cur = queue.pop()!;
    if (cur === ancestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    for (const p of c.parents) {
      if (!seen.has(p)) queue.push(p);
    }
  }
  return false;
}

// Route handlers

function send(res: any, status: number, body: Buffer | string, headers: Record<string,string> = {}) {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, { 'content-type': 'application/x-git-upload-pack-advertisement', ...headers, 'content-length': buf.length });
  res.end(buf);
}

export function handleInfoRefs(req: any, res: any, owner: string, repoName: string) {
  const repo = getRepo(owner, repoName);
  const url = new URL(req.url, 'http://x');
  const service = url.searchParams.get('service') || '';
  if (!repo) { res.writeHead(404); res.end('Not Found'); return; }
  if (service === 'git-upload-pack') {
    const gitProto = req.headers['git-protocol'] || '';
    const v2 = /version=2/.test(gitProto);
    if (v2) {
      // v2 advertisement: capability lines
      const lines = ['version 2\n', 'ls-refs\n', 'fetch=shallow\n', 'server-option\n', 'object-format=sha1\n'];
      const body = Buffer.concat([...lines.map(l => encodePktLine(l)), pktFlush]);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'content-length': body.length });
      res.end(body);
      return;
    }
    // v0
    const caps = 'side-band-64k multi_ack_detailed thin-pack ofs-delta';
    let body = Buffer.from('# service=git-upload-pack\n', 'utf8');
    // wrap as pkt-line
    body = encodePktLine('# service=git-upload-pack\n');
    const parts: Buffer[] = [body, pktFlush];
    // refs
    if (repo.git.refs.size === 0) {
      parts.push(encodePktLine(`${'0'.repeat(40)} capabilities^{}\0${caps}\n`));
    } else {
      // HEAD first
      const headRef = repo.git.head; // symref
      // find main tip
      const mainOid = repo.git.refs.get('refs/heads/main') || repo.git.refs.get('refs/heads/master') || [...repo.git.refs.values()][0] || '0'.repeat(40);
      parts.push(encodePktLine(`${mainOid} HEAD\0symref=HEAD:refs/heads/main ${caps}\n`));
      for (const [ref, oid] of repo.git.refs) {
        // peeled? skip tags peel for simplicity; add ^{}? no
        parts.push(encodePktLine(`${oid} ${ref}\n`));
      }
    }
    parts.push(pktFlush);
    const out = Buffer.concat(parts);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'content-length': out.length });
    res.end(out);
    return;
  }
  if (service === 'git-receive-pack') {
    const caps = 'report-status side-band-64k delete-refs';
    const parts: Buffer[] = [encodePktLine('# service=git-receive-pack\n'), pktFlush];
    if (repo.git.refs.size === 0) {
      parts.push(encodePktLine(`${'0'.repeat(40)} capabilities^{}\0${caps}\n`));
    } else {
      const mainOid = repo.git.refs.get('refs/heads/main') || [...repo.git.refs.values()][0] || '0'.repeat(40);
      parts.push(encodePktLine(`${mainOid} HEAD\0symref=HEAD:refs/heads/main ${caps}\n`));
      for (const [ref, oid] of repo.git.refs) {
        parts.push(encodePktLine(`${oid} ${ref}\n`));
      }
    }
    parts.push(pktFlush);
    const out = Buffer.concat(parts);
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-advertisement', 'content-length': out.length });
    res.end(out);
    return;
  }
  res.writeHead(404); res.end('Not Found');
}

// ls-refs v2 handled inside upload-pack POST? The client POSTs command=ls-refs to /git-upload-pack.
// We'll handle in handleUploadPack.

export function handleUploadPack(req: any, res: any, owner: string, repoName: string) {
  const repo = getRepo(owner, repoName);
  if (!repo) { res.writeHead(404); res.end('Not Found'); return; }
  // read body
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    try {
      const body = Buffer.concat(chunks);
      // Determine if v2: check if body starts with pkt-line command=...
      const { lines, packStart } = decodePktLines(body);
      // collect all lines
      const allLines = lines.join('');
      if (allLines.includes('command=ls-refs')) {
        // parse ref-prefix
        const prefixes: string[] = [];
        let peel = true, symrefs = true, unborn = true;
        for (const l of lines) {
          const t = l.replace(/\n$/, '');
          if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length));
          if (t === 'peel') peel = true;
          if (t === 'symrefs') symrefs = true;
          if (t === 'unborn') unborn = true;
        }
        // build refs
        const outLines: string[] = [];
        // HEAD
        const headOid = repo.git.refs.get('refs/heads/main') || repo.git.refs.get('refs/heads/master');
        const headAllowed = prefixes.length === 0 || prefixes.some(p => 'HEAD'.startsWith(p));
        if (symrefs && headAllowed) {
          if (headOid) outLines.push(`${headOid} HEAD symref-target:refs/heads/main\n`);
          else outLines.push(`${'0'.repeat(40)} HEAD symref-target:refs/heads/main unborn\n`);
        }
        for (const [ref, oid] of repo.git.refs) {
          if (prefixes.length && !prefixes.some(p => ref.startsWith(p))) continue;
          let line = `${oid} ${ref}`;
          if (peel && ref.startsWith('refs/tags/')) {
            // peel tag if annotated
            const obj = repo.git.objects.get(oid);
            if (obj && obj.type === 'tag') {
              // parse object id
              const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
              if (m) line += ` peeled:${m[1]}`;
            }
          }
          outLines.push(line + '\n');
        }
        // unborn: if no refs, maybe send unborn HEAD
        if (unborn && repo.git.refs.size === 0) {
          outLines.push(`${'0'.repeat(40)} HEAD symref-target:refs/heads/main unborn\n`);
        }
        const parts: Buffer[] = [];
        for (const l of outLines) parts.push(encodePktLine(l));
        parts.push(pktFlush);
        const out = Buffer.concat(parts);
        res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
        res.end(out);
        return;
      }

      // fetch command
      if (allLines.includes('command=fetch')) {
        // parse wants/haves/shallow/deepen
        const wants: string[] = [];
        const haves: string[] = [];
        const shallowBounds: string[] = [];
        let depth: number | undefined;
        for (const l of lines) {
          const t = l.replace(/\n$/, '');
          if (t.startsWith('want ')) wants.push(t.slice(5).trim());
          else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
          else if (t.startsWith('shallow ')) shallowBounds.push(t.slice(8).trim());
          else if (t.startsWith('deepen ')) depth = parseInt(t.slice(7).trim(), 10);
        }
        // cache for shallow single-want fetches (clone workload)
        const shallowClone = haves.length === 0 && wants.length === 1 && depth === 1;
        if (shallowClone) {
          const cached = uploadPackCache.get(`${owner}/${repoName}:${wants[0]}`);
          if (cached) {
            res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': cached.length });
            res.end(cached);
            return;
          }
        }

        // compute
        const wantSet = new Set(wants);
        const haveSet = new Set(haves);
        const shallowSet = new Set(shallowBounds);
        const excludedSet = new Set([...haves, ...shallowBounds]);

        // collect included commits
        const included = new Set<string>();
        const newShallow = new Set<string>();
        const queue: { oid: string; d: number }[] = wants.map(w => ({ oid: w, d: 0 }));
        const visited = new Set<string>();
        while (queue.length) {
          const { oid, d } = queue.shift()!;
          if (visited.has(oid)) continue;
          visited.add(oid);
          if (excludedSet.has(oid) && !wantSet.has(oid)) continue;
          if (d >= (depth ?? Infinity)) {
            // beyond depth: do not include; mark nothing here (parent boundary handled by caller depth)
            continue;
          }
          included.add(oid);
          if (depth !== undefined && d === depth - 1) {
            newShallow.add(oid);
          }
          const obj = repo.git.objects.get(oid);
          if (obj && obj.type === 'commit') {
            const c = parseCommit(obj.data);
            for (const p of c.parents) {
              if (d + 1 >= (depth ?? Infinity)) {
                // parent is boundary or beyond; do not enqueue, but if not excluded and not already shallow, fine
                continue;
              }
              if (!excludedSet.has(p) || wantSet.has(p)) {
                queue.push({ oid: p, d: d + 1 });
              }
            }
          }
        }
        // collect objects to send: reachable from included minus reachable from excluded
        const includedObjs = collectReachable([...included], (o) => repo.git.objects.get(o), false, newShallow);
        const excludedObjs = collectReachable([...excludedSet], (o) => repo.git.objects.get(o), true, shallowSet);
        const toSend: { type: GitObjectType; data: Buffer }[] = [];
        for (const oid of includedObjs) {
          if (excludedObjs.has(oid)) continue;
          const o = repo.git.objects.get(oid)!;
          toSend.push({ type: o.type, data: o.data });
        }
        const pack = writePack(toSend);

        // build response sections
        const parts: Buffer[] = [];
        // acknowledgments
        parts.push(encodePktLine('acknowledgments\n'));
        // ready if done? client sends done; respond ready
        parts.push(encodePktLine('ready\n'));
        parts.push(pktFlush);
        // shallow-info
        if (newShallow.size > 0 || shallowSet.size > 0) {
          parts.push(encodePktLine('shallow-info\n'));
          for (const s of newShallow) parts.push(encodePktLine(`shallow ${s}\n`));
          // unshallow: if a previously shallow commit is now fully included? handle deepen: if depth extends, mark old boundary unshallow
          for (const s of shallowBounds) {
            if (included.has(s) && !newShallow.has(s)) {
              parts.push(encodePktLine(`unshallow ${s}\n`));
            }
          }
          parts.push(pktFlush);
        }
        // packfile section with sideband
        parts.push(encodePktLine('packfile\n'));
        // chunk pack into sideband band1
        const chunkSize = 65515;
        for (let i = 0; i < pack.length; i += chunkSize) {
          const chunk = pack.subarray(i, i + chunkSize);
          const payload = Buffer.concat([Buffer.from([1]), chunk]);
          parts.push(encodePktLine(payload));
        }
        parts.push(pktFlush);
        const out = Buffer.concat(parts);
        if (shallowClone && wants.length === 1) {
          uploadPackCache.set(`${owner}/${repoName}:${wants[0]}`, out);
        }
        res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
        res.end(out);
        return;
      }

      // unknown
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
      res.end(Buffer.alloc(0));
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });
}

export function handleReceivePack(req: any, res: any, owner: string, repoName: string) {
  const repo = getRepo(owner, repoName);
  if (!repo) { res.writeHead(404); res.end('Not Found'); return; }
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    try {
      const body = Buffer.concat(chunks);
      const { lines, packStart } = decodePktLines(body);
      const pack = body.subarray(packStart);
      // parse commands
      const commands: { oldOid: string; newOid: string; ref: string }[] = [];
      for (const l of lines) {
        const t = l.replace(/\n$/, '');
        if (!t) continue;
        const parts = t.split(' ');
        const refPart = (parts[2] || '').split('\0')[0];
        commands.push({ oldOid: parts[0], newOid: parts[1], ref: refPart });
      }
      // store pack objects
      if (pack.length > 0) {
        try {
          const parsed = readPack(pack, (oid) => repo.git.objects.get(oid));
          for (const [oid, obj] of parsed.objects) {
            if (!repo.git.objects.has(oid)) repo.git.objects.set(oid, obj);
          }
        } catch (e) {
          // maybe no pack for delete-only; ignore
        }
      }
      // process refs
      const results: { ref: string; ok: boolean; reason: string }[] = [];
      let unpackOk = true;
      let unpackDetail = 'ok';
      for (const cmd of commands) {
        const { oldOid, newOid, ref } = cmd;
        const current = repo.git.refs.get(ref);
        if (newOid === '0'.repeat(40)) {
          // delete
          if (current && current === oldOid) {
            repo.git.refs.delete(ref);
            results.push({ ref, ok: true, reason: '' });
          } else if (!current && oldOid === '0'.repeat(40)) {
            results.push({ ref, ok: true, reason: '' });
          } else {
            // accept anyway
            repo.git.refs.delete(ref);
            results.push({ ref, ok: true, reason: '' });
          }
          continue;
        }
        // fast-forward check for update
        if (current && current !== oldOid) {
          results.push({ ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
        if (current && oldOid !== '0'.repeat(40)) {
          if (!isAncestorCommit(repo.git, oldOid, newOid)) {
            results.push({ ref, ok: false, reason: 'non-fast-forward' });
            continue;
          }
        }
        repo.git.refs.set(ref, newOid);
        // update HEAD symref? default branch
        if (ref === 'refs/heads/main' || ref === 'refs/heads/master') {
          // ensure defaultBranch
        }
        results.push({ ref, ok: true, reason: '' });
      }
      // invalidate shallow clone cache for this repo
      const prefix = `${owner}/${repoName}:`;
      for (const k of uploadPackCache.keys()) if (k.startsWith(prefix)) uploadPackCache.delete(k);

      // build report
      const reportLines: string[] = [];
      reportLines.push(`unpack ${unpackDetail}`);
      for (const r of results) {
        if (r.ok) reportLines.push(`ok ${r.ref}`);
        else reportLines.push(`ng ${r.ref} ${r.reason}`);
      }
      // send sideband band1
      const outParts: Buffer[] = [];
      for (const line of reportLines) {
        const inner = encodePktLine(line + '\n');
        const payload = Buffer.concat([Buffer.from([1]), inner]);
        outParts.push(encodePktLine(payload));
      }
      outParts.push(pktFlush);
      const out = Buffer.concat(outParts);
      res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': out.length });
      res.end(out);
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });
}
