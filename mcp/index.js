#!/usr/bin/env node
// ClipWarp MCP server — stdio transport.
//
// Exposes three tools (clipboard_push / clipboard_pull / clipboard_search) that
// talk ONLY to ClipWarp's HTTP REST API using a personal access token.
//
// SECURITY: stdout is the MCP transport channel — only the transport may write
// to it. We never log clip content or the token anywhere (stdout or stderr).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const CLIPWARP_URL = (process.env.CLIPWARP_URL || 'http://localhost:2547').replace(/\/+$/, '');
const CLIPWARP_TOKEN = process.env.CLIPWARP_TOKEN || '';
const REQUEST_TIMEOUT_MS = 15000;
const CLIP_BODY_MAX = 500;

// ---------------------------------------------------------------------------
// Pure formatting helpers (exported for testing — no network, no side effects).
// ---------------------------------------------------------------------------

/**
 * Truncate a string to `max` characters, appending an ellipsis marker when cut.
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
export function truncate(value, max = CLIP_BODY_MAX) {
  const str = value == null ? '' : String(value);
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n… [truncated, ${str.length} chars total]`;
}

/**
 * Build the one-line header for a clip: `#id [contentType] (title or device/time)`.
 * @param {Record<string, any>} clip
 * @returns {string}
 */
export function formatClipHeader(clip) {
  const id = clip && clip.id != null ? clip.id : '?';
  const type = (clip && clip.contentType) || 'text';
  let label;
  if (clip && clip.title) {
    label = clip.title;
  } else {
    const device = (clip && clip.deviceLabel) || 'unknown';
    const ts = clip && clip.createdAt ? new Date(clip.createdAt).toISOString() : 'unknown-time';
    label = `${device} @ ${ts}`;
  }
  return `#${id} [${type}] (${label})`;
}

/**
 * Render an array of clips into a readable text view. Each clip body is
 * truncated to ~500 chars. Returns a friendly message when the list is empty.
 * @param {Array<Record<string, any>>} clips
 * @returns {string}
 */
