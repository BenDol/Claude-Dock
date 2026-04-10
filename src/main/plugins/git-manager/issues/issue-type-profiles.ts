import type {
  IssueBehavior,
  IssueClassification,
  IssueLabel,
  IssueTypeProfile,
  IssueTypeProfiles
} from '../../../../shared/issue-types'
import { getServices } from '../services'

/**
 * Shipped defaults — cover the most common label conventions across projects.
 * Users can override via the `issueTypeProfilesJson` plugin setting.
 */
export function getDefaultIssueProfiles(): IssueTypeProfiles {
  return {
    profiles: [
      { labelPatterns: ['bug', 'defect', 'regression', 'crash'], behavior: 'fix' },
      { labelPatterns: ['suggestion', 'proposal', 'rfc', 'idea'], behavior: 'collaborate' },
      { labelPatterns: ['question', 'help', 'support', 'discussion'], behavior: 'investigate' },
      { labelPatterns: ['feature', 'enhancement', 'feature-request'], behavior: 'design' },
      { labelPatterns: ['docs', 'documentation'], behavior: 'improve' },
      { labelPatterns: ['chore', 'cleanup', 'refactor', 'tech-debt'], behavior: 'cleanup' }
    ],
    defaultBehavior: 'generic'
  }
}

/**
 * Parse the user's override JSON, falling back to defaults on any error.
 * `''` or missing setting means "use defaults".
 */
export function parseIssueProfiles(json: unknown): IssueTypeProfiles {
  if (json == null || json === '') return getDefaultIssueProfiles()
  if (typeof json !== 'string') return getDefaultIssueProfiles()

  try {
    const parsed = JSON.parse(json) as unknown
    if (!parsed || typeof parsed !== 'object') return getDefaultIssueProfiles()

    const obj = parsed as Record<string, unknown>
    const profiles: IssueTypeProfile[] = []
    const rawProfiles = Array.isArray(obj.profiles) ? obj.profiles : []

    for (const p of rawProfiles) {
      if (!p || typeof p !== 'object') continue
      const entry = p as Record<string, unknown>
      const patterns = Array.isArray(entry.labelPatterns)
        ? (entry.labelPatterns as unknown[]).filter((x): x is string => typeof x === 'string')
        : []
      const behavior = entry.behavior as IssueBehavior
      if (patterns.length === 0 || !isValidBehavior(behavior)) continue
      profiles.push({
        labelPatterns: patterns,
        behavior,
        promptAddendum: typeof entry.promptAddendum === 'string' ? entry.promptAddendum : undefined
      })
    }

    const defaultBehavior = isValidBehavior(obj.defaultBehavior as IssueBehavior)
      ? (obj.defaultBehavior as IssueBehavior)
      : 'generic'

    // If parsing produced nothing usable, fall back so we never end up with an empty taxonomy.
    if (profiles.length === 0 && defaultBehavior === 'generic') return getDefaultIssueProfiles()

    return { profiles, defaultBehavior }
  } catch (err) {
    getServices().logError('[issue-type-profiles] parse error, using defaults:', err)
    return getDefaultIssueProfiles()
  }
}

export function serializeIssueProfiles(profiles: IssueTypeProfiles): string {
  return JSON.stringify(profiles, null, 2)
}

const VALID_BEHAVIORS: IssueBehavior[] = [
  'fix',
  'investigate',
  'design',
  'improve',
  'cleanup',
  'collaborate',
  'generic'
]

function isValidBehavior(x: unknown): x is IssueBehavior {
  return typeof x === 'string' && VALID_BEHAVIORS.includes(x as IssueBehavior)
}

/**
 * Classify an issue against the profile table. Matching is case-insensitive;
 * patterns ending in '*' act as prefix wildcards ('bug*' matches 'bug' and 'bugfix').
 * First-match wins across all profiles in declaration order.
 */
export function classifyIssue(
  labels: Array<IssueLabel | string>,
  profiles: IssueTypeProfiles
): IssueClassification {
  const labelNames = labels
    .map((l) => (typeof l === 'string' ? l : l.name || ''))
    .filter(Boolean)
    .map((n) => n.toLowerCase())

  for (const profile of profiles.profiles) {
    for (const rawPattern of profile.labelPatterns) {
      const pattern = rawPattern.toLowerCase()
      const isPrefix = pattern.endsWith('*')
      const stem = isPrefix ? pattern.slice(0, -1) : pattern
      for (const label of labelNames) {
        const match = isPrefix ? label.startsWith(stem) : label === stem
        if (match) {
          return {
            behavior: profile.behavior,
            source: 'label',
            promptAddendum: profile.promptAddendum
          }
        }
      }
    }
  }

  return { behavior: profiles.defaultBehavior, source: 'default' }
}

/**
 * Human-readable description for each behavior — used by the Claude prompt builder.
 */
export function describeBehavior(behavior: IssueBehavior): string {
  switch (behavior) {
    case 'fix':
      return 'This is a bug. Reproduce it, locate the root cause, implement the minimal correct fix, and add a regression test. Verify the fix before finalizing.'
    case 'investigate':
      return 'This is a question. Research the codebase, produce a definitive written answer with citations to files and line numbers, and propose documentation updates if the answer reveals a gap.'
    case 'design':
      return 'This is a feature request. Propose an architecture, list trade-offs and alternatives, and confirm the approach with the developer BEFORE implementing. Do not start coding until aligned.'
    case 'improve':
      return 'This is an improvement (often docs or minor code polish). Preserve existing behavior exactly; tighten wording, code, or structure only.'
    case 'cleanup':
      return 'This is a chore (refactor, cleanup, tech-debt). Keep the scope rigorously tight — no functional changes. If you find unrelated issues, note them and leave them alone.'
    case 'collaborate':
      return 'This is a suggestion from a contributor. Summarize the proposal in your own words, list open questions or risks, and implement only the uncontroversial pieces. For anything subjective, stop and ask.'
    case 'generic':
    default:
      return 'The issue type is unclear. Read the body and comments carefully, classify it yourself, and ask the developer to confirm before taking significant action.'
  }
}
