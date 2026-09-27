import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// react-native ships Flow, which vite cannot parse. Aliasing it to a typed
// stub keeps the tests off the real package and off its two-version pnpm split
// (an in-test vi.mock resolves to a different module id than @daak/core's
// import does, so the mock silently does not apply).
// The `find` is anchored: a bare string alias is a PREFIX match and would also
// swallow deep imports like react-native/Libraries/... (apps/mobile/jest.setup.js
// uses one), silently replacing them with the stub.
export default defineConfig({
  resolve: {
    alias: [{ find: /^react-native$/, replacement: fileURLToPath(new URL('./test/react-native-stub.ts', import.meta.url)) }],
  },
});
