import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['electron/main.ts', 'electron/preload.ts', 'electron/server-launcher.ts'],
  format: ['cjs'],
  target: 'node20',
  outDir: 'dist-electron',
  clean: true,
  external: ['electron'],
  noExternal: ['electron-updater', 'builder-util-runtime'],
});
