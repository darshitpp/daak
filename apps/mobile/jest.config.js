module.exports = {
  preset: 'react-native',
  // jest's file crawler spawns watchman, which wants a state directory outside
  // the project (and is absent on a clean CI image). node's own crawler is
  // enough for a tree this size, and without this a sandboxed run dies before a
  // single test file is read.
  watchman: false,
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  // ponytail: the `(.pnpm/)?` prefix plus the `[/+@]` suffix handle pnpm's
  // store layout, where every package lives at
  // node_modules/.pnpm/<name>@<version>/node_modules/<name>. The RN template's
  // pattern matches none of those, so RN's Flow-annotated polyfills are left
  // untransformed and jest dies on a type annotation.
  transformIgnorePatterns: [
    'node_modules/(?!(.pnpm/)?(react-native|@react-native|@daak|react|yaml)([/+@]))',
  ],
};
