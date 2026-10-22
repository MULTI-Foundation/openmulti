// Traduction OpenAI <-> Anthropic Messages API (spec multi-provider §5).
//
// Anthropic n'est PAS OpenAI-shape : endpoint /v1/messages, system top-level, content
// blocks, tools/tool_use/tool_result, SSE à événements (message_start, content_block_delta…).
// Ce module ne contient QUE des fonctions PURES de mapping (aucune I/O, aucune métrique) —
// testables isolément (règle projet). Le provider (anthropic.ts) les câble + gère
// fetch/coût/flux.
//
// Couvert : messages (system/user/assistant/tool), contenu texte + images, tools +
// tool_choice, max_tokens (REQUIS côté Anthropic), stop -> stop_sequences, hygiène des
// paramètres d'échantillonnage (retirés sur les familles qui les refusent), réponse +
// usage. Le ré-encodage du flux SSE vit dans anthropic.ts (il a besoin du coût).

type Dict = Record<string, unknown>

const PREFIX = 'anthropic/'

/** 'anthropic/claude-sonnet-4-6' (id catalogue) -> 'claude-sonnet-4-6' (id Anthropic). */
export function anthropicModelId(model: string): string {
  return model.startsWith(PREFIX) ? model.slice(PREFIX.length) : model
}

/** Familles qui REFUSENT temperature/top_p/top_k (400) : Opus 4.7/4.8, Fable 5
 * (réf. officielle « reasoning/migration »). Les retirer plutôt que laisser 400. */
function rejectsSampling(id: string): boolean {
  return /^claude-opus-4-[78]/.test(id) || /^claude-fable/.test(id)
}

function asText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && (p as Dict).type === 'text' ? String((p as Dict).text ?? '') : ''))
      .join('')
  }
  return ''
}

/** Bloc(s) de contenu Anthropic pour un message user : texte + images (url ou data: base64). */
function toContentBlocks(content: unknown): unknown {
  if (typeof content === 'string') return content // Anthropic accepte une string directe
  if (!Array.isArray(content)) return ''
  const blocks: Dict[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const p = part as Dict
    if (p.type === 'text') {
      blocks.push(textBlock(p))
    } else if (p.type === 'image_url') {
      const url = String((p.image_url as Dict | undefined)?.url ?? '')
      const m = /^data:([^;]+);base64,(.*)$/.exec(url)
      if (m) blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } })
      else if (url) blocks.push({ type: 'image', source: { type: 'url', url } })
    }
  }
  return blocks
}

function safeJsonObject(s: unknown): Dict {
  if (typeof s !== 'string') return (s && typeof s === 'object' ? (s as Dict) : {})
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' ? (v as Dict) : {}
  } catch {
    return {}
  }
}

/** Bloc texte Anthropic depuis une part OpenAI `{type:'text'}`. Le marqueur de prompt
 * caching `cache_control` (convention OpenRouter/Anthropic, hors schéma OpenAI) passe
 * tel quel : c'est l'appelant qui décide de payer l'écriture (1.25x) pour les relectures
 * (0.1x) — la traduction ne l'ajoute ni ne le retire. */
function textBlock(p: Dict): Dict {
  const block: Dict = { type: 'text', text: String(p.text ?? '') }
  if (p.cache_control && typeof p.cache_control === 'object') block.cache_control = p.cache_control
  return block
}

/** Blocs texte d'un message system : string -> un bloc ; parts -> un bloc par part texte
 * (cache_control conservé). */
function systemBlocks(content: unknown): Dict[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const out: Dict[] = []
  for (const part of content) {
    if (part && typeof part === 'object' && (part as Dict).type === 'text') {
      const b = textBlock(part as Dict)
      if (b.text) out.push(b)
    }
  }
  return out
}

/** Sépare les messages OpenAI en `system` (top-level Anthropic) + `messages` traduits.
 * `system` reste une string (concaténation, comportement historique) SAUF si une part
 * porte `cache_control` : Anthropic n'accepte le marqueur que sur des blocs, le system
 * devient alors un tableau de blocs texte. */
