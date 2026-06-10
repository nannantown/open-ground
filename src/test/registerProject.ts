import { addImportedProjectEntry } from '../lib/server/registry'

// Register a throwaway dir as a project so the central-store resolver
// (projectUUIDFromPath) can map it to a uuid. Per-project data then lands under
// OPENGROUND_HOME/projects/<uuid>/ (the test home from setup-home.ts), never in
// the dir itself. Returns the assigned project uuid.
export const registerTestProject = async (dir: string): Promise<string> => {
  const r = await addImportedProjectEntry(dir)
  if ('entry' in r) return r.entry.id
  throw new Error(`registerTestProject(${dir}) failed: ${r.rejection}`)
}
