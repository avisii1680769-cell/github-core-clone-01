import { getRepo, VIEWER_LOGIN, nextCounter, type Repo, type Issue, type Pull } from './store.ts';
import { rid } from './rest.ts';

function sendJson(res: any, status: number, body: any) {
  const text = JSON.stringify(body) + '\n';
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'x-github-request-id': rid() });
  res.end(buf);
}

// ---- GraphQL parser (minimal) ----
interface GQLField { kind:'Field'; name:string; alias?:string; args: Record<string, any>; selectionSet?: GQLSelectionSet; }
interface GQLFragment { kind:'Fragment'; typeCondition:string; selectionSet: GQLSelectionSet; }
type GQLSelection = GQLField | { kind:'FragmentSpread'; name:string } | { kind:'InlineFragment'; typeCondition:string; selectionSet: GQLSelectionSet };
interface GQLSelectionSet { selections: GQLSelection[]; }
interface GQLOperation { kind:'Operation'; operation:'query'|'mutation'|'subscription'; name?:string; variableDefinitions: {name:string; type:any; defaultValue?:any}[]; selectionSet: GQLSelectionSet; }

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push(src.slice(i, j)); i = j; continue;
    }
    if (/\d/.test(c)) {
      let j = i;
      while (j < n && /[\d.]/.test(src[j])) j++;
      tokens.push(src.slice(i, j)); i = j; continue;
    }
    if (c === '.') {
      let j = i;
      while (j < n && src[j] === '.') j++;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1; let str = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\') { str += src[j+1]; j += 2; continue; }
        str += src[j]; j++;
      }
      tokens.push(JSON.stringify(str)); i = j + 1; continue;
    }
    if (c === '$' || c === ':' || c === '!' || c === '(' || c === ')' || c === '{' || c === '}' || c === '[' || c === ']' || c === '=' || c === '@' || c === ',') {
      tokens.push(c); i++; continue;
    }
    // skip unknown
    i++;
  }
  return tokens;
}

