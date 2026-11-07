// Writable-directory fallback for read-only hosts (e.g. SnapDeploy's /app).
// Same pattern as FoodScope: use the app directory when it is writable,
// otherwise fall back to a same-named directory under the OS temp dir.
// Exported (not inlined in server.js) so tests can assert the choice
// without booting the server.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function writableBase(dir, fallbackName) {
  try { fs.accessSync(dir, fs.constants.W_OK); return dir; }
  catch { return path.join(os.tmpdir(), fallbackName); }
}

module.exports = { writableBase };
