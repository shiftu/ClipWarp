import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:2547',
        changeOrigin: true,
      },
      '/ws': {
        target: 'http://localhost:2547',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
