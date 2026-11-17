import { getRepo, createRepo, VIEWER_LOGIN, nextCounter } from './store.ts';
import { rid } from './rest.ts';

function sendJson(res: any, status: number, body: any) {
  const text = JSON.stringify(body) + '\n';
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'x-github-request-id': rid() });
  res.end(buf);
}

const TOOLS = [
  { name: 'create_repo', description: 'Create a repository', inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] } },
];

function getArg(args: any, ...names: string[]): any {
  if (!args) return undefined;
  for (const n of names) if (args[n] !== undefined) return args[n];
  return undefined;
}

function norm(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]/g, ''); }

function callTool(name: string, args: any): { content: any[]; isError: boolean } {
  const n = norm(name);
  try {
    if (n.endsWith('createrepo') || n === 'createrepo') {
      const rname = getArg(args, 'name', 'repo', 'repository', 'repository_name', 'repo_name');
      const desc = getArg(args, 'description', 'about', 'summary', 'body');
      const priv = getArg(args, 'private', 'is_private');
      const owner = VIEWER_LOGIN;
      const existing = getRepo(owner, rname);
      if (existing) return { content: [{ type: 'text', text: JSON.stringify({ name: rname, full_name: `${owner}/${rname}`, id: existing.id }) }], isError: false };
      const repo = createRepo(owner, rname, { private: priv ?? true, description: desc ?? '' });
      return { content: [{ type: 'text', text: JSON.stringify({ name: rname, full_name: `${owner}/${rname}`, id: repo.id }) }], isError: false };
    }
    if (n.endsWith('getrepo') || n === 'getrepo') {
      const owner = getArg(args, 'owner', 'owner_login', 'user', 'login') || VIEWER_LOGIN;
      const repo = getArg(args, 'repo', 'repository', 'repository_name', 'repo_name', 'name');
      const r = getRepo(owner, repo);
      if (!r) return { content: [{ type: 'text', text: 'not found' }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify({ name: r.name, owner }) }], isError: false };
    }
    if (n.endsWith('createissue') || n === 'createissue') {
      const owner = getArg(args, 'owner', 'owner_login', 'user', 'login') || VIEWER_LOGIN;
      const repoName = getArg(args, 'repo', 'repository', 'repository_name', 'repo_name');
      const title = getArg(args, 'title', 'issue_title', 'subject');
      const body = getArg(args, 'body', 'issue_body', 'description', 'content', 'text') || '';
      const r = getRepo(owner, repoName);
      if (!r) return { content: [{ type: 'text', text: 'repo not found' }], isError: true };
      const num = r.nextIssueNumber++;
      const issue = { id: nextCounter(), number: num, title, body, state: 'open' as const, labels: [], createdAt: nextCounter(), updatedAt: nextCounter() };
      r.issues.push(issue);
      r.issueComments.set(num, []);
      return { content: [{ type: 'text', text: JSON.stringify({ number: num, id: issue.id, title }) }], isError: false };
    }
    if (n.endsWith('listissues') || n === 'listissues') {
      const owner = getArg(args, 'owner', 'owner_login', 'user', 'login') || VIEWER_LOGIN;
      const repoName = getArg(args, 'repo', 'repository', 'repository_name', 'repo_name');
      const r = getRepo(owner, repoName);
      if (!r) return { content: [{ type: 'text', text: 'repo not found' }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(r.issues.map(i => ({ number: i.number, title: i.title }))) }], isError: false };
    }
    if (n.endsWith('createpullrequest') || n === 'createpullrequest' || n.endsWith('createpr')) {
      const owner = getArg(args, 'owner', 'owner_login', 'user', 'login') || VIEWER_LOGIN;
      const repoName = getArg(args, 'repo', 'repository', 'repository_name', 'repo_name');
      const title = getArg(args, 'title', 'pr_title', 'pull_request_title', 'subject');
      const head = getArg(args, 'head', 'head_ref', 'head_branch', 'source', 'source_branch', 'from', 'from_branch', 'branch');
      const base = getArg(args, 'base', 'base_ref', 'base_branch', 'target', 'target_branch', 'into', 'into_branch');
      const r = getRepo(owner, repoName);
      if (!r) return { content: [{ type: 'text', text: 'repo not found' }], isError: true };
      const headSha = r.git.refs.get(`refs/heads/${head}`) || '';
      const baseSha = r.git.refs.get(`refs/heads/${base}`) || '';
      const num = r.nextPullNumber++;
      r.pulls.push({ id: nextCounter(), number: num, title, body: '', state: 'open', head, base, headSha, baseSha, merged: false, mergedAt: null, mergeCommitSha: null, createdAt: nextCounter() });
      return { content: [{ type: 'text', text: JSON.stringify({ number: num, title, head, base }) }], isError: false };
    }
    if (n.endsWith('mergepullrequest') || n === 'mergepullrequest' || n.endsWith('mergepr')) {
      const owner = getArg(args, 'owner', 'owner_login', 'user', 'login') || VIEWER_LOGIN;
      const repoName = getArg(args, 'repo', 'repository', 'repository_name', 'repo_name');
      const num = getArg(args, 'pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index');
      const r = getRepo(owner, repoName);
      if (!r) return { content: [{ type: 'text', text: 'repo not found' }], isError: true };
      const pull = r.pulls.find(p => p.number === num);
      if (!pull) return { content: [{ type: 'text', text: 'pr not found' }], isError: true };
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = '1970-01-01T00:00:00.000Z';
      return { content: [{ type: 'text', text: JSON.stringify({ number: num, merged: true }) }], isError: false };
    }
    return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
  } catch (e: any) {
    return { content: [{ type: 'text', text: e.message }], isError: true };
  }
}

export async function handleMcp(req: any, res: any) {
  // auth
  const auth = req.headers.authorization;
  if (!auth) { sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } }); return; }

  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  let msg: any;
  try { msg = JSON.parse(raw); } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }

  // notification (no id) -> accept
  if (msg.id === undefined) {
    // notifications/initialized etc.
    res.writeHead(204, { 'x-github-request-id': rid() });
    res.end();
    return;
  }

  const id = msg.id;
  const method = msg.method;

  if (method === 'server/discover') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { serverInfo: { name: 'gitforge', version: '1.0.0' }, capabilities: { tools: {} }, supportedVersions: ['2026-07-28', '2025-11-25'] } });
    return;
  }
  if (method === 'initialize') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { protocolVersion: '2025-11-25', serverInfo: { name: 'gitforge', version: '1.0.0' }, capabilities: { tools: {} } } });
    return;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const params = msg.params || {};
    const toolName = params.name;
    const args = params.arguments || {};
    // missing args -> error
    const tool = TOOLS.find(t => t.name === toolName);
    if (!tool) {
      sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool' } });
      return;
    }
    // check required
    const required = tool.inputSchema.required || [];
    for (const r of required) {
      if (args[r] === undefined) {
        sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing arguments' } });
        return;
      }
    }
    const result = callTool(toolName, args);
    sendJson(res, 200, { jsonrpc: '2.0', id, result });
    return;
  }
  sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
}
