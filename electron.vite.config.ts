import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

function fixCjsShimPlugin() {
  return {
    name: 'fix-cjs-shim',
    generateBundle(_: unknown, bundle: Record<string, any>) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk' && chunk.code) {
          chunk.code = chunk.code.replace(
            `import __cjs_mod__ from "node:module";`,
            `import * as __cjs_mod__ from "node:module";`
          )
        }
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), fixCjsShimPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin(), fixCjsShimPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
