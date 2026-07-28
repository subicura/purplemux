import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { describe, expect, it } from 'vitest';
import { CodexParser, parseCodexContent, readCodexEntriesBefore, readTailCodexEntries } from '@/lib/session-parser-codex';
import { UPLOADS_DIR } from '@/lib/uploads-store';

const codexUserLine = (idx: number) => JSON.stringify({
  timestamp: `2026-05-02T07:37:${String(idx).padStart(2, '0')}.000Z`,
  type: 'event_msg',
  payload: {
    type: 'user_message',
    message: `message ${idx}`,
  },
});

describe('parseCodexContent', () => {
  it('maps Codex local_images under uploads to served image URLs', () => {
    const imagePath = path.join(UPLOADS_DIR, 'ws-1', 'tab-1', 'image.png');
    const line = {
      timestamp: '2026-05-02T07:37:12.642Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: '[Image #1] describe this',
        images: [],
        local_images: [imagePath, '/tmp/outside.png'],
      },
    };

    const entries = parseCodexContent(JSON.stringify(line) + '\n');

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: 'user-message',
      text: '[Image #1] describe this',
      images: ['/api/uploads/ws-1/tab-1/image.png'],
    });
  });

  it('uses context_compacted event_msg and ignores top-level compacted records', () => {
    const compacted = {
      timestamp: '2026-05-02T11:34:43.788Z',
      type: 'compacted',
      payload: {
        replacement_history: [],
      },
    };
    const eventMsg = {
      timestamp: '2026-05-02T11:34:43.796Z',
      type: 'event_msg',
      payload: {
        type: 'context_compacted',
      },
    };

    const entries = parseCodexContent(`${JSON.stringify(compacted)}\n${JSON.stringify(eventMsg)}\n`);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: 'context-compacted',
    });
  });

  it('reads Codex tail entries with byte-offset pagination', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'purplemux-codex-tail-'));
    const jsonlPath = path.join(dir, 'session.jsonl');
    try {
      await fs.writeFile(
        jsonlPath,
        Array.from({ length: 10 }, (_, i) => codexUserLine(i + 1)).join('\n') + '\n',
        'utf-8',
      );

      const initial = await readTailCodexEntries(jsonlPath, 3);
      expect(initial.hasMore).toBe(true);
      expect(initial.startByteOffset).toBeGreaterThan(0);
      expect(initial.entries.map((entry) => entry.type === 'user-message' ? entry.text : '')).toEqual([
        'message 8',
        'message 9',
        'message 10',
      ]);

      const expanded = await readCodexEntriesBefore(jsonlPath, initial.startByteOffset, 2);
      expect(expanded.hasMore).toBe(true);
      expect(expanded.entries.map((entry) => entry.type === 'user-message' ? entry.text : '')).toEqual([
        'message 6',
        'message 7',
        'message 8',
        'message 9',
        'message 10',
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('replays warmup lines when expanding a Codex page', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'purplemux-codex-warmup-'));
    const jsonlPath = path.join(dir, 'session.jsonl');
    try {
      const lines = [
        {
          timestamp: '2026-05-02T07:38:01.000Z',
          type: 'event_msg',
          payload: { type: 'exec_command_begin', call_id: 'exec-1', command: 'pnpm test' },
        },
        {
          timestamp: '2026-05-02T07:38:02.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'older 1' },
        },
        {
          timestamp: '2026-05-02T07:38:03.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'older 2' },
        },
        {
          timestamp: '2026-05-02T07:38:04.000Z',
          type: 'event_msg',
          payload: { type: 'exec_command_end', call_id: 'exec-1', exit_code: 0, stdout: 'ok' },
        },
      ].map((line) => JSON.stringify(line));

      await fs.writeFile(jsonlPath, lines.join('\n') + '\n', 'utf-8');

      const initial = await readTailCodexEntries(jsonlPath, 1);
      expect(initial.entries).toHaveLength(1);
      expect(initial.entries[0]).toMatchObject({
        type: 'exec-command-stream',
        command: 'pnpm test',
      });

      const expanded = await readCodexEntriesBefore(jsonlPath, initial.startByteOffset, 1);
      expect(expanded.entries).toHaveLength(2);
      expect(expanded.entries[0]).toMatchObject({ type: 'user-message', text: 'older 2' });
      expect(expanded.entries[1]).toMatchObject({
        type: 'exec-command-stream',
        command: 'pnpm test',
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('suppresses Codex write_stdin tool calls and outputs', () => {
    const call = {
      timestamp: '2026-05-02T11:40:00.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'call-1',
        name: 'write_stdin',
        arguments: JSON.stringify({ session_id: 123, chars: '', yield_time_ms: 1000 }),
      },
    };
    const output = {
      timestamp: '2026-05-02T11:40:01.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-1',
        output: '456',
      },
    };

    const entries = parseCodexContent(`${JSON.stringify(call)}\n${JSON.stringify(output)}\n`);

    expect(entries).toHaveLength(0);
  });

  it('shows commands nested in Codex exec custom tool calls', () => {
    const call = {
      timestamp: '2026-05-02T11:41:00.000Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: 'call-exec-1',
        name: 'exec',
        status: 'completed',
        input: [
          'const results = await Promise.all([',
          '  tools.exec_command({ cmd: "pnpm tsc --noEmit", workdir: "/workspace" }),',
          '  tools.exec_command({ cmd: `pnpm lint`, workdir: "/workspace" }),',
          ']);',
          'text(results);',
        ].join('\n'),
      },
    };

    const entries = parseCodexContent(`${JSON.stringify(call)}\n`);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: 'tool-call',
      toolName: 'Bash',
      summary: '$ pnpm tsc --noEmit\n$ pnpm lint',
      status: 'success',
    });
  });

  it('uses a bounded source preview for dynamic Codex exec commands', () => {
    const call = {
      timestamp: '2026-05-02T11:42:00.000Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: 'call-exec-2',
        name: 'exec',
        status: 'completed',
        input: [
          'const commands = ["pnpm test", "pnpm lint"];',
          'await Promise.all(commands.map((cmd) => tools.exec_command({ cmd, workdir: "/workspace" })));',
          `text("${'x'.repeat(1_000)}");`,
        ].join('\n'),
      },
    };

    const entries = parseCodexContent(`${JSON.stringify(call)}\n`);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: 'tool-call',
      toolName: 'Bash',
      status: 'success',
    });
    if (entries[0].type !== 'tool-call') throw new Error('Expected a tool call');
    expect(entries[0].summary).toContain('exec_command (dynamic)');
    expect(entries[0].summary).toContain('pnpm test');
    expect(entries[0].summary.length).toBeLessThan(400);
  });

  it('does not extract fake commands from strings or comments', () => {
    const call = {
      timestamp: '2026-05-02T11:43:00.000Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: 'call-exec-3',
        name: 'exec',
        status: 'completed',
        input: [
          'const sample = \'tools.exec_command({ cmd: "rm -rf fake" })\';',
          '// tools.exec_command({ cmd: "rm -rf comment" });',
          'const result = await tools.update_plan({ plan: [] });',
          'text(result);',
        ].join('\n'),
      },
    };

    const entries = parseCodexContent(`${JSON.stringify(call)}\n`);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: 'tool-call',
      toolName: 'exec',
      summary: 'exec → update_plan',
    });
  });

  it('bounds Codex exec input scanning and fallback size', () => {
    const call = {
      timestamp: '2026-05-02T11:44:00.000Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: 'call-exec-4',
        name: 'exec',
        status: 'completed',
        input: `const padding = "${'x'.repeat(70_000)}";\ntools.exec_command({ cmd: "must-not-scan" });`,
      },
    };

    const entries = parseCodexContent(`${JSON.stringify(call)}\n`);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: 'tool-call',
      toolName: 'exec',
    });
    if (entries[0].type !== 'tool-call') throw new Error('Expected a tool call');
    expect(entries[0].summary).not.toContain('must-not-scan');
    expect(entries[0].summary.length).toBeLessThan(350);
  });

  it('preserves UTF-8 messages across tail pagination', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'purplemux-codex-utf8-'));
    const jsonlPath = path.join(dir, 'session.jsonl');
    try {
      const messages = [
        '안녕하세요 1',
        'emoji 😀 2',
        'mixed 한글 😀 3',
        '最後のメッセージ 4',
      ];
      const lines = messages.map((message, idx) => JSON.stringify({
        timestamp: `2026-05-02T07:41:0${idx}.000Z`,
        type: 'event_msg',
        payload: { type: 'user_message', message },
      }));
      await fs.writeFile(jsonlPath, lines.join('\n') + '\n', 'utf-8');

      const initial = await readTailCodexEntries(jsonlPath, 2);
      expect(initial.entries.map((entry) => entry.type === 'user-message' ? entry.text : '')).toEqual([
        'mixed 한글 😀 3',
        '最後のメッセージ 4',
      ]);

      const expanded = await readCodexEntriesBefore(jsonlPath, initial.startByteOffset, 2);
      expect(expanded.entries.map((entry) => entry.type === 'user-message' ? entry.text : '')).toEqual(messages);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps incremental partial JSONL in pendingBuffer until complete', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'purplemux-codex-incremental-'));
    const jsonlPath = path.join(dir, 'session.jsonl');
    try {
      const parser = new CodexParser(jsonlPath);
      await fs.writeFile(jsonlPath, '', 'utf-8');

      const partial = JSON.stringify({
        timestamp: '2026-05-02T07:42:00.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'partial message' },
      });
      await fs.writeFile(jsonlPath, partial.slice(0, -8), 'utf-8');

      const first = await parser.parseIncremental();
      expect(first.newEntries).toHaveLength(0);
      expect(first.pendingBuffer).toBe(partial.slice(0, -8));

      await fs.writeFile(jsonlPath, partial + '\n', 'utf-8');
      const second = await parser.parseIncremental();
      expect(second.pendingBuffer).toBe('');
      expect(second.newEntries).toHaveLength(1);
      expect(second.newEntries[0]).toMatchObject({
        type: 'user-message',
        text: 'partial message',
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('resets incremental state when the Codex JSONL file is truncated', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'purplemux-codex-truncate-'));
    const jsonlPath = path.join(dir, 'session.jsonl');
    try {
      const parser = new CodexParser(jsonlPath);
      await fs.writeFile(
        jsonlPath,
        [
          codexUserLine(1),
          codexUserLine(2),
        ].join('\n') + '\n',
        'utf-8',
      );

      const first = await parser.parseIncremental();
      expect(first.newEntries.map((entry) => entry.type === 'user-message' ? entry.text : '')).toEqual([
        'message 1',
        'message 2',
      ]);

      await fs.writeFile(jsonlPath, codexUserLine(9) + '\n', 'utf-8');
      const second = await parser.parseIncremental();
      expect(second.newEntries.map((entry) => entry.type === 'user-message' ? entry.text : '')).toEqual([
        'message 9',
      ]);
      expect(second.pendingBuffer).toBe('');
      expect(second.newOffset).toBe(Buffer.byteLength(codexUserLine(9) + '\n', 'utf-8'));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps completed exec entries when begin/end span a pagination boundary', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'purplemux-codex-boundary-'));
    const jsonlPath = path.join(dir, 'session.jsonl');
    try {
      const lines = [
        {
          timestamp: '2026-05-02T07:43:01.000Z',
          type: 'event_msg',
          payload: { type: 'exec_command_begin', call_id: 'exec-1', command: 'pnpm test' },
        },
        ...Array.from({ length: 6 }, (_, idx) => ({
          timestamp: `2026-05-02T07:43:0${idx + 2}.000Z`,
          type: 'event_msg',
          payload: { type: 'user_message', message: `filler ${idx + 1}` },
        })),
        {
          timestamp: '2026-05-02T07:43:09.000Z',
          type: 'event_msg',
          payload: { type: 'exec_command_end', call_id: 'exec-1', exit_code: 0, stdout: 'ok' },
        },
      ].map((line) => JSON.stringify(line));

      await fs.writeFile(jsonlPath, lines.join('\n') + '\n', 'utf-8');

      const initial = await readTailCodexEntries(jsonlPath, 1);
      expect(initial.entries).toHaveLength(1);
      expect(initial.entries[0]).toMatchObject({
        type: 'exec-command-stream',
        command: 'pnpm test',
        status: 'success',
      });

      const expanded = await readCodexEntriesBefore(jsonlPath, initial.startByteOffset, 3);
      expect(expanded.entries.at(-1)).toMatchObject({
        type: 'exec-command-stream',
        command: 'pnpm test',
        status: 'success',
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
