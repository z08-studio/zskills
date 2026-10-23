import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PORT ?? 4173),
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.ZSKILLS_API_PORT ?? 4174}`,
        // Preserve the browser origin so the Rust service can validate mutations.
        changeOrigin: false,
      },
    },
  },
  build: { outDir: 'dist/client', emptyOutDir: true },
});
