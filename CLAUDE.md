# Project notes

## Preferences
- **"Open a browser" always means the user's LOCAL Chrome (Chrome 149)** — unless the user
  explicitly says otherwise. Do not silently fall back to a remote/headless cloud browser; if a
  local-Chrome/CDP MCP isn't reachable from the current environment, say so instead of using a
  different browser.

## Publish guards (hard rules, enforced in `supliful_update_product` on status=ACTIVE)
- **Selling stores (MAXima, MAXimo):** a product may go ACTIVE only if EVERY variant has a
  Supliful SKU AND its inventory is stocked at "Supliful Fulfillment" (`assertSuplifulReady`).
  Otherwise refuse and return a clear 🛑 BLOCKED error; product stays DRAFT.
- **Gateway store (GenoMAX Gateway):** non-selling. ANY product→ACTIVE is refused outright
  (`assertSellableStore`, matches `/gateway/i` on store name). Stays DRAFT.
- Both blocks also `console.error` a `[GUARD] ...` line for server-side logging.
- Second, complementary enforcement layer: a separate `supliful-publish-guard` webhook server
  (repo `hemichaeli/supliful-publish-guard`, its own Railway service) catches publishes from ANY
  source via Shopify webhooks and reverts violators to DRAFT. Currently guards MAXima + MAXimo only
  (NOT GenoMAX Gateway), and only logs — no prominent alert. Lives outside this repo.

## Deploy (Railway)
- Service `supliful-mcp-server` (project `supliful-mcp-server`, env `production`) auto-deploys from
  GitHub `main` — native Railway GitHub integration. This was broken for a while (the "All →
  Specific" repo-access token-staleness bug); fixed by reconnecting the Railway GitHub App. A push
  to `main` now triggers a single native deploy.
- Manual fallback if native ever breaks again: set/change an inert Railway variable (e.g.
  `DEPLOY_NONCE`) via the Railway MCP to force a rebuild of latest `main`, then remove it. The
  Railway MCP `trigger_latest_deploy` tool is broken (uses a removed `deploymentCreate` mutation).
- Live API version is `2025-01` (env `SHOPIFY_API_VERSION`), not the code default `2025-07`.
