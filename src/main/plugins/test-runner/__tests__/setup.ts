import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export interface TestDir {
  root: string
  cleanup: () => void
}

/** Create an isolated temp directory for testing */
export function createTestDir(): TestDir {
  const root = path.join(os.tmpdir(), `test-runner-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(root, { recursive: true })
  return {
    root,
    cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ } }
  }
}

/** Write a file in a test directory, creating parent dirs */
export function writeFile(dir: string, relPath: string, content: string): void {
  const absPath = path.join(dir, relPath)
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  fs.writeFileSync(absPath, content, 'utf-8')
}

/** Create a standard Vitest project layout */
export function createVitestProject(dir: string): void {
  writeFile(dir, 'package.json', JSON.stringify({
    name: 'test-project',
    devDependencies: { vitest: '^1.0.0' }
  }))
  writeFile(dir, 'vitest.config.ts', 'export default {}')
}

/** Create a standard Maven JUnit project layout */
export function createMavenProject(dir: string): void {
  writeFile(dir, 'pom.xml', `<?xml version="1.0"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>test</artifactId>
  <dependencies>
    <dependency>
      <groupId>junit</groupId>
      <artifactId>junit</artifactId>
    </dependency>
  </dependencies>
</project>`)
}

/** Create a standard Gradle JUnit project layout */
export function createGradleProject(dir: string): void {
  writeFile(dir, 'build.gradle.kts', `
plugins { java }
dependencies {
  testImplementation("org.junit.jupiter:junit-jupiter:5.9.0")
}
tasks.test { useJUnitPlatform() }
`)
}

/** Create a sample JS/TS test file with describe/it blocks */
export function createVitestFile(dir: string, relPath: string): void {
  writeFile(dir, relPath, `import { describe, it, expect } from 'vitest'

describe('MathUtils', () => {
  it('should add numbers', () => {
    expect(1 + 1).toBe(2)
  })

  it('should subtract numbers', () => {
    expect(5 - 3).toBe(2)
  })

  describe('edge cases', () => {
    it('handles zero', () => {
      expect(0 + 0).toBe(0)
    })
  })
})

test('standalone test', () => {
  expect(true).toBe(true)
})
`)
}

/** Create a sample Java test file */
export function createJavaTestFile(dir: string, relPath: string, className: string, pkg: string): void {
  writeFile(dir, relPath, `package ${pkg};

import org.junit.Test;
import static org.junit.Assert.*;

public class ${className} {
    @Test
    public void testAddition() {
        assertEquals(4, 2 + 2);
    }

    @Test
    public void testSubtraction() {
        assertEquals(2, 5 - 3);
    }

    public void helperMethod() {
        // Not a test — no @Test annotation
    }
}
`)
}
