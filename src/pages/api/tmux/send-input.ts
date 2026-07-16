import type { NextApiRequest, NextApiResponse } from 'next';
import { hasSession, sendLiteralInput, sendRawKeys } from '@/lib/tmux';
import { createLogger } from '@/lib/logger';

const log = createLogger('tmux');

type TInputSequenceItem = string | { type?: unknown; value?: unknown };

interface IInputStep {
  type: 'key' | 'literal';
  value: string;
}

const normalizeSequenceItem = (item: TInputSequenceItem): IInputStep | null => {
  if (typeof item === 'string') return { type: 'key', value: item };
  if (!item || typeof item !== 'object') return null;
  if (item.type !== 'literal' || typeof item.value !== 'string') return null;
  return { type: 'literal', value: item.value };
};

const normalizeSequence = (body: { input?: string; keys?: string[]; sequence?: TInputSequenceItem[] }): IInputStep[] => {
  if (Array.isArray(body.sequence)) {
    return body.sequence.map(normalizeSequenceItem).filter((item): item is IInputStep => item !== null);
  }
  if (Array.isArray(body.keys)) return body.keys.map((value) => ({ type: 'key', value }));
  return body.input != null ? [{ type: 'key', value: body.input }] : [];
};

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { session, input, keys, sequence } = req.body as {
    session?: string;
    input?: string;
    keys?: string[];
    sequence?: TInputSequenceItem[];
  };
  const inputSequence = normalizeSequence({ input, keys, sequence });

  if (!session || inputSequence.length === 0) {
    return res.status(400).json({ error: 'session and input/keys parameters required' });
  }

  const exists = await hasSession(session);
  if (!exists) {
    return res.status(404).json({ error: 'Session not found' });
  }

  try {
    for (const item of inputSequence) {
      if (item.type === 'literal') {
        await sendLiteralInput(session, item.value);
      } else {
        await sendRawKeys(session, item.value);
      }
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    log.error(`send-input failed: ${err instanceof Error ? err.message : err}`);
    return res.status(500).json({ error: 'Failed to send input' });
  }
};

export default handler;
