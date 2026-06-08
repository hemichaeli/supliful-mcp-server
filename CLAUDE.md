# Project notes

## Preferences
- **"Open a browser" always means the user's LOCAL Chrome (Chrome 149)** — unless the user
  explicitly says otherwise. Do not silently fall back to a remote/headless cloud browser; if a
  local-Chrome/CDP MCP isn't reachable from the current environment, say so instead of using a
  different browser.

## Deploy (Railway)
- Service `supliful-mcp-server` (project `supliful-mcp-server`, env `production`) auto-deploy from
  GitHub `main` is currently NOT firing reliably. Until the GitHub→Railway trigger is fixed in the
  dashboard, force a redeploy of latest `main` by setting/changing an inert Railway variable
  (e.g. `DEPLOY_NONCE`) via the Railway MCP, then remove it. `trigger_latest_deploy` is broken.
- Live API version is `2025-01` (env `SHOPIFY_API_VERSION`), not the code default `2025-07`.
