// Run native Node tests using the same host-package aliases as Pi's extension loader.
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const host = '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/';
const require = createRequire(`${host}package.json`);
const aliases = {
  '@earendil-works/pi-coding-agent': `${host}dist/index.js`,
  '@earendil-works/pi-tui': require.resolve('@earendil-works/pi-tui'),
  '@earendil-works/pi-ai': `${host}node_modules/@earendil-works/pi-ai/dist/compat.js`,
  '@earendil-works/pi-agent-core': `${host}node_modules/@earendil-works/pi-agent-core/dist/index.js`,
  '@sinclair/typebox': require.resolve('typebox'),
};
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(aliases[specifier] ? pathToFileURL(aliases[specifier]).href : specifier, context);
} });
