/**
 * Apply the schema.ts SQL builders through the repository SQL runner.
 * Temporary SQL is deleted afterward; this script does not modify seed files.
 */
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { actionDefinitions, buildActionMetadataSql } from './schema.ts'

// Resolve the workspace independently of the directory from which this script was launched.
const root = fileURLToPath(new URL('../../../', import.meta.url))
const directory = await mkdtemp(join(tmpdir(), 'ontology-action-schema-'))
const sqlPath = join(directory, 'actions.sql')
try {
  await writeFile(sqlPath, buildActionMetadataSql(), { mode: 0o600 })
// The child process loads the root .env; SQL generation itself needs no database credentials.
  const result = spawnSync('pnpm', ['run-sql', sqlPath], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`run-sql failed (${result.signal ?? result.status})`)
  console.log(`Applied ${actionDefinitions.length} action definitions from schema.ts`)
// Always remove generated SQL, including when execution fails.
} finally {
  await unlink(sqlPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  await rmdir(directory)
}
