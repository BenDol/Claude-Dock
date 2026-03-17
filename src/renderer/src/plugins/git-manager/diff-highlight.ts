import hljs from 'highlight.js'
import type { GitDiffHunk } from '../../../../shared/git-manager-types'

const MAX_LINES = 3000

const EXT_MAP: Record<string, string> = {
  // Web / JS ecosystem
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript', json: 'json', json5: 'json',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', xhtml: 'xml', xsl: 'xml', xslt: 'xml',
  css: 'css', scss: 'scss', less: 'less', sass: 'scss', styl: 'stylus',
  coffee: 'coffeescript', litcoffee: 'coffeescript',
  hbs: 'handlebars', handlebars: 'handlebars',
  haml: 'haml', twig: 'twig', erb: 'erb',
  // Python
  py: 'python', pyw: 'python', pyi: 'python',
  // Ruby
  rb: 'ruby',
  // Rust
  rs: 'rust',
  // Go
  go: 'go',
  // JVM
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', groovy: 'groovy', gradle: 'groovy',
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure',
  // .NET
  cs: 'csharp', fs: 'fsharp', fsx: 'fsharp', vb: 'vbnet', vbs: 'vbscript',
  // C / C++
  c: 'c', h: 'c', cpp: 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp', hxx: 'cpp', hh: 'cpp',
  // Apple
  m: 'objectivec', mm: 'objectivec', swift: 'swift',
  // PHP
  php: 'php',
  // Scripting
  lua: 'lua', r: 'r', jl: 'julia', dart: 'dart',
  tcl: 'tcl', awk: 'awk',
  // GameMaker
  gml: 'gml',
  // Game / shader
  glsl: 'glsl', vert: 'glsl', frag: 'glsl', hlsl: 'glsl', shader: 'glsl',
  sqf: 'sqf',
  // Shell
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  bat: 'dos', cmd: 'dos',
  // SQL
  sql: 'sql', pgsql: 'pgsql',
  // Perl
  pl: 'perl', pm: 'perl',
  // Functional
  hs: 'haskell', lhs: 'haskell',
  ex: 'elixir', exs: 'elixir', erl: 'erlang', hrl: 'erlang',
  ml: 'ocaml', mli: 'ocaml', re: 'reasonml', rei: 'reasonml',
  elm: 'elm', sml: 'sml',
  lisp: 'lisp', el: 'lisp', scm: 'scheme', ss: 'scheme',
  // Systems / low-level
  zig: 'zig', nim: 'nim', d: 'd', cr: 'crystal', wren: 'wren',
  v: 'verilog', sv: 'verilog', vhd: 'vhdl', vhdl: 'vhdl',
  asm: 'x86asm', s: 'armasm',
  wasm: 'wasm', wat: 'wasm',
  // Markup / config
  md: 'markdown', mdx: 'markdown',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  tex: 'latex', ltx: 'latex', bib: 'latex',
  properties: 'properties',
  // Infrastructure / DevOps
  dockerfile: 'dockerfile', makefile: 'makefile',
  tf: 'hcl', hcl: 'hcl', nix: 'nix',
  nginx: 'nginx',
  // Data / interchange
  proto: 'protobuf', graphql: 'graphql', gql: 'graphql',
  thrift: 'thrift',
  xq: 'xquery', xquery: 'xquery',
  // Pascal / Delphi
  pas: 'delphi', dpr: 'delphi', pp: 'delphi',
  // Fortran
  f: 'fortran', f90: 'fortran', f95: 'fortran', for: 'fortran',
  // Other
  vim: 'vim', vimrc: 'vim',
  cmake: 'cmake',
  ada: 'ada', adb: 'ada', ads: 'ada',
  pro: 'prolog',
  pony: 'pony',
  hx: 'haxe', hxml: 'haxe',
  ahk: 'autohotkey',
  au3: 'autoit',
  nsi: 'nsis', nsh: 'nsis',
  qml: 'qml',
  vala: 'vala', vapi: 'vala',
  m4: 'matlab', mat: 'matlab',
  nb: 'mathematica', wl: 'mathematica',
  sas: 'sas', do: 'stata', dta: 'stata',
  stan: 'stan',
  scad: 'openscad',
  ino: 'arduino', pde: 'processing',
  as: 'actionscript',
  applescript: 'applescript', scpt: 'applescript',
  coq: 'coq',
  purs: 'haskell',
  lsl: 'lsl',
}

