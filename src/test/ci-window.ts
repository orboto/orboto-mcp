/** ORB-2231 - a wait window that grows fivefold on the loaded shared CI runner; mirrors apps/api/src/test/ci-window.ts and imports no vitest on purpose. */
export function ciWindow(ms: number): number {
  return process.env.CI ? ms * 5 : ms;
}

/** ORB-2587 - the hang guard of one child process: 30 s, 5x on CI; the mcp runner timeout is 30 s unscaled, so a test using it sets its own ciWindow(...) test timeout. */
export function childWindow(): number {
  return ciWindow(30_000);
}
