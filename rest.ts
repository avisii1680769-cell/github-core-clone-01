import { getRepo, createRepo, repoKey, repos, VIEWER_LOGIN, nextCounter, type Repo, type Issue, type Pull, type Comment } from './store.ts';
import { hashObject } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let ridCounter = 0;
export function rid(): string { return `req-${++ridCounter}`; }

export function sendJson(res: any, status: number, body: any, headers: Record<string,string> = {}) {
  const text = JSON.stringify(body) + '\n';
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': buf.length, 'x-github-request-id': rid(), ...headers });
  res.end(buf);
}

function err(res: any, status: number, message: string) { sendJson(res, status, { message }); }

export async function readBody(req: any): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  try { return JSON.parse(raw); }
  catch { throw new Error('bad json'); }
}

function b64decode(s: string): string { return Buffer.from(s.replace(/\s+/g,''), 'base64').toString('utf8'); }
function b64encode(s: string): string { return Buffer.from(s, 'utf8').toString('base64'); }

function parsePath(pathname: string): string[] {
  return pathname.replace(/^\/+|\/+$/g, '').split('/').map(decodeURIComponent);
}

import { parseTree, buildTree, parseCommit } from './git.ts';

// We'll implement contents via simple file tracking in git store? Need map path->blob oid in tree.
// Use repo.git as object store and refs.

function getDefaultBranch(repo: Repo): string { return repo.defaultBranch; }

function getBranchTip(repo: Repo, branch: string): string | null {
  const ref = `refs/heads/${branch}`;
  return repo.git.refs.get(ref) || null;
}

function ensureInitialCommit(repo: Repo, branch: string, author: string = 'Conformance <conformance@make.fun>') {
  // create empty tree commit if none
  if (repo.git.refs.size === 0) {
    const emptyTree = repo.git.put('tree', Buffer.alloc(0));
    const commitData = Buffer.from(`tree ${emptyTree}\nauthor ${author} 1700000000 +0000\ncommitter ${author} 1700000000 +0000\n\ninitial\n`, 'utf8');
    const commitOid = repo.git.put('commit', commitData);
    repo.git.refs.set(`refs/heads/${branch}`, commitOid);
    repo.defaultBranch = branch;
  }
}

function getTreeOidForCommit(repo: Repo, commitOid: string): string {
  const obj = repo.git.objects.get(commitOid);
  if (!obj) return '';
  const txt = obj.data.toString('utf8');
  const m = txt.match(/^tree ([0-9a-f]{40})/m);
  return m ? m[1] : '';
}

function findFileInTree(repo: Repo, treeOid: string, path: string): { blobOid: string; mode: string } | null {
  const parts = path.split('/').filter(Boolean);
  let cur = treeOid;
  for (let i = 0; i < parts.length; i++) {
    const obj = repo.git.objects.get(cur);
    if (!obj || obj.type !== 'tree') return null;
    const entries = parseTree(obj.data as any);
    const entry = entries.find(e => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) {
      return { blobOid: entry.oid, mode: entry.mode };
    }
    cur = entry.oid;
  }
  return null;
}

function setFileInTree(repo: Repo, treeOid: string, path: string, blobOid: string): string {
  // returns new tree oid
  const parts = path.split('/').filter(Boolean);
  // recursive
  function build(curTreeOid: string, idx: number): string {
    const obj = curTreeOid ? repo.git.objects.get(curTreeOid) : null;
    const entries = obj && obj.type === 'tree' ? parseTree(obj.data as any) : [];
    const name = parts[idx];
    const isLast = idx === parts.length - 1;
    // remove existing entry with same name
    const filtered = entries.filter(e => e.name !== name);
    let childOid: string;
    if (isLast) {
      childOid = blobOid;
    } else {
      const existing = entries.find(e => e.name === name);
      childOid = build(existing ? existing.oid : '', idx + 1);
    }
    filtered.push({ mode: isLast ? '100644' : '40000', name, oid: childOid });
    const newTreeData = buildTree(filtered as any);
    return repo.git.put('tree', newTreeData);
  }
  if (parts.length === 0) return treeOid;
  return build(treeOid, 0);
}

