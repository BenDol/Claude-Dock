import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/userData')
  }
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  logError: vi.fn()
}))

vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([])
}))

import { saveBuffer, loadBuffer, clearBuffer, clearAllBuffers } from '../buffer-store'

describe('buffer-store', () => {
  beforeEach(() => {
    // Only clear call history, keep mock implementations intact
    vi.clearAllMocks()
    // Reset existsSync default to false
    vi.mocked(fs.existsSync).mockReturnValue(false)
  })

  describe('saveBuffer', () => {
    it('creates buffer directory and writes file', () => {
      saveBuffer('session-123', 'buffer data')

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('buffers'),
        { recursive: true }
      )
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('session-123.buf'),
        'buffer data',
        'utf8'
      )
    })

    it('sanitizes session ID for filesystem safety', () => {
      saveBuffer('session/../../etc/passwd', 'data')

      expect(fs.writeFileSync).toHaveBeenCalledTimes(1)
      const filePath = String(vi.mocked(fs.writeFileSync).mock.calls[0][0])
      // Must not contain path traversal characters
      expect(filePath).not.toContain('/../')
      expect(filePath).not.toContain('\\..\\')
      expect(filePath).toMatch(/\.buf$/)
    })

    it('handles write errors gracefully', () => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error('disk full')
      })
      expect(() => saveBuffer('sess', 'data')).not.toThrow()
      // Restore for other tests
      vi.mocked(fs.writeFileSync).mockImplementation(() => {})
    })
  })

  describe('loadBuffer', () => {
    it('returns buffer content when file exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue('saved data')

      const result = loadBuffer('session-123')
      expect(result).toBe('saved data')
    })

    it('returns null when file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)

      const result = loadBuffer('session-123')
      expect(result).toBeNull()
    })

    it('returns null on read error', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('permission denied')
      })

      const result = loadBuffer('session-123')
      expect(result).toBeNull()
      // Restore
      vi.mocked(fs.readFileSync).mockImplementation(() => '')
    })
  })

  describe('clearBuffer', () => {
    it('deletes buffer file when it exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)

      clearBuffer('session-123')
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('session-123.buf')
      )
    })

    it('does nothing when file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)

      clearBuffer('session-123')
      expect(fs.unlinkSync).not.toHaveBeenCalled()
    })

    it('handles delete errors gracefully', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.unlinkSync).mockImplementation(() => {
        throw new Error('file locked')
      })

      expect(() => clearBuffer('sess')).not.toThrow()
      // Restore
      vi.mocked(fs.unlinkSync).mockImplementation(() => {})
    })
  })

  describe('clearAllBuffers', () => {
    it('deletes all .buf files in buffer directory', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readdirSync).mockReturnValue([
        'session-1.buf' as any,
        'session-2.buf' as any,
        'readme.txt' as any
      ])

      clearAllBuffers()
      expect(fs.unlinkSync).toHaveBeenCalledTimes(2) // Only .buf files
    })

    it('does nothing when buffer directory does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)

      clearAllBuffers()
      expect(fs.readdirSync).not.toHaveBeenCalled()
    })

    it('handles errors gracefully', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readdirSync).mockImplementation(() => {
        throw new Error('access denied')
      })

      expect(() => clearAllBuffers()).not.toThrow()
    })
  })
})
