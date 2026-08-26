import { describe, expect, it } from 'vitest'
import { parseModelList } from '@core/ai/providers/cursor-cli'

describe('Cursor CLI model discovery', () => {
  it('parses the documented human-readable model list without hard-coding ids', () => {
    const models = parseModelList(`Available models

auto - Auto (default)
composer-2.5 - Composer 2.5
gpt-5.6-sol-high-fast - GPT-5.6 Sol High Fast

Tip: use --model <id> to switch.
`)

    expect(models).toEqual([
      { id: 'auto', name: 'Auto' },
      { id: 'composer-2.5', name: 'Composer 2.5' },
      { id: 'gpt-5.6-sol-high-fast', name: 'GPT-5.6 Sol High Fast' }
    ])
  })

  it('ignores unknown lines and ANSI formatting', () => {
    expect(parseModelList('\u001b[32mAvailable models\u001b[0m\nnot a model\n')).toEqual([])
  })
})