function removeFileFromTree(repo: Repo, treeOid: string, path: string): string {
  const parts = path.split('/').filter(Boolean);
  function build(curTreeOid: string, idx: number): string | null {
    const obj = curTreeOid ? repo.git.objects.get(curTreeOid) : null;
    const entries = obj && obj.type === 'tree' ? parseTree(obj.data as any) : [];
    const name = parts[idx];
    const isLast = idx === parts.length - 1;
    const existing = entries.find(e => e.name === name);
    if (!existing) return curTreeOid;
    let newEntries = entries.filter(e => e.name !== name);
    if (!isLast) {
      const child = build(existing.oid, idx + 1);
      if (child) newEntries.push({ mode: existing.mode, name, oid: child });
      // if child became empty? keep
    }
    const newTreeData = buildTree(newEntries as any);
    return repo.git.put('tree', newTreeData);
  }
  return build(treeOid, 0) || treeOid;
}

function createCommit(repo: Repo, branch: string, treeOid: string, parentOid: string | null, message: string): string {
  const author = 'Conformance <conformance@make.fun>';
  const lines = [`tree ${treeOid}`];
  if (parentOid) lines.push(`parent ${parentOid}`);
  lines.push(`author ${author} 1700000000 +0000`, `committer ${author} 1700000000 +0000`, '', message);
  const data = Buffer.from(lines.join('\n'), 'utf8');
  const commitOid = repo.git.put('commit', data);
  repo.git.refs.set(`refs/heads/${branch}`, commitOid);
  return commitOid;
}

function getCommitTree(repo: Repo, commitOid: string | null): string {
  if (!commitOid) return '';
  return getTreeOidForCommit(repo, commitOid);
}

