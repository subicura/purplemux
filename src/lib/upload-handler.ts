import type { IncomingMessage, ServerResponse } from 'http';
import { saveImage, saveFile, isValidMime, MAX_BYTES, GENERIC_MAX_BYTES } from '@/lib/uploads-store';
import { verifyTokenValue } from '@/lib/cli-token';
import { verifySessionToken, extractCookie, SESSION_COOKIE } from '@/lib/auth';
import { createLogger } from '@/lib/logger';

const log = createLogger('uploads');

export const UPLOAD_PATHS = new Set(['/api/upload-image', '/api/upload-file']);

type TUploadErrorCode = 'PAYLOAD_TOO_LARGE' | 'TRUNCATED';

export class UploadError extends Error {
  constructor(
    public readonly code: TUploadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/**
 * Reads a request body into a Buffer, rejecting (rather than silently truncating)
 * when it exceeds `maxBytes` or when the stream ends before `expectedLength` bytes
 * arrive. Handled in the custom server so Next's request-body cap never applies.
 */
export const readBodyWithLimit = (
  req: NodeJS.ReadableStream & { destroy?: (error?: Error) => void },
  maxBytes: number,
  expectedLength?: number,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        reject(new UploadError('PAYLOAD_TOO_LARGE', `exceeds ${maxBytes} bytes`));
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (expectedLength != null && total < expectedLength) {
        reject(new UploadError('TRUNCATED', `received ${total} of ${expectedLength} bytes`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });

const headerString = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const isAuthorized = async (req: IncomingMessage): Promise<boolean> => {
  const token = headerString(req.headers['x-pmux-token']);
  if (token && verifyTokenValue(token)) return true;
  const cookie = extractCookie(req.headers.cookie ?? '', SESSION_COOKIE);
  return cookie ? !!(await verifySessionToken(cookie)) : false;
};

interface IUploadTarget {
  wsId?: string;
  tabId?: string;
  originalName?: string;
}

const readTarget = (req: IncomingMessage): IUploadTarget => {
  const originalNameRaw = headerString(req.headers['x-pmux-filename']);
  return {
    wsId: headerString(req.headers['x-pmux-ws-id']),
    tabId: headerString(req.headers['x-pmux-tab-id']),
    originalName: originalNameRaw ? decodeURIComponent(originalNameRaw) : undefined,
  };
};

/**
 * Shared body intake for both upload kinds: enforces the size limit up front
 * (Content-Length) and while streaming, and rejects truncated streams. Returns
 * the full body, or `null` when it already sent an error response.
 */
const readLimitedBody = async (
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
  tooLargeMessage: string,
): Promise<Buffer | null> => {
  const lengthHeader = headerString(req.headers['content-length']);
  const expectedLength = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : undefined;

  // Reject oversize uploads up front without reading the whole body.
  if (expectedLength != null && expectedLength > maxBytes) {
    sendJson(res, 413, { error: tooLargeMessage });
    req.destroy();
    return null;
  }

  let body: Buffer;
  try {
    body = await readBodyWithLimit(req, maxBytes, expectedLength);
  } catch (err) {
    if (err instanceof UploadError && err.code === 'PAYLOAD_TOO_LARGE') {
      sendJson(res, 413, { error: tooLargeMessage });
    } else if (err instanceof UploadError && err.code === 'TRUNCATED') {
      sendJson(res, 400, { error: 'Upload was truncated before completing; please retry' });
    } else {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'failed to read body' });
    }
    return null;
  }

  if (body.length === 0) {
    sendJson(res, 400, { error: 'Empty body' });
    return null;
  }
  return body;
};

/**
 * `/api/upload-image` — only accepts supported image MIME types, caps at 10 MB,
 * and stores via `saveImage` (filename extension derived from the MIME type).
 */
export const handleImageUpload = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  if (!(await isAuthorized(req))) {
    sendJson(res, 401, { error: 'Unauthorized' });
    req.destroy();
    return;
  }

  const mime = headerString(req.headers['content-type'])?.split(';')[0]?.trim() ?? '';
  if (!isValidMime(mime)) {
    sendJson(res, 400, { error: 'Unsupported image type' });
    req.destroy();
    return;
  }

  const body = await readLimitedBody(req, res, MAX_BYTES, 'Image exceeds 10MB');
  if (!body) return;

  const { wsId, tabId, originalName } = readTarget(req);
  try {
    const saved = await saveImage({ data: body, mime, originalName, wsId, tabId });
    sendJson(res, 200, { path: saved.path, filename: saved.filename });
  } catch (err) {
    log.error(`upload-image failed: ${err instanceof Error ? err.message : err}`);
    sendJson(res, 500, { error: 'Failed to save image' });
  }
};

/**
 * `/api/upload-file` — accepts any file type, caps at 50 MB, and stores via
 * `saveFile` (keeps the original filename extension).
 */
export const handleFileUpload = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  if (!(await isAuthorized(req))) {
    sendJson(res, 401, { error: 'Unauthorized' });
    req.destroy();
    return;
  }

  const body = await readLimitedBody(req, res, GENERIC_MAX_BYTES, 'File exceeds 50MB');
  if (!body) return;

  const { wsId, tabId, originalName } = readTarget(req);
  try {
    const saved = await saveFile({ data: body, originalName, wsId, tabId });
    sendJson(res, 200, { path: saved.path, filename: saved.filename });
  } catch (err) {
    log.error(`upload-file failed: ${err instanceof Error ? err.message : err}`);
    sendJson(res, 500, { error: 'Failed to save file' });
  }
};

/**
 * Routes the two upload paths to their dedicated handlers. Handled directly in the
 * custom server (before Next.js) so Next's ~10 MiB request-body cap never applies.
 */
export const handleUploadRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  if (pathname === '/api/upload-image') {
    await handleImageUpload(req, res);
    return;
  }
  if (pathname === '/api/upload-file') {
    await handleFileUpload(req, res);
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
};
