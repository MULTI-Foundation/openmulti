// Access-path resolution (docs/MULTI-PROVIDER-SPEC.md §4): given a resolved model id
// (vendor/model), pick the Provider that will carry the call. The vendor prefix is NOT
// the access path: anthropic/claude-* may go through OpenRouter or (later) Anthropic
// direct. v0 has a single path — everything goes through OpenRouter. Direct providers
// land here (spec step 3), gated by OPENMULTI_PROVIDER_<VENDOR> env + their API key,
// with a silent fallback to OpenRouter so the default stays iso.

import { openRouterProvider } from './openrouter.js'
import type { Provider } from './types.js'

export function providerFor(_model: string): Provider {
  return openRouterProvider
}

export type { Provider, UpstreamCall } from './types.js'