class Parser {
  tokens: string[]; pos = 0;
  constructor(toks: string[]) { this.tokens = toks; }
  peek(): string { return this.tokens[this.pos]; }
  next(): string { return this.tokens[this.pos++]; }
  expect(tok: string) { if (this.next() !== tok) throw new Error('expected ' + tok); }
  parseDocument(): GQLOperation[] {
    const ops: GQLOperation[] = [];
    while (this.pos < this.tokens.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }
  parseOperation(): GQLOperation {
    let operation: 'query'|'mutation'|'subscription' = 'query';
    if (this.peek() === 'query' || this.peek() === 'mutation' || this.peek() === 'subscription') {
      operation = this.next() as any;
    }
    let name: string | undefined;
    if (/^[A-Za-z_]/.test(this.peek()) && this.peek() !== '{') {
      name = this.next();
    }
    let variableDefinitions: any[] = [];
    if (this.peek() === '(') {
      this.next();
      variableDefinitions = this.parseVariableDefinitions();
      this.expect(')');
    }
    // directives
    while (this.peek() === '@') { this.parseDirective(); }
    const selectionSet = this.parseSelectionSet();
    return { kind: 'Operation', operation, name, variableDefinitions, selectionSet };
  }
  parseVariableDefinitions(): any[] {
    const defs: any[] = [];
    while (this.peek() !== ')') {
      this.expect('$');
      const name = this.next();
      this.expect(':');
      const type = this.parseType();
      let defaultValue: any;
      if (this.peek() === '=') {
        this.next();
        defaultValue = this.parseValue(null);
      }
      defs.push({ name, type, defaultValue });
      if (this.peek() === ',') this.next();
    }
    return defs;
  }
  parseType(): any {
    if (this.peek() === '[') {
      this.next();
      const inner = this.parseType();
      this.expect(']');
      let nonNull = false;
      if (this.peek() === '!') { this.next(); nonNull = true; }
      return { kind: 'List', inner, nonNull };
    }
    const name = this.next();
    let nonNull = false;
    if (this.peek() === '!') { this.next(); nonNull = true; }
    return { kind: 'Named', name, nonNull };
  }
  parseSelectionSet(): GQLSelectionSet {
    this.expect('{');
    const selections: GQLSelection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const tc = this.next();
          const ss = this.parseSelectionSet();
          selections.push({ kind: 'InlineFragment', typeCondition: tc, selectionSet: ss });
        } else if (/^[A-Za-z_]/.test(this.peek())) {
          const name = this.next();
          const ss = this.parseSelectionSet();
          selections.push({ kind: 'FragmentSpread', name });
        } else {
          const ss = this.parseSelectionSet();
          selections.push({ kind: 'InlineFragment', typeCondition: '', selectionSet: ss });
        }
      } else {
        selections.push(this.parseField());
      }
      if (this.peek() === ',') this.next();
    }
    this.expect('}');
    return { selections };
  }
  parseField(): GQLField {
    const name = this.next();
    let alias: string | undefined;
    // alias
    // already consumed name; check if next is ':' meaning alias
    // We need handle alias: if peek is ':', then previous is alias
    // Rework: detect alias before consuming
    // Actually we consumed name already; handle below impossible. Let's restructure by peeking.
    // We'll redo: not here. Instead handle alias in a different method.
    let args: Record<string, any> = {};
    if (this.peek() === ':') {
      // name was alias
      this.next();
      const realName = this.next();
      // swap
      // We lost alias? alias=name, name=realName
      // handle args
      if (this.peek() === '(') {
        this.next();
        args = this.parseArguments(null);
        this.expect(')');
      }
      let selectionSet: GQLSelectionSet | undefined;
      if (this.peek() === '{') selectionSet = this.parseSelectionSet();
      while (this.peek() === '@') this.parseDirective();
      return { kind: 'Field', name: realName, alias: name, args, selectionSet };
    }
    if (this.peek() === '(') {
      this.next();
      args = this.parseArguments(null);
      this.expect(')');
    }
    let selectionSet: GQLSelectionSet | undefined;
    if (this.peek() === '{') selectionSet = this.parseSelectionSet();
    while (this.peek() === '@') this.parseDirective();
    return { kind: 'Field', name, args, selectionSet };
  }
  parseArguments(vars: any): Record<string, any> {
    const args: Record<string, any> = {};
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      args[name] = this.parseValue(vars);
      if (this.peek() === ',') this.next();
    }
    return args;
  }
  parseValue(vars: any): any {
    const tok = this.peek();
    if (tok === '$') {
      this.next();
      const vname = this.next();
      return { __var: vname };
    }
    if (tok === '{') {
      this.next();
      const obj: any = {};
      while (this.peek() !== '}') {
        const k = this.next();
        this.expect(':');
        obj[k] = this.parseValue(vars);
        if (this.peek() === ',') this.next();
      }
      this.expect('}');
      return obj;
    }
    if (tok === '[') {
      this.next();
      const arr: any[] = [];
      while (this.peek() !== ']') {
        arr.push(this.parseValue(vars));
        if (this.peek() === ',') this.next();
      }
      this.expect(']');
      return arr;
    }
    if (tok.startsWith('"')) {
      const s = JSON.parse(this.next());
      return s;
    }
    // enum or number or boolean/null
    if (tok === 'true') { this.next(); return true; }
    if (tok === 'false') { this.next(); return false; }
    if (tok === 'null') { this.next(); return null; }
    // number
    if (/^-?\d/.test(tok)) { this.next(); return Number(tok); }
    // enum (identifier)
    this.next();
    return { __enum: tok };
  }
  parseDirective() {
    this.next(); // @
    this.next(); // name
    if (this.peek() === '(') {
      this.next();
      this.parseArguments(null);
      this.expect(')');
    }
  }
}

// resolve variable references in args
function resolveArgs(args: any, variables: Record<string, any>): any {
  if (args && args.__var) return variables[args.__var];
  if (args && args.__enum) return args.__enum; // keep as string enum
  if (Array.isArray(args)) return args.map(x => resolveArgs(x, variables));
  if (args && typeof args === 'object') {
    const out: any = {};
    for (const k of Object.keys(args)) out[k] = resolveArgs(args[k], variables);
    return out;
  }
  return args;
}

// ---- Schema execution ----
const gqlIdMap = new Map<string, any>();

function makeId(type: string, key: string): string {
  const raw = `${type}:${key}`;
  return Buffer.from(raw).toString('base64');
}

function resolveId(id: string): any {
  return gqlIdMap.get(id);
}

const ENUMS: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

