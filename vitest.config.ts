import { defineConfig } from "vitest/config"

// Tests run the real CLI as subprocesses; a single test may spawn a dozen.
export default defineConfig({ test: { testTimeout: 60_000 } })
