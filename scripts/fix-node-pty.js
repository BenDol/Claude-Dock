// Fixes node-pty build issues on Windows:
// 1. Spectre mitigation requirement (needs VS Spectre libs installed)
// 2. GetCommitHash.bat path issue (NoDefaultCurrentDirectoryInExePath)
const fs = require('fs')
const path = require('path')

const nodePtyDir = path.join(__dirname, '..', 'node_modules', 'node-pty')

// Fix 1: Disable Spectre mitigation in binding.gyp
const bindingGyp = path.join(nodePtyDir, 'binding.gyp')
if (fs.existsSync(bindingGyp)) {
  let content = fs.readFileSync(bindingGyp, 'utf8')
  content = content.replace(/'SpectreMitigation': 'Spectre'/g, "'SpectreMitigation': 'false'")
  fs.writeFileSync(bindingGyp, content)
  console.log('Fixed: binding.gyp Spectre mitigation disabled')
}

// Fix 2: winpty.gyp - Spectre mitigation + bat file paths
const winptyGyp = path.join(nodePtyDir, 'deps', 'winpty', 'src', 'winpty.gyp')
if (fs.existsSync(winptyGyp)) {
  let content = fs.readFileSync(winptyGyp, 'utf8')
  content = content.replace(/'SpectreMitigation': 'Spectre'/g, "'SpectreMitigation': 'false'")
  content = content.replace(/cd shared && GetCommitHash\.bat/g, 'cd shared && .\\\\GetCommitHash.bat')
  content = content.replace(/cd shared && UpdateGenVersion\.bat/g, 'cd shared && .\\\\UpdateGenVersion.bat')
  fs.writeFileSync(winptyGyp, content)
  console.log('Fixed: winpty.gyp Spectre + bat paths')
}

console.log('node-pty build fixes applied.')
