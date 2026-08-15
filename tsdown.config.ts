import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    server: 'src/server.ts',
    startup: 'src/startup.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  fixedExtension: false,
  platform: 'node',
  target: 'node22.19',
  dts: true,
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: [/^@deepseek-ai\//, /^node:/, 'commander'],
  },
})
