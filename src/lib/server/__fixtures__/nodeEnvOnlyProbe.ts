// Probe for the "NODE_ENV=test alone must not arm the fence" teeth
// (testHomeGuard.test.ts). 2026-07-20: detectTestProcess() used to OR in
// `process.env.NODE_ENV === 'test'`, a generic convention ambient shells and
// unrelated tools export and leave exported — unlike VITEST/VITEST_WORKER_ID.
// A packaged Electron launch inheriting a stray NODE_ENV=test would arm the
// fail-closed fence and THROW resolving the real home, crashing production at
// boot for no reason connected to any actual test run.
//
// Runs as a CHILD PROCESS because isTestProcess() latches TEST_AT_IMPORT once
// at module load — an in-process vi.stubEnv can't reproduce "this process
// never had a VITEST marker at all" once the running suite's own VITEST=1 has
// already latched true.
//
// Writes nothing: it only asks isTestProcess()/assertTestHomeIsolated() for a
// verdict, never touches the filesystem.
import { homedir, userInfo } from 'os'
import { join } from 'path'
import { assertTestHomeIsolated, isTestProcess } from '../testHomeGuard'

const passwd = (() => {
  try {
    return userInfo().homedir
  } catch {
    return homedir()
  }
})()

let armedAgainstRealHome: 'REFUSED' | 'ALLOWED'
try {
  assertTestHomeIsolated(join(passwd, '.openground'), 'nodeEnvOnlyProbe')
  armedAgainstRealHome = 'ALLOWED'
} catch {
  armedAgainstRealHome = 'REFUSED'
}

process.stdout.write(
  JSON.stringify({
    isTestProcess: isTestProcess(),
    armedAgainstRealHome,
  }),
)
