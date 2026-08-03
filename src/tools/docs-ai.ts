/**
 * ORB-799 — docs-AI surface (ask + ingest).
 *
 * Three tools that mirror the wrapper's `ask-docs` / `ingest-url` /
 * `ingest-file` subcommands. Together they're the foundation for any
 * agent that needs to "remember this URL" / "add this PDF to our
 * wiki" workflows.
 *
 *   - orboto_ask_docs   — RAG Q&A across wiki docs, returns answer +
 *                         citations. Requires both `configured` and
 *                         `embeddingsConfigured` on `/ai/status`
 *                         (RAG retrieval needs an embedding-capable
 *                         provider).
 *   - orboto_ingest_url — fetch + extract + create doc from a public
 *                         URL via the Readability-fallback pipeline.
 *   - orboto_ingest_file — upload + extract + create doc from a local
 *                         file (PDF / DOCX / Markdown / plain text).
 *                         Uses the multipart-upload route, so the MCP
 *                         tool receives the bytes as a base64 string
 *                         to avoid the model needing local FS access.
 *
 * AI-gated note: the `ai_status` tool exists for pre-flight. We do NOT
 * pre-check inside the handlers — the API returns the same gating
 * error regardless and a pre-check would double the latency of every
 * call. Models are expected to call `orboto_ai_status` once per
 * session if they're unsure of workspace shape.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

interface AskDocsCitation {
  index: number;
  title: string;
  link: string;
  spaceName?: string | null;
}

interface AskDocsResponse {
  answer: string;
  citations: AskDocsCitation[];
  mode: string;
}

interface IngestUrlResponse {
  docId: string;
  title: string;
  slug: string;
  fetchedBytes: number;
  markdownChars: number;
  readabilityFallback?: boolean;
}

interface IngestFileResponse {
  docId: string;
  title: string;
  slug: string;
  kind: string;
  sizeBytes: number;
  markdownChars: number;
}

// ---------------------------------------------------------------------------
// orboto_ask_docs
// ---------------------------------------------------------------------------

export const askDocsToolConfig = {
  title: 'Ask a question against the wiki (RAG)',
  description:
    'Run a natural-language question against the wiki via the workspace\'s RAG pipeline. Returns an `answer` (Markdown) + `citations` array `[{index, title, link, spaceName}]`. The model is the workspace\'s configured AI provider; retrieval requires the embedding provider too — call `orboto_ai_status` to verify both before relying on this. Restrict to a single doc space with `spaceId` when scoping a query (e.g. "only the runbooks space"). Latency is dominated by retrieval + LLM round-trip; expect 2-10s.',
  inputSchema: z.object({
    question: z.string().min(3),
    spaceId: z.string().min(1).optional().describe('Limit RAG retrieval to one doc space - key (e.g. ORB-S1), name, or UUID.'),
    limit: z.number().int().min(1).max(20).optional().describe('Max chunks to retrieve (default: 5).'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeAskDocsHandler(client: OrbotoClient) {
  return async ({ question, spaceId, limit }: {
    question: string; spaceId?: string; limit?: number;
  }): Promise<CallToolResult> => {
    const body: Record<string, unknown> = { question, limit: limit ?? 5 };
    if (spaceId) body.spaceId = spaceId;
    const res = await client.post<AskDocsResponse>('/ai/ask-docs', body);
    const lines = [res.answer.trim()];
    if (res.citations.length > 0) {
      lines.push('', 'Sources:');
      for (const c of res.citations) {
        const spaceTag = c.spaceName ? `[${c.spaceName}] ` : '';
        lines.push(`  [${c.index}] ${spaceTag}${c.title}  ${c.link}`);
      }
    }
    lines.push('', `(retrieval mode: ${res.mode})`);
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        answer: res.answer,
        citations: res.citations,
        mode: res.mode,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_ingest_url
// ---------------------------------------------------------------------------

export const ingestUrlToolConfig = {
  title: 'Ingest a public URL into a wiki space',
  description:
    'Fetch a public URL, run Readability extraction, store the result as a Markdown doc in `spaceId`. Optionally nest under `parentDocId` to keep the tree tidy. Sets `readabilityFallback: true` when the page didn\'t look like a recognisable article (the body falls back to full-page text — a flag the caller should surface to the operator for review).',
  inputSchema: z.object({
    url: z.string().url(),
    spaceId: z.string().uuid().describe('Target doc space — find IDs via `orboto_list_doc_spaces`.'),
    parentDocId: z.string().uuid().optional().describe('Optional parent doc to nest under.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makeIngestUrlHandler(client: OrbotoClient) {
  return async ({ url, spaceId, parentDocId }: {
    url: string; spaceId: string; parentDocId?: string;
  }): Promise<CallToolResult> => {
    const body: Record<string, unknown> = { url };
    if (parentDocId) body.parentDocId = parentDocId;
    const res = await client.post<IngestUrlResponse>(`/spaces/${spaceId}/docs/ingest-url`, body);
    const lines = [
      `Created doc: ${res.title}`,
      `  id: ${res.docId}`,
      `  slug: ${res.slug}`,
      `  fetched ${Math.round(res.fetchedBytes / 1024)} KB → ${res.markdownChars} chars of markdown`,
    ];
    if (res.readabilityFallback) {
      lines.push('  ! Readability couldn\'t identify a main article — body is full-page text. Review before relying.');
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        docId: res.docId,
        title: res.title,
        slug: res.slug,
        fetchedBytes: res.fetchedBytes,
        markdownChars: res.markdownChars,
        readabilityFallback: res.readabilityFallback === true,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_ingest_file
// ---------------------------------------------------------------------------

function mimetypeFor(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown';
  return 'text/plain';
}

export const ingestFileToolConfig = {
  title: 'Ingest a local file into a wiki space (multipart upload)',
  description:
    'Upload a file (PDF / DOCX / Markdown / plain text) into `spaceId` via multipart. The model passes the bytes as a base64 `contentBase64` field (so this works without local FS access on the agent side). Use `filename` to give the doc a meaningful title — the backend sniffs the mimetype but also uses the filename for display. Optional `parentDocId` nests under an existing doc.',
  inputSchema: z.object({
    spaceId: z.string().uuid(),
    filename: z.string().min(1).describe('Display filename, e.g. "ADR-12-secrets-rotation.pdf".'),
    contentBase64: z.string().min(1).describe('File content, base64-encoded.'),
    parentDocId: z.string().uuid().optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makeIngestFileHandler(client: OrbotoClient) {
  return async ({ spaceId, filename, contentBase64, parentDocId }: {
    spaceId: string; filename: string; contentBase64: string; parentDocId?: string;
  }): Promise<CallToolResult> => {
    let arrayBuffer: ArrayBuffer;
    try {
      // See attach.ts for the Buffer → ArrayBuffer copy rationale.
      const buf = Buffer.from(contentBase64, 'base64');
      arrayBuffer = new ArrayBuffer(buf.byteLength);
      new Uint8Array(arrayBuffer).set(buf);
    } catch {
      throw new Error('contentBase64 is not valid base64.');
    }
    if (arrayBuffer.byteLength === 0) {
      throw new Error('contentBase64 decoded to 0 bytes — refuse to upload an empty file.');
    }
    const form = new FormData();
    form.append(
      'file',
      new Blob([arrayBuffer], { type: mimetypeFor(filename) }),
      filename,
    );
    if (parentDocId) form.append('parentDocId', parentDocId);
    const res = await client.postMultipart<IngestFileResponse>(
      `/spaces/${spaceId}/docs/ingest-file`,
      form,
    );
    const lines = [
      `Created doc: ${res.title}`,
      `  id: ${res.docId}`,
      `  slug: ${res.slug}`,
      `  format: ${res.kind}`,
      `  uploaded ${Math.round(res.sizeBytes / 1024)} KB → ${res.markdownChars} chars of markdown`,
    ];
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        docId: res.docId,
        title: res.title,
        slug: res.slug,
        kind: res.kind,
        sizeBytes: res.sizeBytes,
        markdownChars: res.markdownChars,
      },
    };
  };
}
