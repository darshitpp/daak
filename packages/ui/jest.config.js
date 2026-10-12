module.exports = {
  preset: 'react-native',
  // Same reason as apps/mobile/jest.config.js: watchman needs a state dir
  // outside the project and the tests never needed it.
  watchman: false,
  // The screens render slowly on a CI runner with a cold transform cache.
  // The jest default of 5 s and the waitFor default of 1 s fail there.
  testTimeout: 30000,
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testMatch: ['<rootDir>/src/**/*.test.tsx'],
  // Same pnpm-store reason as apps/mobile/jest.config.js: the RN template's
  // pattern matches no package under node_modules/.pnpm/<name>@<ver>/...
  transformIgnorePatterns: [
    'node_modules/(?!(.pnpm/)?(react-native|@react-native|@daak|react|yaml)([/+@]))',
  ],
};
