// Parsing du catalogue OpenRouter (alimente le menu déroulant de l'éditeur de panel).
// On verrouille : ids triés/dédoublonnés, filtrage des modèles sans sortie texte
// (image/audio purs), tolérance aux entrées malformées (-> [], jamais d'exception).

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENROUTER_API_KEY ||= 'x'

const { parseModelIds } = await import('../src/openrouter-catalog.ts')

test('parseModelIds : ids texte triés et dédoublonnés', () => {
  const ids = parseModelIds({
    data: [
      { id: 'qwen/qwen3.5-flash-02-23', architecture: { output_modalities: ['text'] } },
      { id: 'deepseek/deepseek-v4-flash' }, // pas d'architecture -> gardé (défaut texte)
      { id: 'google/gemini-2.5-flash', architecture: { modality: 'text+image->text' } },
      { id: 'qwen/qwen3.5-flash-02-23' }, // doublon
    ],
  })
  assert.deepEqual(ids, [
    'deepseek/deepseek-v4-flash',
    'google/gemini-2.5-flash',
    'qwen/qwen3.5-flash-02-23',
  ])
})

test('parseModelIds : exclut les modèles sans sortie texte (image/audio purs)', () => {
  const ids = parseModelIds({
    data: [
      { id: 'openai/gpt-4o-mini', architecture: { output_modalities: ['text'] } },
      { id: 'google/gemini-2.5-flash-image', architecture: { output_modalities: ['image'] } },
      { id: 'some/audio-only', architecture: { modality: 'text->audio' } },
    ],
  })
  assert.deepEqual(ids, ['openai/gpt-4o-mini'])
})

test('parseModelIds : entrées malformées -> [] (jamais d\'exception)', () => {
  assert.deepEqual(parseModelIds(null), [])
  assert.deepEqual(parseModelIds({}), [])
  assert.deepEqual(parseModelIds({ data: 'nope' }), [])
  assert.deepEqual(parseModelIds({ data: [{ foo: 1 }, { id: 42 }, { id: '' }] }), [])
})
