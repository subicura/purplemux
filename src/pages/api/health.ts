import type { NextApiRequest, NextApiResponse } from 'next';
import pkg from '../../../package.json';

const handler = (_req: NextApiRequest, res: NextApiResponse) => {
  res.json({ app: 'purplemux', version: pkg.version });
};

export default handler;
