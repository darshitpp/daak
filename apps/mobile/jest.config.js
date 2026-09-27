module.exports = {
  preset: 'react-native',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  // ponytail: the `(.pnpm/)?` prefix plus the `[/+@]` suffix handle pnpm's
  // store layout, where every package lives at
  // node_modules/.pnpm/<name>@<version>/node_modules/<name>. The RN template's
  // pattern matches none of those, so RN's Flow-annotated polyfills are left
  // untransformed and jest dies on a type annotation.
  transformIgnorePatterns: [
    'node_modules/(?!(.pnpm/)?(react-native|@react-native|@daak|react)([/+@]))',
  ],
};
