import hljs from 'highlight.js'
import type { GitDiffHunk } from '../../../../shared/git-manager-types'

const MAX_LINES = 3000

const EXT_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript', json: 'json', json5: 'json',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', xhtml: 'xml',
  css: 'css', scss: 'scss', less: 'less', sass: 'scss',
  py: 'python', pyw: 'python', pyi: 'python',
  rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
  kt: 'kotlin', kts: 'kotlin', scala: 'scala', groovy: 'groovy',
  cs: 'csharp', fs: 'fsharp', vb: 'vbnet',
  c: 'c', h: 'c', cpp: 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp', hxx: 'cpp',
  m: 'objectivec', mm: 'objectivec', swift: 'swift',
  php: 'php', lua: 'lua', r: 'r', jl: 'julia', dart: 'dart',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  ps1: 'powershell', psm1: 'powershell',
  sql: 'sql', pl: 'perl', pm: 'perl',
  md: 'markdown', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
  dockerfile: 'dockerfile', makefile: 'makefile',
  ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell',
  clj: 'clojure', cljs: 'clojure', lisp: 'lisp', el: 'lisp',
  vim: 'vim', tf: 'hcl', hcl: 'hcl', nix: 'nix',
  zig: 'zig', v: 'verilog', vhd: 'vhdl', vhdl: 'vhdl',
  proto: 'protobuf', graphql: 'graphql', gql: 'graphql',
  bat: 'dos', cmd: 'dos',
  gradle: 'groovy',
}

const BASENAME_MAP: Record<string, string> = {
  Dockerfile: 'dockerfile', Makefile: 'makefile',
  Jenkinsfile: 'groovy', Vagrantfile: 'ruby',
  Gemfile: 'ruby', Rakefile: 'ruby',
  CMakeLists: 'cmake',
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

  // Join all line contents (strip the diff +/- prefix — content field already lacks it)
  const allContent = hunks.flatMap(h => h.lines.map(l => l.content))
  const joined = allContent.join('\n')

  // Highlight
  const highlighted = hljs.highlight(joined, { language, ignoreIllegals: true })
  const htmlLines = balanceTags(highlighted.value.split('\n'))

  // Split back into hunk/line structure
  const result: string[][] = []
  let idx = 0
  for (const h of hunks) {
    const hunkLines: string[] = []
    for (let i = 0; i < h.lines.length; i++) {
      hunkLines.push(htmlLines[idx++] || '')
    }
    result.push(hunkLines)
  }

  return result
}
