// Access-path resolution (docs/MULTI-PROVIDER-SPEC.md §4): given a resolved model id
// (vendor/model), pick the Provider that will carry the call. The vendor prefix is NOT
// the access path: anthropic/claude-* may go through OpenRouter or (later) Anthropic
// direct. Default: everything goes through OpenRouter (iso). A direct path is opt-in
// per vendor via OPENMULTI_PROVIDER_<VENDOR>=direct AND requires its API key — missing
// key = silent fallback to OpenRouter, so flipping the env alone can never break a call.

import { config } from '../config.js'
import { openRouterProvider } from './openrouter.js'
import { moonshotProvider } from './moonshot.js'
import type { Provider } from './types.js'

// Lu une fois au boot, comme le reste de la config.
const moonshotDirect =
  process.env.OPENMULTI_PROVIDER_MOONSHOTAI === 'direct' && config.moonshot.apiKey !== ''

export function providerFor(model: string): Provider {
  if (moonshotDirect && model.startsWith('moonshotai/')) return moonshotProvider
  return openRouterProvider
}

export type { Provider, UpstreamCall } from './types.js'
