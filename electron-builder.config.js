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
    { from: 'resources/claude-dock-mcp.cjs', to: 'claude-dock-mcp.cjs' },
    // Voice plugin Python scripts must live outside app.asar because Python
    // is spawned as a subprocess and cannot read from inside the archive.
    // `asarUnpack` was unreliable here (globbing under `out/**/*` silently
    // dropped these files on the user's install), so we copy them directly
    // into resources/voice-python/ where `process.resourcesPath` resolves
    // them at runtime. electron-vite still copies the same tree into
    // out/main/voice-python/ for `electron-vite dev`.
    { from: 'src/main/plugins/voice/python', to: 'voice-python' }
  ],
  asarUnpack: [
    'node_modules/node-pty/**',
    // uiohook-napi ships a native .node binary per platform; Node cannot
    // require() native modules from inside app.asar, so they must live on disk.
    // Without this, the coordinator's Shift+Shift hotkey silently falls back
    // to the globalShortcut path in packaged builds.
    'node_modules/uiohook-napi/**',
    // @anthropic-ai/claude-agent-sdk ships the Claude Code CLI as a native
    // executable via platform-specific optional-dependency packages
    // (e.g. claude-agent-sdk-win32-x64/claude.exe). The SDK resolves it with
    // require.resolve and then spawns it with child_process — which cannot
    // launch a binary from inside app.asar. The globs below are explicit
    // about the <platform>-<arch> combinations we expect npm to install, so
    // future `@anthropic-ai/claude-agent-sdk-*` siblings (docs, types, etc.)
    // won't be unpacked accidentally. The musl entry is needed for Alpine /
    // musl-libc Linux installs (AppImage), where npm picks the -musl sibling.
    'node_modules/@anthropic-ai/claude-agent-sdk-{win32,darwin,linux}-{x64,arm64}/**',
    'node_modules/@anthropic-ai/claude-agent-sdk-linux-{x64,arm64}-musl/**'
  ],
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