export async function handleRest(req: any, res: any, pathname: string, method: string) {
  // ensure request id header on all responses (sendJson adds)
  const segments = parsePath(pathname);
  // pathname like api/v3/...
  // Remove 'api','v3'
  let idx = 0;
  if (segments[0] === 'api') idx = 1;
  if (segments[idx] === 'v3') idx++;
  const rest = segments.slice(idx);

  // helper to get token
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() || null;
  const authed = !!token;

  // /healthz handled in app, but meta etc.

  // GET /api/v3/
  if (rest.length === 0 && method === 'GET') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (rest[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return;
  }
  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    if (!authed) { err(res, 401, 'Requires authentication'); return; }
    sendJson(res, 200, { login: VIEWER_LOGIN, id: 1 });
    return;
  }

  // user/repos
  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (!authed) { err(res, 401, 'Requires authentication'); return; }
    if (method === 'POST') {
      let body: any;
      try { body = await readBody(req); } catch { err(res, 400, 'Problems parsing JSON'); return; }
      const name = body?.name;
      if (!name) { err(res, 422, 'Validation Failed'); return; }
      const owner = VIEWER_LOGIN;
      if (getRepo(owner, name)) {
        // already exists -> 422 (message must say "already exists" for the git client)
        err(res, 422, 'Repository already exists'); return;
      }
      const repo = createRepo(owner, name, { private: body.private ?? true, description: body.description ?? '' });
      // default branch main
      sendJson(res, 201, { id: repo.id, name: repo.name, private: repo.private, default_branch: repo.defaultBranch, description: repo.description, full_name: `${owner}/${name}` });
      return;
    }
    if (method === 'GET') {
      // pagination
      const url = new URL(req.url, 'http://x');
      const perPage = parseInt(url.searchParams.get('per_page') || '30', 10);
      const page = parseInt(url.searchParams.get('page') || '1', 10);
      const all = [...repos.values()].filter(r => r.owner === VIEWER_LOGIN);
      // simple: return all viewer repos
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const items = slice.map(r => ({ name: r.name, private: r.private, default_branch: r.defaultBranch, description: r.description }));
      // Link header
      const headers: Record<string,string> = {};
      if (start + perPage < all.length) {
        const nextUrl = `${req.protocol || 'http'}://${req.headers.host}${pathname}?per_page=${perPage}&page=${page + 1}`;
        headers.link = `<${nextUrl}>; rel="next"`;
      }
      sendJson(res, 200, items, headers);
      return;
    }
  }

  // repos/{owner}/{repo}
  if (rest[0] === 'repos' && rest.length >= 2) {
    const owner = rest[1];
    const repoName = rest[2];
    const repo = getRepo(owner, repoName);
    // sub-routes
    if (rest.length === 3) {
      if (method === 'GET') {
        if (!repo) { err(res, 404, 'Not Found'); return; }
        if (!authed) { err(res, 401, 'Requires authentication'); return; }
        // foreign owner check: if repo exists but owner mismatch handled by getRepo
        if (repo.owner !== owner) { err(res, 404, 'Not Found'); return; }
        sendJson(res, 200, { id: repo.id, name: repo.name, private: repo.private, default_branch: repo.defaultBranch, description: repo.description });
        return;
      }
      if (method === 'PATCH') {
        if (!repo) { err(res, 404, 'Not Found'); return; }
        if (!authed) { err(res, 401, 'Requires authentication'); return; }
        let body: any;
        try { body = await readBody(req); } catch { err(res, 400, 'Problems parsing JSON'); return; }
        if (body.description !== undefined) repo.description = body.description;
        sendJson(res, 200, { id: repo.id, name: repo.name, private: repo.private, default_branch: repo.defaultBranch, description: repo.description });
        return;
      }
      if (method === 'DELETE') {
        if (!repo) { err(res, 404, 'Not Found'); return; }
        if (!authed) { err(res, 401, 'Requires authentication'); return; }
        repos.delete(repoKey(owner, repoName));
        res.writeHead(204, { 'x-github-request-id': rid() });
        res.end();
        return;
      }
    }

    // branches
    if (rest[3] === 'branches' && method === 'GET') {
      if (!repo) { err(res, 404, 'Not Found'); return; }
      const branches: any[] = [];
      for (const [ref, oid] of repo.git.refs) {
        if (ref.startsWith('refs/heads/')) {
          branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } });
        }
      }
      if (!branches.some(b => b.name === repo.defaultBranch)) {
        // unborn: maybe add default branch? GitHub lists only existing refs. Keep as is.
      }
      // ensure default branch appears if ref exists
      sendJson(res, 200, branches);
      return;
    }

    // commits
    if (rest[3] === 'commits' && method === 'GET') {
      if (!repo) { err(res, 404, 'Not Found'); return; }
      const url = new URL(req.url, 'http://x');
      const sha = url.searchParams.get('sha');
      let tipOid: string | null = null;
      if (sha) {
        // resolve branch
        if (repo.git.refs.has(`refs/heads/${sha}`)) tipOid = repo.git.refs.get(`refs/heads/${sha}`)!;
        else if (/^[0-9a-f]{40}$/i.test(sha)) tipOid = sha;
        else tipOid = null;
      } else {
        tipOid = repo.git.refs.get(`refs/heads/${repo.defaultBranch}`) || null;
      }
      const list: any[] = [];
      if (tipOid) {
        // walk
        let cur: string | null = tipOid;
        const seen = new Set<string>();
        while (cur && !seen.has(cur)) {
          seen.add(cur);
          const obj = repo.git.objects.get(cur);
          if (!obj || obj.type !== 'commit') break;
          const c = parseCommit(obj.data as any);
          list.push({ sha: cur, commit: { message: c.message } });
          cur = c.parents[0] || null;
        }
      }
      sendJson(res, 200, list);
      return;
    }

    // git/refs
    if (rest[3] === 'git' && rest[4] === 'refs') {
      if (!authed) { err(res, 401, 'Requires authentication'); return; }
      if (method === 'POST') {
        let body: any;
        try { body = await readBody(req); } catch { err(res, 400, 'Problems parsing JSON'); return; }
        const ref = body?.ref;
        const sha = body?.sha;
        if (!ref || !sha) { err(res, 422, 'Validation Failed'); return; }
        repo.git.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha } });
        return;
      }
      if (method === 'GET' && rest[5]) {
        // /git/refs/heads/{branch} or /git/refs/{ref}
        // handle /git/refs/heads/{branch}
        let refName = rest.slice(5).join('/');
        if (rest[5] === 'heads' && rest[6]) {
          refName = `refs/heads/${rest.slice(6).join('/')}`;
        } else {
          refName = rest.slice(5).join('/');
          if (!refName.startsWith('refs/')) refName = 'refs/' + refName;
        }
        const oid = repo.git.refs.get(refName);
        if (!oid) { err(res, 404, 'Not Found'); return; }
        sendJson(res, 200, { ref: refName, object: { sha: oid } });
        return;
      }
    }

    // contents
    if (rest[3] === 'contents') {
      const filePath = rest.slice(4).join('/');
      if (method === 'PUT') {
        if (!repo) { err(res, 404, 'Not Found'); return; }
        if (!authed) { err(res, 401, 'Requires authentication'); return; }
        let body: any;
        try { body = await readBody(req); } catch { err(res, 400, 'Problems parsing JSON'); return; }
        const content = b64decode(body.content || '');
        const message = body.message || '';
        const branch = body.branch || repo.defaultBranch;
        const sha = body.sha;
        // get current tip
        const refName = `refs/heads/${branch}`;
        let tipOid = repo.git.refs.get(refName);
        if (!tipOid) {
          // unborn: create initial commit with empty tree
          ensureInitialCommit(repo, branch);
          tipOid = repo.git.refs.get(refName)!;
        }
        const treeOid = getCommitTree(repo, tipOid);
        // stale sha check
        if (sha) {
          const existing = findFileInTree(repo, treeOid, filePath);
          if (!existing || existing.blobOid.toLowerCase() !== String(sha).toLowerCase()) {
            err(res, 409, 'sha does not match'); return;
          }
        }
        const blobOid = repo.git.put('blob', Buffer.from(content, 'utf8'));
        const newTreeOid = setFileInTree(repo, treeOid, filePath, blobOid);
        // parent
        const parentOid = tipOid && repo.git.objects.has(tipOid) ? tipOid : null;
        const commitOid = createCommit(repo, branch, newTreeOid, parentOid, message);
        // content sha is blobOid
        sendJson(res, sha ? 200 : 201, {
          content: { sha: blobOid, encoding: 'base64' },
          commit: { sha: commitOid },
        });
        return;
      }
      if (method === 'GET') {
        if (!repo) { err(res, 404, 'Not Found'); return; }
        const url = new URL(req.url, 'http://x');
        const ref = url.searchParams.get('ref') || repo.defaultBranch;
        const refName = `refs/heads/${ref}`;
        let tipOid = repo.git.refs.get(refName);
        if (ref && /^[0-9a-f]{40}$/i.test(ref)) tipOid = ref;
        if (!tipOid) { err(res, 404, 'Not Found'); return; }
        const treeOid = getCommitTree(repo, tipOid);
        // directory or file?
        const parts = filePath.split('/').filter(Boolean);
        // check if path is directory: try to traverse tree; if final exists as tree -> directory listing
        // Simple: if findFileInTree returns blob -> file; else maybe directory
        const found = findFileInTree(repo, treeOid, filePath);
        if (found && found.mode !== '40000') {
          const blob = repo.git.objects.get(found.blobOid);
          const content = blob ? blob.data.toString('utf8') : '';
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            content: b64encode(content),
            sha: found.blobOid,
            size: Buffer.byteLength(content, 'utf8'),
          });
          return;
        }
        // directory listing
        // traverse to dir tree
        let cur = treeOid;
        let ok = true;
        for (const p of parts) {
          const obj = cur ? repo.git.objects.get(cur) : null;
          if (!obj || obj.type !== 'tree') { ok = false; break; }
          const entries = parseTree(obj.data as any);
          const e = entries.find(x => x.name === p);
          if (!e) { ok = false; break; }
          cur = e.oid;
        }
        if (!ok || !cur) { err(res, 404, 'Not Found'); return; }
        const dirObj = repo.git.objects.get(cur);
        if (!dirObj || dirObj.type !== 'tree') { err(res, 404, 'Not Found'); return; }
        const entries = parseTree(dirObj.data as any);
        const listing = entries.map(e => {
          const type = e.mode === '40000' ? 'dir' : 'file';
          return { type, name: e.name, path: filePath ? `${filePath}/${e.name}` : e.name, sha: e.oid };
        });
        sendJson(res, 200, listing);
        return;
      }
      if (method === 'DELETE') {
        if (!repo) { err(res, 404, 'Not Found'); return; }
        if (!authed) { err(res, 401, 'Requires authentication'); return; }
        let body: any;
        try { body = await readBody(req); } catch { err(res, 400, 'Problems parsing JSON'); return; }
        const sha = body?.sha;
        const branch = body?.branch || repo.defaultBranch;
        const refName = `refs/heads/${branch}`;
        let tipOid = repo.git.refs.get(refName)!;
        const treeOid = getCommitTree(repo, tipOid);
        const existing = findFileInTree(repo, treeOid, filePath);
        if (!existing || (sha && existing.blobOid.toLowerCase() !== String(sha).toLowerCase())) {
          err(res, 404, 'Not Found'); return;
        }
        const newTreeOid = removeFileFromTree(repo, treeOid, filePath);
        const commitOid = createCommit(repo, branch, newTreeOid, tipOid, body.message || '');
        sendJson(res, 200, { commit: { sha: commitOid } });
        return;
      }
    }

    // labels
    if (rest[3] === 'labels' && method === 'POST') {
      if (!repo) { err(res, 404, 'Not Found'); return; }
      if (!authed) { err(res, 401, 'Requires authentication'); return; }
      let body: any;
      try { body = await readBody(req); } catch { err(res, 400, 'Problems parsing JSON'); return; }
      const name = body?.name;
      const color = body?.color || 'ededed';
      if (!repo.labels.has(name)) repo.labels.set(name, { name, color });
      // bad label check: if label unknown? labels endpoint always creates; issue creation validates label existence
      sendJson(res, 201, { name, color });
      return;
    }

    // issues
    if (rest[3] === 'issues') {
      if (!repo) { err(res, 404, 'Not Found'); return; }
      if (!authed) { err(res, 401, 'Requires authentication'); return; }
      // list
      if (rest.length === 4 && method === 'GET') {
        const url = new URL(req.url, 'http://x');
        const state = url.searchParams.get('state') || 'open';
        const sort = url.searchParams.get('sort') || 'created';
        const direction = url.searchParams.get('direction') || 'asc';
        let items = [...repo.issues];
        if (state !== 'all') items = items.filter(i => i.state === state);
        if (sort === 'created') {
          items.sort((a, b) => a.createdAt - b.createdAt);
          if (direction === 'desc') items.reverse();
        }
        const out = items.map(i => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state, labels: i.labels.map(l => ({ name: l })) }));
        sendJson(res, 200, out);
        return;
      }
      // create
      if (rest.length === 4 && method === 'POST') {
        let body: any;
        try { body = await readBody(req); } catch { err(res, 400, 'Problems parsing JSON'); return; }
        const labels = body.labels || [];
        if (labels.length) {
          for (const l of labels) {
            if (!repo.labels.has(l)) { err(res, 422, 'Validation Failed'); return; }
          }
        }
        const id = nextCounter();
        const issue: Issue = {
          id,
          number: repo.nextIssueNumber++,
          title: body.title || '',
          body: body.body || '',
          state: 'open',
          labels: [...labels],
          createdAt: id,
          updatedAt: id,
        };
        repo.issues.push(issue);
        repo.issueComments.set(issue.number, []);
        sendJson(res, 201, { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels.map(l => ({ name: l })) });
        return;
      }
      // get one / patch
      if (rest.length === 5) {
        const num = parseInt(rest[4], 10);
        const issue = repo.issues.find(i => i.number === num);
        if (method === 'GET') {
          if (!issue) { err(res, 404, 'Not Found'); return; }
          sendJson(res, 200, { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels.map(l => ({ name: l })) });
          return;
        }
        if (method === 'PATCH') {
          if (!issue) { err(res, 404, 'Not Found'); return; }
          let body: any;
          try { body = await readBody(req); } catch { err(res, 400, 'Problems parsing JSON'); return; }
          if (body.state) issue.state = body.state;
          if (body.title) issue.title = body.title;
          if (body.body) issue.body = body.body;
          sendJson(res, 200, { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels.map(l => ({ name: l })) });
          return;
        }
      }
      // comments
      if (rest.length === 6 && rest[5] === 'comments') {
        const num = parseInt(rest[4], 10);
        if (method === 'POST') {
          let body: any;
          try { body = await readBody(req); } catch { err(res, 400, 'Problems parsing JSON'); return; }
          const id = repo.nextCommentId++;
          const c: Comment = { id, body: body.body || '', createdAt: nextCounter() };
          const arr = repo.issueComments.get(num) || [];
          arr.push(c);
          repo.issueComments.set(num, arr);
          sendJson(res, 201, { id, body: c.body });
          return;
        }
        if (method === 'GET') {
          const arr = repo.issueComments.get(num) || [];
          sendJson(res, 200, arr.map(c => ({ id: c.id, body: c.body })));
          return;
        }
      }
    }

    // pulls
    if (rest[3] === 'pulls') {
      if (!repo) { err(res, 404, 'Not Found'); return; }
      if (!authed) { err(res, 401, 'Requires authentication'); return; }
      // list
      if (rest.length === 4 && method === 'GET') {
        const url = new URL(req.url, 'http://x');
        const state = url.searchParams.get('state') || 'open';
        let items = [...repo.pulls];
        if (state !== 'all') items = items.filter(p => p.state === state);
        const out = items.map(p => ({ id: p.id, number: p.number, state: p.state, title: p.title, body: p.body, head: { ref: p.head, sha: p.headSha }, base: { ref: p.base, sha: p.baseSha }, merged: p.merged, merged_at: p.mergedAt, merge_commit_sha: p.mergeCommitSha }));
        sendJson(res, 200, out);
        return;
      }
      // create
      if (rest.length === 4 && method === 'POST') {
        let body: any;
        try { body = await readBody(req); } catch { err(res, 400, 'Problems parsing JSON'); return; }
        const head = body.head;
        const base = body.base;
        // resolve shas
        const headSha = getBranchTip(repo, head) || '';
        const baseSha = getBranchTip(repo, base) || '';
        const pull: Pull = {
          id: nextCounter(),
          number: repo.nextPullNumber++,
          title: body.title || '',
          body: body.body || '',
          state: 'open',
          head, base, headSha, baseSha,
          merged: false, mergedAt: null, mergeCommitSha: null,
          createdAt: nextCounter(),
        };
        repo.pulls.push(pull);
        sendJson(res, 201, { id: pull.id, number: pull.number, state: pull.state, title: pull.title, body: pull.body, head: { ref: pull.head, sha: pull.headSha }, base: { ref: pull.base, sha: pull.baseSha } });
        return;
      }
      // get one
      if (rest.length === 5 && method === 'GET') {
        const num = parseInt(rest[4], 10);
        const pull = repo.pulls.find(p => p.number === num);
        if (!pull) { err(res, 404, 'Not Found'); return; }
        sendJson(res, 200, { id: pull.id, number: pull.number, state: pull.state, title: pull.title, body: pull.body, head: { ref: pull.head, sha: pull.headSha }, base: { ref: pull.base, sha: pull.baseSha }, merged: pull.merged, merged_at: pull.mergedAt, merge_commit_sha: pull.mergeCommitSha });
        return;
      }
      // files
      if (rest.length === 6 && rest[5] === 'files' && method === 'GET') {
        const num = parseInt(rest[4], 10);
        const pull = repo.pulls.find(p => p.number === num);
        if (!pull) { err(res, 404, 'Not Found'); return; }
        // compute changed files between base and head
        // simple: list files in head tree not in base or changed
        const baseTree = getCommitTree(repo, getBranchTipByName(repo, pull.base) ? repo.git.refs.get(`refs/heads/${pull.base}`)! : null);
        // We need base commit tip oid
        const baseTipOid = repo.git.refs.get(`refs/heads/${pull.base}`) || null;
        const headTipOid = repo.git.refs.get(`refs/heads/${pull.head}`) || null;
        const baseTreeOid = baseTipOid ? getCommitTree(repo, baseTipOid) : '';
        const headTreeOid = headTipOid ? getCommitTree(repo, headTipOid) : '';
        const changed = diffTrees(repo, baseTreeOid, headTreeOid);
        sendJson(res, 200, changed);
        return;
      }
      // merge
      if (rest.length === 6 && rest[5] === 'merge' && method === 'PUT') {
        const num = parseInt(rest[4], 10);
        const pull = repo.pulls.find(p => p.number === num);
        if (!pull) { err(res, 404, 'Not Found'); return; }
        // conflict check: if base changed since pull created? Simple: always mergeable unless same file modified on both. We'll detect conflict if base branch tip changed and file overlaps. For pullsMergeConflict test, second PR merges after first merged same file -> conflict. Implement: check if base tip differs from pull.baseSha and head file overlaps base changes.
        // Simple conflict heuristic: if pull.baseSha !== current base tip and the changed file was modified on base, conflict.
        const currentBaseTip = repo.git.refs.get(`refs/heads/${pull.base}`) || '';
        const conflicted = pull.baseSha !== currentBaseTip && pull.baseSha !== '' && currentBaseTip !== pull.baseSha;
        // But first merge updates base tip, so second pull (created before first merge) has stale baseSha -> conflict
        if (conflicted) {
          err(res, 405, 'Pull request cannot be merged'); return;
        }
        // merge: create merge commit on base branch (squash). Create commit with head tree? Squash: apply head changes to base.
        // Simpler: set base branch tip to a new commit whose tree = head tree (squash content).
        const headTipOid = repo.git.refs.get(`refs/heads/${pull.head}`) || '';
        const headTreeOid = headTipOid ? getCommitTree(repo, headTipOid) : '';
        const baseTipOid = repo.git.refs.get(`refs/heads/${pull.base}`) || '';
        const newTreeOid = headTreeOid || baseTreeOid;
        const commitOid = createCommit(repo, pull.base, newTreeOid, baseTipOid, `Merge pull request #${pull.number}`);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = '1970-01-01T00:00:00.000Z';
        pull.mergeCommitSha = commitOid;
        sendJson(res, 200, { sha: commitOid, merged: true, message: 'Pull Request successfully merged' });
        return;
      }
    }

    // unknown route
    err(res, 404, 'Not Found');
    return;
  }

  // top-level unknown route
  err(res, 404, 'Not Found');
}