export function splitMessages(msgs: unknown[]): { system: string | Dict[]; messages: Dict[] } {
  const sysBlocks: Dict[] = []
  const out: Dict[] = []
  for (const raw of msgs) {
    if (!raw || typeof raw !== 'object') continue
    const m = raw as Dict
    const role = m.role
    if (role === 'system') {
      sysBlocks.push(...systemBlocks(m.content))
      continue
    }
    if (role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: asText(m.content) }],
      })
      continue
    }
    if (role === 'assistant') {
      const content: Dict[] = []
      const t = asText(m.content)
      if (t) content.push({ type: 'text', text: t })
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls as Dict[]) {
          const fn = (tc.function as Dict | undefined) ?? {}
          content.push({ type: 'tool_use', id: tc.id, name: fn.name, input: safeJsonObject(fn.arguments) })
        }
      }
      out.push({ role: 'assistant', content: content.length ? content : '' })
      continue
    }
    // user (défaut)
    out.push({ role: 'user', content: toContentBlocks(m.content) })
  }
  const cached = sysBlocks.some((b) => b.cache_control !== undefined)
  return { system: cached ? sysBlocks : sysBlocks.map((b) => String(b.text)).join('\n\n'), messages: out }
}

function toAnthropicTool(t: unknown): Dict | undefined {
  if (!t || typeof t !== 'object') return undefined
  const fn = (t as Dict).function as Dict | undefined
  if (!fn || typeof fn.name !== 'string') return undefined
  return { name: fn.name, description: fn.description, input_schema: fn.parameters ?? { type: 'object', properties: {} } }
}

function toAnthropicToolChoice(tc: unknown): Dict | undefined {
  if (tc === 'auto') return { type: 'auto' }
  if (tc === 'required') return { type: 'any' }
  if (tc === 'none') return { type: 'none' }
  if (tc && typeof tc === 'object' && (tc as Dict).type === 'function') {
    const fn = (tc as Dict).function as Dict | undefined
    if (fn?.name) return { type: 'tool', name: fn.name }
  }
  return undefined
}

function toOutputConfig(rf: unknown): Dict | undefined {
  if (!rf || typeof rf !== 'object') return undefined
  const r = rf as Dict
  if (r.type === 'json_schema') {
    const js = r.json_schema as Dict | undefined
    const schema = js?.schema
    if (schema) return { format: { type: 'json_schema', schema } }
  }
  return undefined
}

export interface ToAnthropicOpts {
  defaultMaxTokens: number
  maxTokensCeiling?: number
  /** Auto-marquage `cache_control` (auto-cache.ts, opt-in par objectif) : deux points de
   * cache au plus — la fin du préfixe stable (dernier bloc system, sinon dernier tool) et
   * la fin de la conversation (dernier bloc texte du dernier message user), pour qu'un
   * agent relise tout le tour précédent. Jamais si l'appelant a posé son propre marqueur. */
  autoCache?: boolean
}

const EPHEMERAL = { type: 'ephemeral' }

/** Pose les marqueurs d'auto-cache sur un corps Anthropic déjà construit (mutation). */
export function applyAutoCache(body: Dict): void {
  if (JSON.stringify(body).includes('"cache_control"')) return
  // 1. Préfixe stable : tools -> system (Anthropic met en cache tout ce qui précède le
  //    marqueur, tools compris quand il est sur le system).
  if (typeof body.system === 'string' && body.system) body.system = [{ type: 'text', text: body.system }]
  if (Array.isArray(body.system) && body.system.length) {
    ;(body.system[body.system.length - 1] as Dict).cache_control = { ...EPHEMERAL }
  } else if (Array.isArray(body.tools) && body.tools.length) {
    ;(body.tools[body.tools.length - 1] as Dict).cache_control = { ...EPHEMERAL }
  }
  // 2. Fin de conversation : dernier bloc texte du dernier message user.
  const msgs = Array.isArray(body.messages) ? (body.messages as Dict[]) : []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') {
      if (m.content) m.content = [{ type: 'text', text: m.content, cache_control: { ...EPHEMERAL } }]
      break
    }
    if (Array.isArray(m.content)) {
      const blocks = m.content as Dict[]
      for (let j = blocks.length - 1; j >= 0; j--) {
        if (blocks[j]!.type === 'text') {
          blocks[j]!.cache_control = { ...EPHEMERAL }
          break
        }
      }
    }
    break
  }
}

