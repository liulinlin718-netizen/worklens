import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    quit: vi.fn(),
    on: vi.fn(),
    whenReady: () => new Promise<void>(() => undefined)
  },
  BrowserWindow: class BrowserWindow {
    static getAllWindows(): unknown[] {
      return []
    }
  },
  clipboard: {},
  dialog: {},
  ipcMain: {},
  Menu: {},
  safeStorage: {},
  session: {},
  shell: {}
}))

import { getDevelopmentRendererUrl, isTrustedRendererUrl } from '../../src/main/index'

const rendererPath = '/Applications/WorkLens.app/Contents/Resources/app.asar/out/renderer/index.html'

describe('Electron renderer trust boundary', () => {
  it('uses an HTTP(S) development URL only outside packaged builds', () => {
    expect(getDevelopmentRendererUrl(false, 'http://127.0.0.1:5173')).toBe(
      'http://127.0.0.1:5173/'
    )
    expect(getDevelopmentRendererUrl(false, 'https://localhost:5173/app')).toBe(
      'https://localhost:5173/app'
    )
    expect(getDevelopmentRendererUrl(true, 'http://127.0.0.1:5173')).toBeUndefined()
  })

  it('rejects invalid or credential-bearing development URLs', () => {
    expect(getDevelopmentRendererUrl(false, 'file:///tmp/renderer.html')).toBeUndefined()
    expect(getDevelopmentRendererUrl(false, 'javascript:alert(1)')).toBeUndefined()
    expect(getDevelopmentRendererUrl(false, 'https://example.test/app')).toBeUndefined()
    expect(getDevelopmentRendererUrl(false, 'http://user:secret@localhost:5173')).toBeUndefined()
    expect(getDevelopmentRendererUrl(false, 'not a URL')).toBeUndefined()
  })

  it('matches the configured development document exactly', () => {
    const developmentUrl = 'http://localhost:5173'
    expect(isTrustedRendererUrl('http://localhost:5173/', false, developmentUrl, rendererPath)).toBe(
      true
    )
    expect(
      isTrustedRendererUrl('http://localhost:5173/other', false, developmentUrl, rendererPath)
    ).toBe(false)
    expect(
      isTrustedRendererUrl('http://localhost:5173.evil.test/', false, developmentUrl, rendererPath)
    ).toBe(false)
    expect(
      isTrustedRendererUrl('http://localhost:5173/?embedded=true', false, developmentUrl, rendererPath)
    ).toBe(false)
  })

  it('trusts only the packaged renderer file in packaged builds', () => {
    const expected = pathToFileURL(rendererPath).href
    expect(isTrustedRendererUrl(expected, true, 'http://localhost:5173', rendererPath)).toBe(true)
    expect(
      isTrustedRendererUrl('http://localhost:5173/', true, 'http://localhost:5173', rendererPath)
    ).toBe(false)
    expect(
      isTrustedRendererUrl(pathToFileURL('/tmp/untrusted.html').href, true, undefined, rendererPath)
    ).toBe(false)
    expect(isTrustedRendererUrl(`${expected}?other=1`, true, undefined, rendererPath)).toBe(false)
    expect(isTrustedRendererUrl(`${expected}#other`, true, undefined, rendererPath)).toBe(false)
  })

  it('does not accept URL prefix lookalikes or malformed values', () => {
    const expected = pathToFileURL(rendererPath).href
    expect(isTrustedRendererUrl(`${expected}.evil`, true, undefined, rendererPath)).toBe(false)
    expect(isTrustedRendererUrl('', true, undefined, rendererPath)).toBe(false)
    expect(isTrustedRendererUrl('not a URL', true, undefined, rendererPath)).toBe(false)
  })
})
