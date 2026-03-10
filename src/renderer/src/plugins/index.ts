// Auto-discover all plugin registrations.
// Any directory under plugins/ with an index.ts will be loaded.
// To add a plugin: create plugins/<name>/index.ts
// To remove a plugin: delete its directory. No other changes needed.
import.meta.glob('./*/index.ts', { eager: true })
