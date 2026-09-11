import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  utilityProcess: { fork: vi.fn() }
}))

import { aiHostEnvironment } from '@core/ai/host-client'
import { codexEnvironment } from '@core/ai/providers/codex-cli'
import { cursorCliEnvironment } from '@core/ai/providers/cursor-cli'
import { parserHostEnvironment } from '@core/ingestion/parser-host-client'
import {
  buildChildEnvironment,
  WORKLENS_CLI_PATH_ENVIRONMENT_KEYS
} from '@core/security/child-environment'

const sourceEnvironment: NodeJS.ProcessEnv = {
  PATH: '/usr/local/bin:/usr/bin',
  HOME: '/Users/worklens',
  USERPROFILE: 'C:\\Users\\worklens',
  TMPDIR: '/private/tmp',
  TEMP: 'C:\\Temp',
  LANG: 'zh_CN.UTF-8',
  LC_ALL: 'zh_CN.UTF-8',
  SystemRoot: 'C:\\Windows',
  APPDATA: 'C:\\Users\\worklens\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\worklens\\AppData\\Local',
  XDG_CONFIG_HOME: '/Users/worklens/.config',
  CODEX_HOME: '/Users/worklens/.codex-custom',
  NODE_EXTRA_CA_CERTS: '/etc/company-ca.pem',
  WORKLENS_CURSOR_AGENT_PATH: '/opt/cursor/agent',
  WORKLENS_CODEX_PATH: '/opt/codex/codex',
  WORKLENS_DERIVED_ROOT: '/Users/worklens/Library/Application Support/WorkLens/derived',
  OPENAI_API_KEY: 'openai-secret',
  CODEX_API_KEY: 'codex-secret',
  CURSOR_API_KEY: 'cursor-secret',
  ANTHROPIC_API_KEY: 'anthropic-secret',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  AZURE_CLIENT_SECRET: 'azure-secret',
  GITHUB_TOKEN: 'github-secret',
  GOOGLE_APPLICATION_CREDENTIALS: '/private/google-service-account.json',
  WORKLENS_API_KEY: 'worklens-secret',
  WORKLENS_TOKEN_FILE: '/private/token',
  ELECTRON_RUN_AS_NODE: '1',
  NODE_OPTIONS: '--require /tmp/injected.cjs',
  HTTPS_PROXY: 'https://user:password@example.test:8443',
  EMPTY_VALUE: ''
}

describe('child-process environment whitelist', () => {
  it('preserves only the runtime paths and locale needed by local CLI authentication', () => {
    const result = buildChildEnvironment(sourceEnvironment)

    expect(result).toMatchObject({
      PATH: sourceEnvironment.PATH,
      HOME: sourceEnvironment.HOME,
      USERPROFILE: sourceEnvironment.USERPROFILE,
      TMPDIR: sourceEnvironment.TMPDIR,
      TEMP: sourceEnvironment.TEMP,
      LANG: sourceEnvironment.LANG,
      LC_ALL: sourceEnvironment.LC_ALL,
      SystemRoot: sourceEnvironment.SystemRoot,
      APPDATA: sourceEnvironment.APPDATA,
      LOCALAPPDATA: sourceEnvironment.LOCALAPPDATA,
      XDG_CONFIG_HOME: sourceEnvironment.XDG_CONFIG_HOME,
      NODE_EXTRA_CA_CERTS: sourceEnvironment.NODE_EXTRA_CA_CERTS
    })
    expect(result).not.toHaveProperty('CODEX_HOME')
    expect(result).not.toHaveProperty('WORKLENS_CURSOR_AGENT_PATH')
  })

  it('does not expose tokens, cloud credentials, proxy credentials or runtime injection', () => {
    const result = buildChildEnvironment(sourceEnvironment, {
      includeCodexHome: true,
      worklensPathKeys: WORKLENS_CLI_PATH_ENVIRONMENT_KEYS
    })

    expect(result).not.toHaveProperty('OPENAI_API_KEY')
    expect(result).not.toHaveProperty('CODEX_API_KEY')
    expect(result).not.toHaveProperty('CURSOR_API_KEY')
    expect(result).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(result).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
    expect(result).not.toHaveProperty('AZURE_CLIENT_SECRET')
    expect(result).not.toHaveProperty('GITHUB_TOKEN')
    expect(result).not.toHaveProperty('GOOGLE_APPLICATION_CREDENTIALS')
    expect(result).not.toHaveProperty('WORKLENS_API_KEY')
    expect(result).not.toHaveProperty('WORKLENS_TOKEN_FILE')
    expect(result).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(result).not.toHaveProperty('NODE_OPTIONS')
    expect(result).not.toHaveProperty('HTTPS_PROXY')
    expect(result).not.toHaveProperty('EMPTY_VALUE')
  })

  it('adds only explicitly selected WorkLens paths and the Codex login root', () => {
    const result = buildChildEnvironment(sourceEnvironment, {
      includeCodexHome: true,
      worklensPathKeys: WORKLENS_CLI_PATH_ENVIRONMENT_KEYS
    })

    expect(result.CODEX_HOME).toBe('/Users/worklens/.codex-custom')
    expect(result.WORKLENS_CURSOR_AGENT_PATH).toBe('/opt/cursor/agent')
    expect(result.WORKLENS_CODEX_PATH).toBe('/opt/codex/codex')
    expect(result.WORKLENS_DERIVED_ROOT).toBeUndefined()
  })
})

describe('process-specific environment policies', () => {
  it('lets the AI host find both CLIs and their local Codex login state', () => {
    const result = aiHostEnvironment(sourceEnvironment)

    expect(result.CODEX_HOME).toBe('/Users/worklens/.codex-custom')
    expect(result.WORKLENS_CURSOR_AGENT_PATH).toBe('/opt/cursor/agent')
    expect(result.WORKLENS_CODEX_PATH).toBe('/opt/codex/codex')
    expect(result.OPENAI_API_KEY).toBeUndefined()
  })

  it('gives the parser runtime paths without AI login locations', () => {
    const result = parserHostEnvironment(sourceEnvironment)

    expect(result.HOME).toBe('/Users/worklens')
    expect(result.CODEX_HOME).toBeUndefined()
    expect(result.WORKLENS_CODEX_PATH).toBeUndefined()
    expect(result.CURSOR_API_KEY).toBeUndefined()
  })

  it('does not expose the Codex login root to the Cursor CLI', () => {
    const result = cursorCliEnvironment(sourceEnvironment)

    expect(result.HOME).toBe('/Users/worklens')
    expect(result.CODEX_HOME).toBeUndefined()
    expect(result.WORKLENS_CURSOR_AGENT_PATH).toBeUndefined()
    expect(result.CURSOR_API_KEY).toBeUndefined()
  })

  it('keeps CODEX_HOME for Codex local login without passing token variables', () => {
    const result = codexEnvironment(sourceEnvironment)

    expect(result.CODEX_HOME).toBe('/Users/worklens/.codex-custom')
    expect(result.WORKLENS_CODEX_PATH).toBeUndefined()
    expect(result.CODEX_API_KEY).toBeUndefined()
    expect(result.OPENAI_API_KEY).toBeUndefined()
  })
})
