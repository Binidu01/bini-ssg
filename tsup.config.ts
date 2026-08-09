import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: {
    resolve: true,
  },
  clean: true,
  sourcemap: true,
  minify: false,
  target: 'node18',
  platform: 'node',
  splitting: false,
  external: ['vite', 'react', 'react-dom', 'react-router-dom', 'tsx'],
  skipNodeModulesBundle: true,
})