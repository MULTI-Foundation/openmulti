<div align="center">

# OpenMulti

### The open multi-intelligence layer

**Send a request. OpenMulti selects the best model for you among hundreds.**
It learns your context and gets smarter over time. Open source. No lock-in.

[**🌐 Website**](https://multifoundation.io/openmulti-landing) · [**📖 Docs**](https://docs.openmulti.ai) · [**🚀 Get started**](https://docs.openmulti.ai)

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-4f8ef7.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![Maintained by Multi Foundation](https://img.shields.io/badge/maintained%20by-Multi%20Foundation-4f8ef7.svg)](https://multifoundation.io)

</div>

---

## What is OpenMulti?

OpenMulti is an **intelligence layer**, not just a gateway. Where a gateway proxies your
requests, OpenMulti understands your business and orchestrates intelligence across hundreds
of models — selecting the most *relevant* model for each request, not the most expensive.

```python
# Change one line. OpenMulti handles the rest.
from openai import OpenAI

client = OpenAI(
    base_url="https://api.openmulti.ai/v1",
    api_key="sk_..."
)

response = client.chat.completions.create(
    model="auto",  # OpenMulti selects the best model
    messages=[{"role": "user", "content": "..."}]
)

# response.model  = "claude-sonnet-4.6"
# response.reason = "legal context, reasoning priority"
```

It's a **drop-in replacement** for the OpenAI SDK: point your `base_url` at
`api.openmulti.ai`, keep your existing code, and start routing across 200+ models.

## How it works

| | | |
|---|---|---|
| **01 · Connect** | **02 · Route** | **03 · Learn** |
| Point your existing OpenAI SDK to `api.openmulti.ai`. Your code doesn't change. | Every request is scored across quality, cost, speed, and domain expertise — the best model wins. | OpenMulti learns your context and builds your business profile automatically. The more you use it, the better it routes. |

No setup required. OpenMulti observes your usage, learns your context, and progressively
optimizes routing for your specific needs.

## Why OpenMulti

- **◉ Contextual value routing** — It doesn't just route by cost or speed. It understands your business context, domain, and constraints, and optimizes for the value delivered to *you*.
- **⚙ Multi-model composition** — Complex tasks are decomposed and routed to multiple specialized models. One reasons, another verifies, a third formats. No single provider can do this.
- **◆ Continuous quality monitoring** — Detects model quality degradation in real time and reroutes automatically. When a provider silently updates a model, OpenMulti adapts before you notice.
- **☆ Open source, no lock-in** — Apache 2.0. Build on it, fork it, audit it. Your data stays yours. Your business profile is portable. No single entity controls the protocol.

## Models

OpenMulti routes across all major providers and open-source models — **hundreds of models, one endpoint.** A sample of what's available:

| Model | Provider | Context | Input | Output | Best for |
|---|---|---|---|---|---|
| Claude Opus 4.6 | Anthropic | 200K | $5.00/M | $25.00/M | Reasoning · Agentic |
| Claude Sonnet 4.6 | Anthropic | 200K | $3.00/M | $15.00/M | Reasoning · Code |
| GPT-5.4 | OpenAI | 1M | $2.50/M | $15.00/M | Reasoning · Vision |
| Gemini 3.1 Pro | Google | 2M | $2.00/M | $12.00/M | Reasoning · Long context |
| Mistral Large 3 | Mistral | 128K | $2.00/M | $6.00/M | Creative · Multilingual |
| Claude Haiku 4.5 | Anthropic | 200K | $1.00/M | $5.00/M | Speed · Cost |
| DeepSeek V3 | DeepSeek | 128K | $0.14/M | $0.28/M | Cost · Code |
| Llama 4 Maverick | Meta | 1M | $0.20/M | $0.60/M | Cost · Speed |

> OpenMulti routes across **200+ models**. You never have to choose.

## Build on OpenMulti

Like Linux, anyone can build on the same open kernel.

- **`</>` SDK & API** — OpenAI-compatible. Change your base URL, keep your code. Client libraries for Python, TypeScript, Go and Rust. → [Get started](https://docs.openmulti.ai/sdk)
- **⚙ Distributions** — Build your own offering on top of OpenMulti. Your brand, your clients, your rules. One shared open kernel — like Ubuntu, Red Hat, or Debian. → [Distribution guide](https://docs.openmulti.ai/distributions)
- **☆ Contribute** — Propose features, submit extensions, report issues, or build integrations for the community. → [Contributing](#contributing)

## Contributing

OpenMulti is open source under the Apache 2.0 license and welcomes contributions from the
community. Whether it's a feature proposal, a bug report, a new integration, or a model
adapter — open an [issue](https://github.com/MULTI-Foundation/openmulti/issues) or a pull
request to get started.

## License

Licensed under the [Apache License 2.0](LICENSE).

---

<div align="center">

OpenMulti is developed and maintained by [**Multi Foundation**](https://multifoundation.io).

[Website](https://multifoundation.io/openmulti-landing) · [Docs](https://docs.openmulti.ai) · [Multi Foundation](https://multifoundation.io)

</div>
