// In-memory store for the forge. One process per trial; all state here.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const VIEWER_LOGIN = 'adaiversen';
export const STRANGER_LOGIN = 'olgabauer';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject { type: GitObjectType; data: Buffer }

export class RepoStore {
  objects = new Map<string, GitObject>(); // oid -> object
  refs = new Map<string, string>(); // ref name -> oid
  head = 'ref:refs/heads/main';
  defaultBranch = 'main';

  put(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  git: RepoStore;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, { name: string; color: string }>;
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
  comments: Map<number, Comment[]>; // issue/PR number -> comments (shared pool by number? separate)
  issueComments: Map<number, Comment[]>;
  pullMerged: Set<number>;
  createdAt: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Comment { id: number; body: string; createdAt: number }

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string; // branch name
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: number;
}

export const repos = new Map<string, Repo>(); // "owner/name"
export const users = new Map<string, { login: string; token: string }>();

export function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }

export function getRepo(owner: string, name: string): Repo | undefined { return repos.get(repoKey(owner, name)); }

export function createRepo(owner: string, name: string, opts: { private?: boolean; description?: string } = {}): Repo {
  const r: Repo = {
    id: nextCounter(),
    owner, name,
    private: opts.private ?? true,
    description: opts.description ?? '',
    defaultBranch: 'main',
    git: new RepoStore(),
    issues: [],
    pulls: [],
    labels: new Map(),
    nextIssueNumber: 1,
    nextPullNumber: 1,
    nextCommentId: 1,
    comments: new Map(),
    issueComments: new Map(),
    pullMerged: new Set(),
    createdAt: 0,
  };
  repos.set(repoKey(owner, name), r);
  return r;
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}

export function tokenize(req: any): string | null {
  const h = req.headers?.authorization || req.headers?.Authorization;
  if (!h) return null;
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export function hasToken(req: any): boolean {
  return tokenize(req) !== null;
}

// deterministic "now" for timestamps stored? Use 0 / fixed. Issues createdAt used for sorting.
// We'll use a monotonic counter per repo for ordering instead of time.
export let globalCounter = 0;
export function nextCounter(): number { return ++globalCounter; }
