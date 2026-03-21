import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import obfuscatorPlugin from 'vite-plugin-javascript-obfuscator'
import path from 'path'

const host = process.env.TAURI_DEV_HOST

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const obfuscationEnabled =
    mode === 'production' && process.env.EASYCRIS_OBFUSCATE !== '0'

  return {
    plugins: [
      react(),
      tailwindcss(),
      obfuscationEnabled &&
        obfuscatorPlugin({
          include: ['src/**/*.ts', 'src/**/*.tsx'],
          exclude: [
            /node_modules/,
            /e2e/,
            /_test_validation/,
            /\.spec\./,
            /\.test\./,
            /[\\/]store[\\/]/,
            /[\\/]services[\\/]/,
            /[\\/]lib[\\/]analysis[\\/]/,
          ],
          options: {
            compact: true,
            controlFlowFlattening: false,
            controlFlowFlatteningThreshold: 0.0,
            deadCodeInjection: false,
            deadCodeInjectionThreshold: 0.0,
            debugProtection: false,
            disableConsoleOutput: false,
            identifierNamesGenerator: 'hexadecimal',
            log: false,
            numbersToExpressions: false,
            renameGlobals: false,
            selfDefending: false,
            simplify: true,
            splitStrings: false,
            splitStringsChunkLength: 8,
            stringArray: false,
            stringArrayCallsTransform: false,
            stringArrayEncoding: ['base64'],
            stringArrayIndexShift: false,
            stringArrayRotate: false,
            stringArrayShuffle: false,
            stringArrayWrappersCount: 1,
            stringArrayWrappersChainedCalls: false,
            stringArrayWrappersParametersMaxCount: 2,
            stringArrayWrappersType: 'function',
            stringArrayThreshold: 0.0,
            transformObjectKeys: false,
            unicodeEscapeSequence: false,
          },
        }),
    ].filter(Boolean),
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    build: {
      sourcemap: mode === 'development' || mode === 'e2e',
      minify: mode === 'production' ? 'esbuild' : false,
      chunkSizeWarningLimit: 600, // Prevent warnings for template's bundled components
    },
    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: 'ws',
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        // 3. tell vite to ignore watching `src-tauri`
        ignored: ['**/src-tauri/**'],
      },
    },
  }
})
