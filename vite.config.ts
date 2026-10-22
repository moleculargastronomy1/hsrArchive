import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { protectedMetadataPlugin } from './scripts/protected-public.mjs';

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'protected' ? [protectedMetadataPlugin()] : [])],
  base: './',
  ...(mode === 'protected'
    ? {
        publicDir: path.resolve('.cache/protected/public'),
        build: { outDir: '.cache/protected/dist', sourcemap: false },
      }
    : {}),
}));
