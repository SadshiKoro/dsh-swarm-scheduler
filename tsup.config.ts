import { defineConfig } from 'tsup'

/** Must equal `package.json` `name`: the web loader keys the module registry on it. */
const PLUGIN_ID = 'dsh-swarm-scheduler'

/**
 * Provided by the DSH web app at load time and reached through the factory's
 * `require`. `react` in particular MUST stay external — a second copy of React
 * in the bundle breaks hooks (`Invalid hook call`).
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-runtime/client',
]

export default defineConfig([
  {
    // Host half. The loader `import()`s this file, so it is a real ES module.
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    dts: false,
    sourcemap: true,
    clean: false,
    splitting: false,
    // Host services come from the running process. Bundling them would put a
    // second copy of cordis in memory: @deepseek-ai/dsh-tools itself does
    // `import { Service } from '@deepseek-ai/cordis'`, so a bundled copy would
    // carry its own Service base class.
    external: [/^@deepseek-ai\//],
    outExtension: () => ({ js: '.js' }),
  },
  {
    // Client half. The web loader evaluates this file as
    //   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
    // — a CommonJS-style factory, NOT an ES module. The banner/footer below are
    // that envelope; `format: 'cjs'` is what makes `require('react')` work.
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    splitting: false,
    external: [...CLIENT_EXTERNALS, /^@deepseek-ai\//],
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    banner: {
      js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
    },
    footer: { js: 'return module.exports; } });' },
    outExtension: () => ({ js: '.js' }),
  },
])
