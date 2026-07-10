/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');

exports.default = async (context) => {
  const appRoot = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const contents = path.join(appRoot, 'Contents');
  const resources = path.join(contents, 'Resources');
  const unpacked = path.join(resources, 'app.asar.unpacked');

  if (process.platform === 'darwin') {
    const appExecutable = path.join(contents, 'MacOS', context.packager.appInfo.productFilename);
    const nodeExecutable = path.join(resources, 'purplemux-node');
    if (fs.existsSync(appExecutable)) {
      fs.copyFileSync(appExecutable, nodeExecutable);
      fs.chmodSync(nodeExecutable, 0o755);
      console.log('[after-pack] copied Electron node helper');
    }
  }

  if (!fs.existsSync(unpacked)) return;

  const removeBrokenSymlinks = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          fs.statSync(full);
        } catch {
          fs.unlinkSync(full);
        }
      } else if (entry.isDirectory()) {
        removeBrokenSymlinks(full);
      }
    }
  };

  removeBrokenSymlinks(unpacked);
  console.log('[after-pack] removed broken symlinks from app.asar.unpacked');
};
