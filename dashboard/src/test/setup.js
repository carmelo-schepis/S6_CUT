// Global test setup: jest-dom matchers + cleanup between tests.
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
  // Some legacy suites (taste, apiToken) swap in their own minimal
  // localStorage stub without .clear(); don't let cleanup explode on it.
  try {
    window.localStorage?.clear?.()
  } catch {
    /* jsdom teardown edge — nothing to clear */
  }
})
