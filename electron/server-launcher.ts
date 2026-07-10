import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const PORT_FILE = path.join(os.homedir(), '.purplemux', 'port');
const DEFAULT_PORT = 8022;
const PORT_BUSY_GRACE_MS = 30_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isPurplemuxServerHealthy = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      res.on('end', () => {
        try {
          const data = JSON.parse(body) as { app?: string };
          resolve(data.app === 'purplemux');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });

const getExistingLocalServerPort = async (): Promise<number | null> => {
  try {
    const raw = fs.readFileSync(PORT_FILE, 'utf-8').trim();
    const port = Number(raw);
    if (!Number.isInteger(port) || port <= 0) return null;
    return (await isPurplemuxServerHealthy(port)) ? port : null;
  } catch {
    return null;
  }
};

const isPortFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });

const waitForServerPort = async (port: number): Promise<void> => {
  let busySince: number | null = null;
  for (;;) {
    if (await getExistingLocalServerPort()) {
      busySince = null;
      await delay(2000);
      continue;
    }
    if (await isPortFree(port)) return;
    // purplemux 서버가 막 바인드했지만 헬스체크가 아직 안 뜨는 부팅 구간과
    // 외부 프로세스 점유를 구분하기 위한 유예 시간
    busySince ??= Date.now();
    if (Date.now() - busySince >= PORT_BUSY_GRACE_MS) {
      console.error(`[server-launcher] port ${port} is in use by another process; exiting`);
      // KeepAlive(SuccessfulExit=false)는 비정상 종료만 재시작하므로 exit 0으로 루프 차단.
      // 다음 로그인 시 RunAtLoad로 재시도한다.
      process.exit(0);
    }
    await delay(2000);
  }
};

const main = async () => {
  await waitForServerPort(parseInt(process.env.PORT || String(DEFAULT_PORT), 10));

  const appDir = process.env.__PMUX_APP_DIR || process.cwd();
  require(path.join(appDir, 'dist', 'server.js')); // eslint-disable-line @typescript-eslint/no-require-imports
};

main().catch((err) => {
  console.error('[server-launcher] failed:', err);
  process.exit(1);
});
