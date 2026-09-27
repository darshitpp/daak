// The `module:` prefix makes babel resolve the preset from the react-native
// package itself; without it a monorepo resolves the wrong (or no) preset and
// Flow types in RN's own sources are never stripped.
module.exports = { presets: ['module:@react-native/babel-preset'] };
