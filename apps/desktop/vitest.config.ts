import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pngStub = {
  name: 'png-stub',
  enforce: 'pre' as const,
  load(id: string) {
    return id.endsWith('.png') ? 'export default 1;' : null;
  },
};

export default defineConfig({
  plugins: [pngStub],
  resolve: {
    // react-native ships Flow, which vite cannot parse. Aliasing it to a typed
    // stub keeps the tests off the real package. It is needed because
    // test/direct-share-contract.spec.ts imports the REAL mobile parser
    // (apps/mobile/src/deeplink.ts), which imports { Linking } from
    // 'react-native'. Same anchored alias packages/platform already uses: the
    // `find` is anchored on purpose, because a bare string alias is a PREFIX
    // match and would also swallow deep imports.
    alias: [{ find: /^react-native$/, replacement: fileURLToPath(new URL('./test/react-native-stub.ts', import.meta.url)) }],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
  },
});