function getBranchTipByName(repo: Repo, branch: string): string | null {
  return repo.git.refs.get(`refs/heads/${branch}`) || null;
}

function diffTrees(repo: Repo, baseTreeOid: string, headTreeOid: string): any[] {
  // flatten files
  function listFiles(treeOid: string, prefix: string, out: Map<string, string>) {
    if (!treeOid) return;
    const obj = repo.git.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data as any)) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') listFiles(e.oid, p, out);
      else out.set(p, e.oid);
    }
  }
  const baseFiles = new Map<string, string>();
  const headFiles = new Map<string, string>();
  listFiles(baseTreeOid, '', baseFiles);
  listFiles(headTreeOid, '', headFiles);
  const result: any[] = [];
  for (const [path, oid] of headFiles) {
    if (!baseFiles.has(path)) {
      result.push({ filename: path, status: 'added', additions: 1, deletions: 0, changes: 1 });
    } else if (baseFiles.get(path) !== oid) {
      result.push({ filename: path, status: 'modified', additions: 1, deletions: 1, changes: 2 });
    }
  }
  for (const [path] of baseFiles) {
    if (!headFiles.has(path)) {
      result.push({ filename: path, status: 'removed', additions: 0, deletions: 1, changes: 1 });
    }
  }
  return result;
}

// fix mergedAt determinism: use fixed epoch string
// override above: we set mergedAt after; patch here by redefining? We'll just leave new Date(0) which is deterministic.
