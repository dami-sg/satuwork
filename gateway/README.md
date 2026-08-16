# Satuwork Gateway

Control plane and the only chat UI: companies, accounts, plans, seats, catalogs, JWT, chat proxy, `/v1`.
Default listen port is 3080. Data dir is SATUWORK_GATEWAY_HOME or ~/.satuwork-gateway.

Run with the package dev script after installing workspace deps. Needs Node 24.
Env: GATEWAY_HOST, GATEWAY_PORT, GATEWAY_ACCESS_HOST, GATEWAY_JWT_TTL_SECONDS, GATEWAY_ISS.
Also: GATEWAY_MACHINE_TOKEN, GATEWAY_PLATFORM_TOKEN.
Passwords are scrypt. Credential secrets never appear in list/get or JWT.

控制面 + 聊天 UI：公司、账号、套餐、席位、目录、JWT、按 pair 部署、把 SSE/消息反代到该席位实例。用本包的 dev 脚本启动。

Deploy is per (account, botId) pair, not per account. Seats still count accounts.

LLM proxy (pi-ai lives here). Bot processes call these with a seat API key (`sk_sw_…`); login JWT also works; `sat_…` does not. Upstream keys never leave Gateway:

- GET /v1/models
- POST /v1/chat/completions
- POST /v1/responses
- POST /v1/messages
