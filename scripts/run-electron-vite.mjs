import { spawn } from 'node:child_process'

const mode = process.argv[2] || 'dev'
const allowedModes = new Set(['dev', 'preview'])
if (!allowedModes.has(mode)) {
  console.error(`Modo invalido: ${mode}. Usa: dev | preview`)
  process.exit(1)
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const command = process.platform === 'win32' ? 'cmd.exe' : 'sh'
const args = process.platform === 'win32'
  ? ['/d', '/s', '/c', `npx electron-vite ${mode}`]
  : ['-lc', `npx electron-vite ${mode}`]

const child = spawn(command, args, {
  stdio: 'inherit',
  env,
  shell: false
})

child.on('exit', (code, signal) => {
  if (typeof code === 'number') process.exit(code)
  if (signal) {
    console.error(`electron-vite termino por senal: ${signal}`)
    process.exit(1)
  }
  process.exit(1)
})

child.on('error', (err) => {
  console.error('No se pudo iniciar electron-vite:', err)
  process.exit(1)
})
