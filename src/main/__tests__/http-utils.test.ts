import { describe, it, expect } from 'vitest'
import { extractHostname } from '../http-utils'

describe('http-utils', () => {
  describe('extractHostname', () => {
    it('extracts hostname from HTTPS URL', () => {
      expect(extractHostname('https://github.com/user/repo')).toBe('github.com')
    })

    it('extracts hostname from URL with path', () => {
      expect(extractHostname('https://raw.githubusercontent.com/user/repo/main/file.json'))
        .toBe('raw.githubusercontent.com')
    })

    it('extracts hostname from URL with port', () => {
      expect(extractHostname('https://localhost:3000/api')).toBe('localhost')
    })

    it('returns null for invalid URL', () => {
      expect(extractHostname('not-a-url')).toBeNull()
    })

    it('returns null for empty string', () => {
      expect(extractHostname('')).toBeNull()
    })

    it('extracts hostname from HTTP URL', () => {
      expect(extractHostname('http://example.com/path')).toBe('example.com')
    })
  })
})
