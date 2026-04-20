/**
 * electron-builder config — profile-aware packaging.
 *
 * Pass DOCK_ENV_PROFILE=uat (default) or DOCK_ENV_PROFILE=prod to select which
 * identity the packaged artifact takes on. The profile drives appId,
 * productName, artifact filename, and an embedded `buildEnvProfile` flag in
 * package.json so the running binary can self-identify at install time.
 *
 * `dev` is explicitly rejected — dev builds are meant to be run from source via
 * `electron-vite dev`, never packaged.
 */

const envProfile = process.env.DOCK_ENV_PROFILE || 'uat'

if (envProfile === 'dev') {
  throw new Error('electron-builder: DOCK_ENV_PROFILE=dev is not packageable. Use `electron-vite dev` instead.')
}
if (envProfile !== 'uat' && envProfile !== 'prod') {
  throw new Error(`electron-builder: unknown DOCK_ENV_PROFILE='${envProfile}' (expected 'uat' or 'prod')`)
}

// --- Profile-driven identity ---
// UAT preserves legacy identifiers so existing installs upgrade in place.
// Prod gets fresh identifiers and installs side-by-side.
const appId = envProfile === 'uat' ? 'com.claude.dock' : 'com.claude.dock.prod'
const productName = envProfile === 'uat' ? 'Claude Dock' : 'Claude Dock Stable'
const artifactBase = envProfile === 'uat' ? 'Claude-Dock' : 'Claude-Dock-Stable'

module.exports = {
  appId,
  productName,
  icon: 'assets/icon',
  files: ['out/**/*'],
  extraMetadata: {
    // Surfaced in the installed package.json so runtime code can sanity-check
    // what profile this binary was built under (cross-references __ENV_PROFILE__).
    buildEnvProfile: envProfile
  },
  extraResources: [
    { from: 'resources/claude-dock-mcp.cjs', to: 'claude-dock-mcp.cjs' }
  ],
  asarUnpack: ['node_modules/node-pty/**'],
  win: {
    icon: 'assets/icon.png',
    target: ['nsis', 'portable'],
    extraResources: [
      { from: 'resources/llm/win/llama-server.exe', to: 'llm/llama-server.exe' }
    ],
    // Per-profile artifact names keep prod + uat installers from colliding in
    // the dist/ folder and on the releases page.
    artifactName: `${artifactBase}-\${version}-Setup.\${ext}`
  },
  nsis: {
    include: 'build/installer.nsh',
    // Separate install dirs per profile so `%ProgramFiles%\Claude Dock` and
    // `%ProgramFiles%\Claude Dock Stable` coexist. Per-user install
    // (perMachine: false) matches the pre-profile default.
    perMachine: false
  },
  portable: {
    artifactName: `${artifactBase}-\${version}.Portable.\${ext}`
  },
  afterSign: 'scripts/notarize.js',
  mac: {
    icon: 'assets/icon.png',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    target: [{ target: 'dmg', arch: ['universal'] }],
    extraResources: [
      { from: 'resources/llm/mac/llama-server', to: 'llm/llama-server' }
    ],
    artifactName: `${artifactBase}-\${version}.\${ext}`
  },
  linux: {
    icon: 'assets/icon.png',
    target: ['AppImage'],
    extraResources: [
      { from: 'resources/llm/linux/llama-server', to: 'llm/llama-server' }
    ],
    artifactName: `${artifactBase}-\${version}.\${ext}`
  }
}
