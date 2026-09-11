const RUNTIME_ENVIRONMENT_KEYS = new Set([
  'PATH',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERPROFILE',
  'USER',
  'USERNAME',
  'LOGNAME',
  'TMP',
  'TEMP',
  'TMPDIR',
  'LANG',
  'LANGUAGE',
  'TZ',
  'SHELL',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  '__CF_USER_TEXT_ENCODING',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS'
])

const SENSITIVE_ENVIRONMENT_KEY =
  /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH)(?:_|$)/

export const WORKLENS_CLI_PATH_ENVIRONMENT_KEYS = [
  'WORKLENS_CURSOR_AGENT_PATH',
  'WORKLENS_CODEX_PATH'
] as const

export type WorkLensPathEnvironmentKey =
  (typeof WORKLENS_CLI_PATH_ENVIRONMENT_KEYS)[number]

interface ChildEnvironmentOptions {
  includeCodexHome?: boolean
  worklensPathKeys?: readonly WorkLensPathEnvironmentKey[]
}

/**
 * Builds a least-privilege environment for a trusted WorkLens child process.
 *
 * Home/config roots are retained so official CLIs can use their own local login
 * state. Ambient API keys, cloud credentials, proxy credentials and runtime
 * injection flags are intentionally excluded.
 */
export function buildChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  options: ChildEnvironmentOptions = {}
): NodeJS.ProcessEnv {
  const allowedKeys = new Set(RUNTIME_ENVIRONMENT_KEYS)
  if (options.includeCodexHome) allowedKeys.add('CODEX_HOME')
  for (const key of options.worklensPathKeys ?? []) allowedKeys.add(key)

  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => {
      if (!value) return false
      const normalizedKey = key.toUpperCase()
      if (SENSITIVE_ENVIRONMENT_KEY.test(normalizedKey)) return false
      return allowedKeys.has(normalizedKey) || normalizedKey.startsWith('LC_')
    })
  )
}