const BASENAME_MAP: Record<string, string> = {
  Dockerfile: 'dockerfile', Makefile: 'makefile',
  Jenkinsfile: 'groovy', Vagrantfile: 'ruby',
  Gemfile: 'ruby', Rakefile: 'ruby',
  CMakeLists: 'cmake',
  Cakefile: 'coffeescript',
  Guardfile: 'ruby',
  Thorfile: 'ruby',
  Berksfile: 'ruby',
  Fastfile: 'ruby',
  Podfile: 'ruby',
  Brewfile: 'ruby',
  SConstruct: 'python', SConscript: 'python',
  Procfile: 'bash',
  Justfile: 'makefile',
  Taskfile: 'yaml',
}

export function getLanguageFromPath(filePath: string): string | null {
  const basename = filePath.split('/').pop() || filePath
  // Check basename (without extension) first for special filenames
  const nameNoExt = basename.includes('.') ? basename.slice(0, basename.lastIndexOf('.')) : basename
  if (BASENAME_MAP[basename]) return BASENAME_MAP[basename]
  if (BASENAME_MAP[nameNoExt]) return BASENAME_MAP[nameNoExt]

  const ext = basename.includes('.') ? basename.slice(basename.lastIndexOf('.') + 1).toLowerCase() : ''
  if (!ext) return null
  return EXT_MAP[ext] ?? null
}

/**
 * Balance HTML span tags so each line is self-contained.
 * highlight.js produces spans that can cross line boundaries (multi-line strings, block comments).
 * After splitting on \n, we must prepend unclosed tags and close them at end of each line.
 */
function balanceTags(lines: string[]): string[] {
  const openTagRe = /<span\b[^>]*>/g
  const closeTagRe = /<\/span>/g
  const result: string[] = []
  let openStack: string[] = [] // stack of opening tags carried from previous lines

  for (const line of lines) {
    // Prepend unclosed tags from previous line
    const prefix = openStack.join('')
    const full = prefix + line

    // Recompute open stack from this full line
    const newStack: string[] = []
    let m: RegExpExecArray | null
    const tagRe = /<span\b[^>]*>|<\/span>/g
    while ((m = tagRe.exec(full)) !== null) {
      if (m[0] === '</span>') {
        newStack.pop()
      } else {
        newStack.push(m[0])
      }
    }

    // Close any unclosed tags at end of this line
    const suffix = '</span>'.repeat(newStack.length)
    result.push(full + suffix)
    openStack = newStack
  }

  return result
}

/**
 * Highlight raw code content and return highlighted HTML per line.
 * Returns null if the language is unknown.
 */
export function highlightCode(filePath: string, code: string): string[] | null {
  const language = getLanguageFromPath(filePath)
  if (!language || !hljs.getLanguage(language)) return null
  const lines = code.split('\n')
  if (lines.length > MAX_LINES) return null
  const highlighted = hljs.highlight(code, { language, ignoreIllegals: true })
  return balanceTags(highlighted.value.split('\n'))
}

/**
 * Highlight diff hunks and return highlighted HTML per line, matching hunk/line structure.
 * Returns null if the language is unknown or total lines exceed the limit.
 */
export function highlightDiffHunks(
  filePath: string,
  hunks: GitDiffHunk[]
): string[][] | null {
  const language = getLanguageFromPath(filePath)
  if (!language) return null

  // Check if hljs knows this language
  if (!hljs.getLanguage(language)) return null

  // Count total lines and bail if too large
  let totalLines = 0
  for (const h of hunks) totalLines += h.lines.length
  if (totalLines > MAX_LINES) return null

  // Highlight each hunk independently so that code skipped between hunks
  // (e.g. unclosed block comments, template strings) doesn't poison later hunks.
  const result: string[][] = []
  for (const h of hunks) {
    const content = h.lines.map(l => l.content).join('\n')
    const highlighted = hljs.highlight(content, { language, ignoreIllegals: true })
    result.push(balanceTags(highlighted.value.split('\n')))
  }

  return result
}
