import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Read a generic password without putting its value in logs or Run events. */
export async function readKeychainSecret(service: string, account = 'helm'): Promise<string | undefined> {
  try {
    const result = await execFileAsync('security', ['find-generic-password', '-a', account, '-s', service, '-w'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024,
    })
    const value = result.stdout.trim()
    return value || undefined
  } catch {
    return undefined
  }
}
