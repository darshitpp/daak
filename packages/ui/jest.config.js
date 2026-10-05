module.exports = {
  preset: 'react-native',
  // Same reason as apps/mobile/jest.config.js: watchman needs a state dir
  // outside the project and the tests never needed it.
  watchman: false,
  testMatch: ['<rootDir>/src/**/*.test.tsx'],
  // Same pnpm-store reason as apps/mobile/jest.config.js: the RN template's
  // pattern matches no package under node_modules/.pnpm/<name>@<ver>/...
  transformIgnorePatterns: [
    'node_modules/(?!(.pnpm/)?(react-native|@react-native|@daak|react|yaml)([/+@]))',
  ],
};