/** Requête OpenAI chat -> corps Anthropic Messages. */
export function toAnthropicBody(req: Dict, resolvedModel: string, opts: ToAnthropicOpts): Dict {
  const id = anthropicModelId(resolvedModel)
  const { system, messages } = splitMessages(Array.isArray(req.messages) ? req.messages : [])
  const body: Dict = { model: id, messages }
  if (Array.isArray(system) ? system.length : system) body.system = system

  // max_tokens est REQUIS côté Anthropic. Reprend celui de l'appelant, sinon défaut ;
  // borné par le plafond de tier (OM-01) s'il est posé.
  let maxTokens =
    (typeof req.max_tokens === 'number' && req.max_tokens) ||
    (typeof req.max_completion_tokens === 'number' && req.max_completion_tokens) ||
    opts.defaultMaxTokens
  if (opts.maxTokensCeiling && opts.maxTokensCeiling > 0) maxTokens = Math.min(maxTokens, opts.maxTokensCeiling)
  body.max_tokens = maxTokens

  // Échantillonnage : Anthropic refuse temperature ET top_p ensemble (Claude 4+), et
  // refuse les deux + top_k sur les familles 4.7/4.8/Fable. On garde au plus l'un.
  if (!rejectsSampling(id)) {
    if (typeof req.temperature === 'number') body.temperature = req.temperature
    else if (typeof req.top_p === 'number') body.top_p = req.top_p
  }

  if (req.stop != null) body.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop]

  if (Array.isArray(req.tools) && req.tools.length) {
    const tools = req.tools.map(toAnthropicTool).filter(Boolean)
    if (tools.length) body.tools = tools
  }
  if (req.tool_choice != null) {
    const tc = toAnthropicToolChoice(req.tool_choice)
    if (tc) body.tool_choice = tc
  }
  const oc = toOutputConfig(req.response_format)
  if (oc) body.output_config = oc

  if (req.stream === true) body.stream = true
  if (opts.autoCache) applyAutoCache(body)
  return body
}

/** stop_reason Anthropic -> finish_reason OpenAI. */
export function mapStopReason(stop: unknown, hasToolCalls: boolean): string {
  if (hasToolCalls || stop === 'tool_use') return 'tool_calls'
  if (stop === 'max_tokens') return 'length'
  return 'stop' // end_turn, stop_sequence, refusal, pause_turn
}

/** Tokens d'usage Anthropic -> usage OpenAI. prompt_tokens = input + cache_read +
 * cache_creation (le prompt TOTAL, comme chez OpenAI) ; la ventilation cache est
 * exposée dans `prompt_tokens_details` (graphie OpenAI : cached_tokens /
 * cache_write_tokens) pour que l'appelant voie si son cache prend — et pour que la
 * synthèse de coût tarife les tokens cachés au tarif cache (pricing.ts). */
export function anthropicTokens(u: unknown): {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details: { cached_tokens: number; cache_write_tokens: number }
} {
  const usage = (u && typeof u === 'object' ? (u as Dict) : {}) as Record<string, number | undefined>
  const cached = usage.cache_read_input_tokens ?? 0
  const written = usage.cache_creation_input_tokens ?? 0
  const prompt = (usage.input_tokens ?? 0) + cached + written
  const completion = usage.output_tokens ?? 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: written },
  }
}

/** Réponse Anthropic Messages (non-stream) -> chat.completion OpenAI. `cost` (synthétisé
 * par le provider depuis pricing.ts) est attaché s'il est fourni. `created` est passé par
 * l'appelant (le module reste pur). */
export function toOpenAIResponse(data: Dict, model: string, created: number, cost?: number): Dict {
  const blocks = Array.isArray(data.content) ? (data.content as Dict[]) : []
  let text = ''
  const toolCalls: Dict[] = []
  for (const b of blocks) {
    if (b.type === 'text') text += String(b.text ?? '')
    else if (b.type === 'tool_use') {
      toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } })
    }
  }
  const message: Dict = { role: 'assistant', content: text || null }
  if (toolCalls.length) message.tool_calls = toolCalls

  const usage: Dict = anthropicTokens(data.usage)
  if (cost !== undefined) usage.cost = cost

  return {
    id: typeof data.id === 'string' ? data.id : 'chatcmpl',
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: mapStopReason(data.stop_reason, toolCalls.length > 0) }],
    usage,
  }
}