export function formatClips(clips) {
  if (!Array.isArray(clips) || clips.length === 0) {
    return 'No clips found.';
  }
  return clips
    .map((clip) => `${formatClipHeader(clip)}\n${truncate(clip && clip.content)}`)
    .join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// HTTP helpers.
// ---------------------------------------------------------------------------

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Perform an authenticated request against the ClipWarp API.
 * Returns { ok, status, data } on a completed HTTP exchange, or throws on a
 * network/timeout failure. Never logs content or the token.
 */
async function clipwarpFetch(path, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${CLIPWARP_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${CLIPWARP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    let data = null;
    const raw = await res.text();
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = null;
      }
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Translate a non-2xx response or thrown error into a concise tool error result.
 * Includes the server's `error`/`message` when present. Never includes the token.
 */
function describeFailure(prefix, { status, data } = {}, err) {
  if (err) {
    const reason = err && err.name === 'AbortError'
      ? `request timed out after ${REQUEST_TIMEOUT_MS} ms`
      : `network error: ${err && err.message ? err.message : 'unknown'}`;
    return `${prefix}: ${reason} (is ClipWarp running at ${CLIPWARP_URL}?)`;
  }
  const code = data && data.error ? data.error : `http_${status}`;
  const msg = data && data.message ? data.message : '';
  if (status === 401) {
    return `${prefix}: unauthorized — check CLIPWARP_TOKEN is a valid personal access token.`;
  }
  return `${prefix}: ${code}${msg ? ` — ${msg}` : ''} (HTTP ${status}).`;
}

function tokenMissingResult() {
  return errorResult(
    'CLIPWARP_TOKEN is not set. Create a personal access token in the ClipWarp web UI ' +
      '(设置 → 个人访问令牌, POST /api/tokens) and set it in the CLIPWARP_TOKEN environment variable.',
  );
}

// ---------------------------------------------------------------------------
// Tool handlers.
// ---------------------------------------------------------------------------

async function handlePush({ content, burnAfterRead, ttlSeconds }) {
  if (!CLIPWARP_TOKEN) return tokenMissingResult();
  const payload = { content };
  if (burnAfterRead !== undefined) payload.burnAfterRead = burnAfterRead;
  if (ttlSeconds !== undefined) payload.ttlSeconds = ttlSeconds;
  try {
    const resp = await clipwarpFetch('/api/clips', { method: 'POST', body: payload });
    if (!resp.ok) return errorResult(describeFailure('Failed to push clip', resp));
    const clip = resp.data && resp.data.clip ? resp.data.clip : null;
    if (!clip) return errorResult('Failed to push clip: unexpected response from ClipWarp.');
    const titlePart = clip.title ? ` titled "${clip.title}"` : '';
    return textResult(`Pushed clip #${clip.id}${titlePart} (contentType: ${clip.contentType || 'text'}).`);
  } catch (err) {
    return errorResult(describeFailure('Failed to push clip', {}, err));
  }
}

async function handlePull({ limit }) {
  if (!CLIPWARP_TOKEN) return tokenMissingResult();
  const n = clampLimit(limit, 10);
  try {
    const resp = await clipwarpFetch(`/api/clips?limit=${n}`);
    if (!resp.ok) return errorResult(describeFailure('Failed to pull clips', resp));
    const clips = resp.data && Array.isArray(resp.data.clips) ? resp.data.clips : [];
    return textResult(formatClips(clips));
  } catch (err) {
    return errorResult(describeFailure('Failed to pull clips', {}, err));
  }
}

async function handleSearch({ query, limit }) {
  if (!CLIPWARP_TOKEN) return tokenMissingResult();
  const n = clampLimit(limit, 10);
  try {
    const resp = await clipwarpFetch(`/api/clips/search?q=${encodeURIComponent(query)}&limit=${n}`);
    if (!resp.ok) return errorResult(describeFailure('Failed to search clips', resp));
    const clips = resp.data && Array.isArray(resp.data.clips) ? resp.data.clips : [];
    return textResult(formatClips(clips));
  } catch (err) {
    return errorResult(describeFailure('Failed to search clips', {}, err));
  }
}

function clampLimit(limit, fallback) {
  const n = Number.isFinite(limit) ? Math.floor(limit) : fallback;
  return Math.min(50, Math.max(1, n));
}

// ---------------------------------------------------------------------------
// Server bootstrap.
// ---------------------------------------------------------------------------

export function createServer() {
  const server = new McpServer({ name: 'clipwarp', version: '0.3.0' });

  server.registerTool(
    'clipboard_push',
    {
      title: 'Push to ClipWarp',
      description:
        'Push text content to the ClipWarp cloud clipboard so it syncs to your other devices. ' +
        'Optionally make it burn-after-read or set a TTL in seconds.',
      inputSchema: {
        content: z.string().min(1).describe('The text content to push to the clipboard.'),
        burnAfterRead: z
          .boolean()
          .optional()
          .describe('If true, the clip is destroyed after it is first read/copied.'),
        ttlSeconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Time-to-live in seconds; the clip auto-expires after this period.'),
      },
    },
    handlePush,
  );

  server.registerTool(
    'clipboard_pull',
    {
      title: 'Pull recent ClipWarp clips',
      description:
        'Fetch the most recent clips from the ClipWarp cloud clipboard, newest first, as readable text.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('How many clips to fetch (1-50, default 10).'),
      },
    },
    handlePull,
  );

  server.registerTool(
    'clipboard_search',
    {
      title: 'Search ClipWarp clips',
      description: 'Full-text search the ClipWarp cloud clipboard and return matching clips as readable text.',
      inputSchema: {
        query: z.string().min(1).describe('The search query.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Max number of results (1-50, default 10).'),
      },
    },
    handleSearch,
  );

  return server;
}

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only start the stdio server when executed directly, so importing this module
// (e.g. in tests) does not open the transport / hang the process.
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main().catch((err) => {
    // Surface a fatal bootstrap error on stderr without leaking content/token.
    process.stderr.write(`clipwarp-mcp failed to start: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  });
}
