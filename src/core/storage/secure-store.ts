import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'

type SecretMap = Record<string, string>

export class SecureSecretStore {
  constructor(private readonly filePath: string) {}

  async get(key: string): Promise<string | null> {
    if (!safeStorage.isEncryptionAvailable()) return null
    const secrets = await this.read()
    const encrypted = secrets[key]
    if (!encrypted) return null
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      return null
    }
  }

  async set(key: string, value: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统安全存储当前不可用，不能保存 API Key')
    }
    const secrets = await this.read()
    if (value) {
      secrets[key] = safeStorage.encryptString(value).toString('base64')
    } else {
      delete secrets[key]
    }
    await this.write(secrets)
  }

  async has(key: string): Promise<boolean> {
    return Boolean(await this.get(key))
  }

  private async read(): Promise<SecretMap> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as SecretMap)
        : {}
    } catch {
      return {}
    }
  }

  private async write(secrets: SecretMap): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    await writeFile(temporaryPath, JSON.stringify(secrets), { mode: 0o600 })
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, this.filePath)
  }
}
