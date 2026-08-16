# Satuwork

Two packages: `bot/` (headless runtime) and `gateway/` (control plane + the only chat UI). Spec: [docs/gateway-runtime.md](docs/gateway-runtime.md)

Deploy is per (account, botId) pair. One Bot process = one bot. Chat goes through Gateway; instances do not serve a product SPA.
