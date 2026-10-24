import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Os testes compartilham o mesmo emulador: rodar em série evita que um
    // `clearFirestore()` apague os dados de outro teste no meio.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
