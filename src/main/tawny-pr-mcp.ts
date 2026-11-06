// `tawny-pr` MCP server (stdio), run by the PR chat's agent with Electron as Node (ELECTRON_RUN_AS_NODE).
// Holds no state: every tool relays one line of JSON to Tawny's main process over the unix socket in TAWNY_PR_SOCKET
// (see src/main/pr-agent.ts), which owns the findings list and the PR snapshot.
import * as net from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';

function relay(method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(process.env.TAWNY_PR_SOCKET || '');
    let buf = '';
    sock.on('connect', () => sock.write(`${JSON.stringify({ method, params })}\n`));
    sock.on('data', (d) => {
      buf += d;
      if (!buf.includes('\n')) return;
      sock.end();
      try {
        const r = JSON.parse(buf);
        if (r.error) reject(new Error(r.error));
        else resolve(r.result);
      } catch (e) {
        reject(e);
      }
    });
    sock.on('error', reject);
  });
}

const text = (v: unknown) => ({
  content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
});
const fail = (e: unknown) => ({ isError: true, ...text(`tawny-pr: ${(e as Error).message}`) });

const server = new McpServer({ name: 'tawny-pr', version: '1.0.0' });

server.registerTool(
  'propose_comment',
  {
    description:
      "Propose an inline review comment on the PR. It lands in the reviewer's findings list in Tawny; the reviewer decides whether it is added to their review. Nothing is posted to GitHub. `line` (and `startLine` for a range) refer to the file in the PR head for side RIGHT, or the base for side LEFT. `suggestion` is optional replacement text for the selected lines (RIGHT side only).",
    inputSchema: {
      path: z.string().describe('File path relative to the repo root'),
      startLine: z.number().int().optional().describe('First line of a multi-line range'),
      line: z.number().int().describe('Line (last line of a range) the comment is on'),
      side: z.enum(['LEFT', 'RIGHT']).default('RIGHT'),
      body: z.string().describe('The comment, in Markdown'),
      suggestion: z.string().optional().describe('Replacement for lines startLine..line'),
    },
  },
  async (args) => relay('propose_comment', args).then(text, fail),
);
server.registerTool(
  'get_pr',
  { description: 'Read-only: the PR under review (title, description, refs, head/base sha, state).' },
  async () => relay('get_pr', {}).then(text, fail),
);
server.registerTool(
  'get_threads',
  { description: 'Read-only: existing review threads on the PR (path, line, resolved, outdated, comments).' },
  async () => relay('get_threads', {}).then(text, fail),
);

server.connect(new StdioServerTransport()).catch((e) => {
  console.error(e);
  process.exit(1);
});
