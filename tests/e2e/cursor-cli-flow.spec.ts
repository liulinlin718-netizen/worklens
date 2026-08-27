import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('uses the authenticated Cursor CLI and automatically analyzes new content', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'worklens-cursor-cli-e2e-'))
  const fakeAgentPath = join(directory, 'agent')
  const analysis = {
    sourceDate: {
      value: '2026-07-16',
      precision: 'day',
      confidence: 0.98,
      rationale: '明确日期'
    },
    events: [
      {
        title: 'Agent 体验评审',
        eventType: '评审',
        eventDate: '2026-07-16',
        datePrecision: 'day',
        summary: '完成 Agent 体验评审。',
        confidence: 0.95,
        evidence: [{ quote: '完成 Agent 体验评审', blockIndex: 0 }]
      }
    ],
    summary: {
      title: '体验评审摘要',
      content: '完成 Agent 体验评审并记录结果。',
      highlights: ['完成体验评审']
    },
    standup: {
      title: '体验评审早会汇报',
      overview: '昨天完成 Agent 体验评审。',
      completed: ['完成 Agent 体验评审'],
      inProgress: [],
      blockers: [],
      nextSteps: ['跟进评审结论'],
      script: '大家早上好，昨天完成了 Agent 体验评审，今天会跟进评审结论，目前没有明显阻塞。'
    }
  }
  writeFileSync(
    fakeAgentPath,
    `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args.includes('--version')) {
  console.log('2026.07.09-test')
} else if (args[0] === 'status') {
  console.log(JSON.stringify({ status: 'authenticated', isAuthenticated: true, message: 'Logged in' }))
} else if (args[0] === 'models') {
  console.log('Available models\\n\\nauto - Auto (default)\\ncomposer-2.5 - Composer 2.5')
} else if (args[0] === 'login') {
  console.log('Logged in')
} else if (args.includes('-p')) {
  const prompt = args[args.length - 1] || ''
  if (prompt.includes('历史工作问答助手')) {
    const knowledge = fs.readFileSync('knowledge.txt', 'utf8')
    const ref = knowledge.match(/【REF (source:[^】]+)】/)?.[1] || ''
    console.log(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: JSON.stringify({
        answer: '你完成了 Agent 体验评审，并记录了评审结果。',
        citations: [{ refId: ref, quote: '2026年7月16日完成 Agent 体验评审。' }],
        suggestedQuestions: ['评审之后还要跟进什么？']
      }),
      session_id: 'knowledge-session'
    }))
  } else {
    console.log(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: JSON.stringify(${JSON.stringify(analysis)}),
      session_id: 'test-session'
    }))
  }
} else {
  process.exitCode = 1
  console.error('unsupported fake agent invocation')
}
`,
    { mode: 0o755 }
  )

  const userData = join(directory, 'user-data')
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...environment } = process.env
  const electronApp = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    env: {
      ...environment,
      NODE_ENV: 'test',
      WORKLENS_CURSOR_AGENT_PATH: fakeAgentPath
    }
  })

  try {
    const page = await electronApp.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()
    const providerInfo = await page.evaluate(async () => {
      const status = await window.worklens.getCursorCliStatus()
      const models = await window.worklens.listCursorCliModels()
      await window.worklens.saveProviderSettings({
        kind: 'cursor_cli',
        model: 'auto',
        baseUrl: '',
        sendImages: false,
        autoAnalyze: true
      })
      const source = await window.worklens.captureText({
        title: '体验评审',
        text: '2026年7月16日完成 Agent 体验评审。',
        businessDate: null
      })
      return { status, models, sourceId: source.id }
    })

    expect(providerInfo.status).toMatchObject({ installed: true, authenticated: true })
    expect(providerInfo.models).toEqual(
      expect.arrayContaining([{ id: 'auto', name: 'Auto' }])
    )
    await expect
      .poll(
        () =>
          page.evaluate(async (sourceId) => {
            const snapshot = await window.worklens.getSnapshot()
            return {
              sourceStatus: snapshot.sources.find((source) => source.id === sourceId)?.status,
              briefs: snapshot.dailyBriefs.length,
              events: snapshot.events.length
            }
          }, providerInfo.sourceId),
        { timeout: 15_000 }
      )
      .toEqual({ sourceStatus: 'ready', briefs: 1, events: 1 })

    await page.getByRole('button', { name: '问工作资料' }).click()
    await page.getByPlaceholder('例如：上个月我在支付项目上完成了什么？').fill('我完成了什么体验评审？')
    await page.getByRole('button', { name: '向本机 AI 提问' }).click()
    await expect(page.getByText('你完成了 Agent 体验评审，并记录了评审结果。')).toBeVisible()
    await expect(page.getByRole('button', { name: /体验评审/ })).toBeVisible()
  } finally {
    await electronApp.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
