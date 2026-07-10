import { describe, expect, it } from 'vitest';
import { PassThrough } from 'stream';
import { readBodyWithLimit, UploadError } from '@/lib/upload-handler';

const streamOf = (chunks: Buffer[]): PassThrough => {
  const stream = new PassThrough();
  // Listeners are attached synchronously by readBodyWithLimit before this runs.
  queueMicrotask(() => {
    for (const chunk of chunks) stream.write(chunk);
    stream.end();
  });
  return stream;
};

describe('readBodyWithLimit', () => {
  it('resolves the full body when under the limit', async () => {
    const body = await readBodyWithLimit(streamOf([Buffer.alloc(100, 1), Buffer.alloc(50, 2)]), 1000);
    expect(body.length).toBe(150);
  });

  it('rejects with PAYLOAD_TOO_LARGE when the body exceeds the limit', async () => {
    await expect(readBodyWithLimit(streamOf([Buffer.alloc(2000)]), 1000)).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });
  });

  it('rejects across multiple chunks once the cumulative size passes the limit', async () => {
    const chunks = [Buffer.alloc(600), Buffer.alloc(600)];
    await expect(readBodyWithLimit(streamOf(chunks), 1000)).rejects.toBeInstanceOf(UploadError);
  });

  it('rejects with TRUNCATED when the stream ends before Content-Length', async () => {
    await expect(readBodyWithLimit(streamOf([Buffer.alloc(100)]), 1000, 200)).rejects.toMatchObject({
      code: 'TRUNCATED',
    });
  });

  it('resolves when received bytes match the expected Content-Length', async () => {
    const body = await readBodyWithLimit(streamOf([Buffer.alloc(200)]), 1000, 200);
    expect(body.length).toBe(200);
  });

  it('does not treat a complete body as truncated when no Content-Length is given', async () => {
    const body = await readBodyWithLimit(streamOf([Buffer.alloc(10)]), 1000);
    expect(body.length).toBe(10);
  });
});