function typeFields(typeName: string): string[] {
  const map: Record<string, string[]> = {
    Issue: ['id', 'number', 'title', 'state', 'body'],
    User: ['login'],
    Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
    Ref: ['name'],
    IssueConnection: ['nodes', 'pageInfo'],
    PageInfo: ['hasNextPage', 'endCursor'],
    PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
    PullRequestConnection: ['nodes'],
    PullRequestChangedFile: ['path'],
    PullRequestFileConnection: ['nodes'],
    __Type: ['name', 'fields', 'enumValues'],
    __Field: ['name'],
    __EnumValue: ['name'],
  };
  return map[typeName] || [];
}

function executeField(typeName: string, obj: any, field: GQLField, variables: Record<string, any>, ctx: any): any {
  if ((typeName === 'Node' || typeName === '' || typeName === null) && obj && obj.__type) typeName = obj.__type;
  const fname = field.name;
  const args = resolveArgs(field.args || {}, variables);
  // introspection
  if (fname === '__type') {
    const name = args.name;
    return introspectType(name);
  }
  if (fname === '__schema') return { types: [] };
  if (typeName === 'Query') {
    if (fname === 'viewer') return { login: VIEWER_LOGIN };
    if (fname === 'repository') {
      const repo = getRepo(args.owner, args.name);
      if (!repo) return null;
      return repoToGql(repo);
    }
    if (fname === 'node') {
      const obj = resolveId(args.id);
      return obj;
    }
  }
  if (typeName === 'Mutation') {
    if (fname === 'createIssue') {
      const input = args.input;
      // find repo by id? input.repositoryId is global id. Resolve.
      const repoRef = resolveId(input.repositoryId);
      let repo: Repo | undefined;
      if (repoRef && repoRef.__repo) repo = repoRef.__repo;
      else {
        // maybe repositoryId is "owner/name"? try
        if (typeof input.repositoryId === 'string' && input.repositoryId.includes('/')) {
          const [o, n] = input.repositoryId.split('/');
          repo = getRepo(o, n);
        }
      }
      if (!repo) throw new Error('repo not found');
      const num = repo.nextIssueNumber++;
      const issue: Issue = { id: nextCounter(), number: num, title: input.title || '', body: input.body || '', state: 'open', labels: [], createdAt: nextCounter(), updatedAt: nextCounter() };
      repo.issues.push(issue);
      const id = makeId('Issue', `${repo.owner}/${repo.name}#${num}`);
      gqlIdMap.set(id, { __type: 'Issue', __issue: issue, __repo: repo });
      return { issue: { number: num, id } };
    }
    if (fname === 'closeIssue') {
      const input = args.input;
      const obj = resolveId(input.issueId);
      const issue: Issue = obj?.__issue;
      const repo: Repo = obj?.__repo;
      if (issue) issue.state = 'closed';
      return { issue: { number: issue.number, id: input.issueId, state: 'CLOSED' } };
    }
    if (fname === 'createPullRequest') {
      const input = args.input;
      const repoRef = resolveId(input.repositoryId);
      let repo: Repo | undefined = repoRef?.__repo;
      if (!repo && typeof input.repositoryId === 'string' && input.repositoryId.includes('/')) {
        const [o, n] = input.repositoryId.split('/');
        repo = getRepo(o, n);
      }
      if (!repo) throw new Error('repo not found');
      // resolve head/base shas
      const headSha = repo.git.refs.get(`refs/heads/${input.headRefName}`) || '';
      const baseSha = repo.git.refs.get(`refs/heads/${input.baseRefName}`) || '';
      const num = repo.nextPullNumber++;
      const pull: Pull = { id: nextCounter(), number: num, title: input.title || '', body: '', state: 'open', head: input.headRefName, base: input.baseRefName, headSha, baseSha, merged: false, mergedAt: null, mergeCommitSha: null, createdAt: nextCounter() };
      repo.pulls.push(pull);
      const id = makeId('PullRequest', `${repo.owner}/${repo.name}#${num}`);
      gqlIdMap.set(id, { __type: 'PullRequest', __pull: pull, __repo: repo });
      return { pullRequest: { number: num, id, state: 'OPEN', headRefName: input.headRefName, baseRefName: input.baseRefName } };
    }
    if (fname === 'mergePullRequest') {
      const input = args.input;
      const obj = resolveId(input.pullRequestId);
      const pull: Pull = obj?.__pull;
      const repo: Repo = obj?.__repo;
      if (!pull || !repo) throw new Error('pr not found');
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = '1970-01-01T00:00:00.000Z';
      const headTipOid = repo.git.refs.get(`refs/heads/${pull.head}`) || '';
      const headTreeOid = headTipOid ? getTreeOid(repo, headTipOid) : '';
      const baseTipOid = repo.git.refs.get(`refs/heads/${pull.base}`) || '';
      const newTreeOid = headTreeOid || (baseTipOid ? getTreeOid(repo, baseTipOid) : '');
      const commitOid = createCommit(repo, pull.base, newTreeOid, baseTipOid, `Merge pull request #${pull.number}`);
      pull.mergeCommitSha = commitOid;
      pull.mergedAt = '1970-01-01T00:00:00.000Z';
      return { pullRequest: { number: pull.number, merged: true, state: 'MERGED' } };
    }
    if (fname === 'addComment') {
      const input = args.input;
      const subj = resolveId(input.subjectId);
      const issue = subj?.__issue;
      const repo = subj?.__repo;
      const idNum = repo ? repo.nextCommentId++ : 0;
      const commentId = makeId('Comment', `${input.subjectId}:${idNum}`);
      if (repo && issue) {
        const arr = repo.issueComments.get(issue.number) || [];
        arr.push({ id: idNum, body: input.body || '', createdAt: 0 });
        repo.issueComments.set(issue.number, arr);
      }
      return { commentEdge: { node: { id: commentId, body: input.body } } };
    }
  }
  if (typeName === 'Repository') {
    const repo: any = (obj && obj.__repo) ? obj.__repo : obj;
    if (fname === 'id') {
      const id = makeId('Repository', `${repo.owner}/${repo.name}`);
      gqlIdMap.set(id, { __type: 'Repository', __repo: repo });
      return id;
    }
    if (fname === 'databaseId') return 1;
    if (fname === 'name') return repo.name;
    if (fname === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (fname === 'owner') return { login: repo.owner };
    if (fname === 'defaultBranchRef') {
      const tip = repo.git.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip ? { name: repo.defaultBranch } : { name: repo.defaultBranch };
    }
    if (fname === 'viewerPermission') return 'ADMIN';
    if (fname === 'hasIssuesEnabled') return true;
    if (fname === 'issue') {
      const n = args.number;
      const issue = repo.issues.find((i: any) => i.number === n);
      if (!issue) return null;
      const id = makeId('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
      gqlIdMap.set(id, { __type: 'Issue', __issue: issue, __repo: repo });
      return issueToGql(issue, id);
    }
    if (fname === 'issues') {
      let items = [...repo.issues];
      if (args.states) {
        const st = (Array.isArray(args.states) ? args.states : [args.states]).map((x: any) => String(x).toUpperCase());
        items = items.filter((i: any) => st.includes(i.state.toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN'));
      }
      // orderBy
      if (args.orderBy) {
        const dir = args.orderBy.direction;
        const desc = dir === 'DESC';
        items.sort((a: any, b: any) => {
          if (a.createdAt !== b.createdAt) return desc ? b.createdAt - a.createdAt : a.createdAt - b.createdAt;
          return desc ? b.number - a.number : a.number - b.number;
        });
      }
      // pagination first/after
      const first = args.first ?? items.length;
      let start = 0;
      if (args.after) {
        // cursor = index
        start = parseInt(args.after, 10) || 0;
      }
      const slice = items.slice(start, start + first);
      const hasNext = start + first < items.length;
      const endCursor = hasNext ? String(start + first) : null;
      const nodes = slice.map((i: any) => {
        const id = makeId('Issue', `${repo.owner}/${repo.name}#${i.number}`);
        gqlIdMap.set(id, { __type: 'Issue', __issue: i, __repo: repo });
        return issueToGql(i, id);
      });
      return { nodes, pageInfo: { hasNextPage: hasNext, endCursor } };
    }
    if (fname === 'pullRequests') {
      const first = args.first ?? repo.pulls.length;
      const nodes = repo.pulls.slice(0, first).map((p: any) => {
        const id = makeId('PullRequest', `${repo.owner}/${repo.name}#${p.number}`);
        gqlIdMap.set(id, { __type: 'PullRequest', __pull: p, __repo: repo });
        return pullToGql(p, id, repo);
      });
      return { nodes };
    }
    if (fname === 'pullRequest') {
      const n = args.number;
      const p = repo.pulls.find((x: any) => x.number === n);
      if (!p) return null;
      const id = makeId('PullRequest', `${repo.owner}/${repo.name}#${p.number}`);
      gqlIdMap.set(id, { __type: 'PullRequest', __pull: p, __repo: repo });
      return pullToGql(p, id, repo);
    }
  }
  if (typeName === 'Issue') {
    if (fname === 'id') return obj.__id || makeId('Issue', 'x');
    if (fname === 'number') return obj.number;
    if (fname === 'title') return obj.title;
    if (fname === 'state') return obj.state.toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN';
    if (fname === 'body') return obj.body;
  }
  if (typeName === 'PullRequest') {
    if (fname === 'id') return obj.id;
    if (fname === 'number') return obj.number;
    if (fname === 'state') {
      if (obj.merged) return 'MERGED';
      return obj.state.toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN';
    }
    if (fname === 'merged') return obj.merged;
    if (fname === 'headRefName') return obj.head;
    if (fname === 'baseRefName') return obj.base;
    if (fname === 'mergeable') return 'MERGEABLE';
    if (fname === 'files') {
      const first = args.first ?? 10;
      // compute changed files
      const repo: Repo = obj.__repo;
      const baseTipOid = repo.git.refs.get(`refs/heads/${obj.base}`) || null;
      const headTipOid = repo.git.refs.get(`refs/heads/${obj.head}`) || null;
      const baseTreeOid = baseTipOid ? getTreeOid(repo, baseTipOid) : '';
      const headTreeOid = headTipOid ? getTreeOid(repo, headTipOid) : '';
      const changed = diffTrees(repo, baseTreeOid, headTreeOid);
      const nodes = changed.slice(0, first).map((c: any) => ({ path: c.filename }));
      return { nodes };
    }
  }
  if (typeName === 'Ref') {
    if (fname === 'name') return obj.name;
  }
  if (typeName === 'User') {
    if (fname === 'login') return obj.login;
  }
  if (typeName === 'Node' || typeName === '') {
    // Repository fields
  }
  if (typeName === '__Type') {
    if (fname === 'name') return obj.name;
    if (fname === 'fields') {
      const incDep = args.includeDeprecated;
      const names = typeFields(obj.name);
      return names.map((n: string) => ({ name: n }));
    }
    if (fname === 'enumValues') {
      const vals = ENUMS[obj.name] || [];
      return vals.map((v: string) => ({ name: v }));
    }
  }
  if (typeName === '__Field') {
    if (fname === 'name') return obj.name;
  }
  if (typeName === '__EnumValue') {
    if (fname === 'name') return obj.name;
  }
  // Generic property fallback: payload objects and connection objects carry their fields as properties.
  if (obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, fname)) {
    return (obj as any)[fname];
  }
  throw new Error(`Unknown field ${fname} on ${typeName}`);
}

function issueToGql(issue: any, id: string) {
  return { __id: id, number: issue.number, title: issue.title, state: issue.state === 'closed' ? 'CLOSED' : 'OPEN', body: issue.body, id };
}
function pullToGql(pull: any, id: string, repo: Repo) {
  return { __id: id, id, number: pull.number, state: pull.merged ? 'MERGED' : (pull.state === 'closed' ? 'CLOSED' : 'OPEN'), merged: pull.merged, head: pull.head, base: pull.base, headRefName: pull.head, baseRefName: pull.base, __repo: repo, __pull: pull };
}
function repoToGql(repo: Repo) {
  const id = makeId('Repository', `${repo.owner}/${repo.name}`);
  gqlIdMap.set(id, { __type: 'Repository', __repo: repo });
  return { __repo: repo, id, databaseId: 1, name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}`, owner: { login: repo.owner }, defaultBranchRef: { name: repo.defaultBranch }, viewerPermission: 'ADMIN', hasIssuesEnabled: true };
}

function introspectType(name: string) {
  if (ENUMS[name]) {
    return { name, fields: null, enumValues: ENUMS[name].map(v => ({ name: v })) };
  }
  const fields = typeFields(name);
  if (fields.length === 0 && !ENUMS[name]) {
    // maybe unknown type -> null? For __type(name) GraphQL returns null for unknown
  }
  return { name, fields: fields.map(f => ({ name: f })), enumValues: null };
}

function getTreeOid(repo: Repo, commitOid: string): string {
  const obj = repo.git.objects.get(commitOid);
  if (!obj) return '';
  const m = obj.data.toString('utf8').match(/^tree ([0-9a-f]{40})/m);
  return m ? m[1] : '';
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
function diffTrees(repo: Repo, baseTreeOid: string, headTreeOid: string): any[] {
  function listFiles(treeOid: string, prefix: string, out: Map<string, string>) {
    if (!treeOid) return;
    const obj = repo.git.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    // parse tree
    let offset = 0; const data = obj.data;
    // use rest parseTree? reimplement minimal
    const entries: { mode: string; name: string; oid: string }[] = [];
    let o = 0;
    while (o < data.length) {
      const space = data.indexOf(0x20, o);
      const nul = data.indexOf(0, space + 1);
      const mode = data.subarray(o, space).toString('ascii');
      const name = data.subarray(space + 1, nul).toString('utf8');
      const oid = data.subarray(nul + 1, nul + 21).toString('hex');
      entries.push({ mode, name, oid });
      o = nul + 21;
    }
    for (const e of entries) {
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
    if (!baseFiles.has(path)) result.push({ filename: path, status: 'added', additions: 1, deletions: 0, changes: 1, path });
    else if (baseFiles.get(path) !== oid) result.push({ filename: path, status: 'modified', additions: 1, deletions: 1, changes: 2, path });
  }
  for (const [path] of baseFiles) {
    if (!headFiles.has(path)) result.push({ filename: path, status: 'removed', additions: 0, deletions: 1, changes: 1, path });
  }
  return result;
}

function executeSelection(typeName: string, obj: any, sel: GQLSelectionSet, variables: Record<string, any>, ctx: any): any {
  const result: any = {};
  for (const s of sel.selections) {
    if (s.kind === 'Field') {
      const key = s.alias || s.name;
      // handle unknown field -> throw
      const val = executeField(typeName, obj, s as any, variables, ctx);
      let childVal = val;
      if (s.selectionSet && val !== null && val !== undefined) {
        if (Array.isArray(val)) {
          childVal = val.map((v: any) => executeSelection(inferType(typeName, s.name), v, s.selectionSet!, variables, ctx));
        } else if (typeof val === 'object') {
          const t = inferType(typeName, s.name);
          childVal = executeSelection(t, val, s.selectionSet!, variables, ctx);
        }
      }
      result[key] = childVal;
    } else if (s.kind === 'InlineFragment') {
      // only apply if type matches
      const tc = s.typeCondition;
      if (tc && obj && obj.__type === tc) {
        const r = executeSelection(tc, obj, s.selectionSet, variables, ctx);
        Object.assign(result, r);
      } else if (!tc) {
        const r = executeSelection(typeName, obj, s.selectionSet, variables, ctx);
        Object.assign(result, r);
      }
    }
  }
  return result;
}

function inferType(parentType: string, fieldName: string): string {
  const m: Record<string, Record<string, string>> = {
    Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
    Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest' },
    IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
    PullRequestConnection: { nodes: 'PullRequest' },
    PullRequest: { files: 'PullRequestFileConnection' },
    PullRequestFileConnection: { nodes: 'PullRequestChangedFile' },
    Node: {},
    __Type: { fields: '__Field', enumValues: '__EnumValue', name: '' },
    __Field: { name: '' },
    __EnumValue: { name: '' },
  };
  // node() may return Repository; handle by checking obj
  if (fieldName === 'node') return 'Node';
  return m[parentType]?.[fieldName] || '';
}

export async function handleGraphQL(req: any, res: any) {
  // auth
  const auth = req.headers.authorization;
  if (!auth) { sendJson(res, 401, { message: 'Requires authentication' }); return; }

  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  let body: any;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { sendJson(res, 400, { errors: [{ message: 'Parse error' }] }); return; }

  const runOne = async (doc: any): Promise<any> => {
    const query = doc.query || doc;
    const variables = doc.variables || {};
    const toks = tokenize(typeof query === 'string' ? query : '');
    const parser = new Parser(toks);
    const ops = parser.parseDocument();
    const op = ops[0];
    const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
    const rootObj = rootType === 'Mutation' ? {} : {};
    // validate variables
    const vars = variables || {};
    // resolve var references
    try {
      const result = executeSelection(rootType, rootObj, op.selectionSet, vars, {});
      // If errors thrown, catch
      return { data: result };
    } catch (e: any) {
      return { data: null, errors: [{ message: e.message || String(e) }] };
    }
  };

  // batching
  if (Array.isArray(body)) {
    const results: any[] = [];
    for (const d of body) {
      results.push(await runOne(d));
    }
    sendJson(res, 200, results);
    return;
  }
  const result = await runOne(body);
  // ensure errors array only if present
  sendJson(res, 200, result);
}
