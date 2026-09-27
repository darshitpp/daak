module.exports = {
  preset: 'react-native',
  testMatch: ['<rootDir>/src/**/*.test.tsx'],
  setupFilesAfterEnv: ['@testing-library/react-native/extend-expect'],
  // Same pnpm-store reason as apps/mobile/jest.config.js: the RN template's
  // pattern matches no package under node_modules/.pnpm/<name>@<ver>/...
  transformIgnorePatterns: [
    'node_modules/(?!(.pnpm/)?(react-native|@react-native|@daak|react)([/+@]))',
  ],
};
