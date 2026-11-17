import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest } from './rest.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { getRepo } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string,string> = {}) {
  const text = `${JSON.stringify(body)}\n`;
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': buf.length, ...headers });
  res.end(buf);
}

function pathOf(req: IncomingMessage): string {
  try { return new URL(req.url ?? '/', 'http://entry').pathname; } catch { return '/'; }
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = (req.method ?? 'GET').toUpperCase();

    // healthz
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // MCP
    if (path === '/mcp') {
      handleMcp(req, res);
      return;
    }

    // GraphQL
    if (path === '/api/graphql') {
      handleGraphQL(req, res);
      return;
    }

    // REST
    if (path.startsWith('/api/v3') || path.startsWith('/api/v3/')) {
      handleRest(req, res, path, method);
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/...
    const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git(\/.*)?$/);
    if (gitMatch) {
      const owner = decodeURIComponent(gitMatch[1]);
      const repoName = decodeURIComponent(gitMatch[2]);
      const suffix = gitMatch[3] || '';
      if (suffix === '/info/refs' || suffix === 'info/refs') {
        handleInfoRefs(req, res, owner, repoName);
        return;
      }
      if (suffix === '/git-upload-pack' || suffix === 'git-upload-pack') {
        handleUploadPack(req, res, owner, repoName);
        return;
      }
      if (suffix === '/git-receive-pack' || suffix === 'git-receive-pack') {
        handleReceivePack(req, res, owner, repoName);
        return;
      }
      // unknown git route
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // default 404
    sendJson(res, 404, { message: 'Not Found' });
  });
}
