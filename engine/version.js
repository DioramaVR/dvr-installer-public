// Versions: the app's own, and ordering mod/app versions ("0.2.0", "2026.11.01").
// The ordering is dvr-package's: one implementation for the whole format.
const { compareVersions } = require('dvr-package').version;

function appVersion() {
  return require('../package.json').version;
}

module.exports = { appVersion, compareVersions };
