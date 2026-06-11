import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import http from "http";

// ─── Multi-store config ──────────────────────────────────────────────────────
// Supports up to 3 stores via:
//   STORE1_DOMAIN, STORE1_TOKEN, STORE1_NAME (optional label)
//   STORE2_DOMAIN, STORE2_TOKEN, STORE2_NAME
//   STORE3_DOMAIN, STORE3_TOKEN, STORE3_NAME
// Legacy single-store: SHOPIFY_STORE + SHOPIFY_ACCESS_TOKEN (maps to store "1")

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-07";
const PORT = parseInt(process.env.PORT || "3000");

interface StoreConfig {
  key: string; // "1", "2", "3"
  name: string; // human label
  domain: string;
  token: string;
}

function loadStores(): StoreConfig[] {
  const stores: StoreConfig[] = [];

  // Multi-store env vars
  for (let i = 1; i <= 3; i++) {
    const domain = process.env[`STORE${i}_DOMAIN`] || (i === 1 ? process.env.SHOPIFY_STORE : undefined);
    const token = process.env[`STORE${i}_TOKEN`] || (i === 1 ? process.env.SHOPIFY_ACCESS_TOKEN : undefined);
    const name = process.env[`STORE${i}_NAME`] || `Store ${i}`;
    if (domain && token) stores.push({ key: String(i), name, domain, token });
  }

  if (stores.length === 0) {
    console.error("No stores configured. Set STORE1_DOMAIN + STORE1_TOKEN (or SHOPIFY_STORE + SHOPIFY_ACCESS_TOKEN).");
    process.exit(1);
  }
  return stores;
}

const STORES = loadStores();
console.log(`Loaded ${STORES.length} store(s): ${STORES.map((s) => s.name).join(", ")}`);

// ─── Shopify GraphQL client ──────────────────────────────────────────────────
async function shopifyGql(
  store: StoreConfig,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<{ data?: Record<string, unknown>; errors?: unknown[] }> {
  const url = `https://${store.domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": store.token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`[${store.name}] Shopify HTTP ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{ data?: Record<string, unknown>; errors?: unknown[] }>;
}

function ok(data: unknown): { content: [{ type: "text"; text: string }] } {
  // Compact (no indentation) — every byte here is a token the LLM caller pays for.
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}
function err(msg: string): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: `ERROR: ${msg}` }] };
}

// Surface Shopify mutation userErrors as a failure. Shopify returns HTTP 200 with an
// empty top-level `errors` but a populated `<rootField>.userErrors[]` when a write is
// rejected by validation (bad price, stale inventory qty, address rejected, refund
// mismatch, duplicate discount code, …). Without this check those rejected writes were
// returned to the caller as success. Returns an err() result on userErrors, else null.
function userErrorOf(
  res: { data?: Record<string, unknown> },
  rootField: string
): { content: [{ type: "text"; text: string }] } | null {
  const ue = (res.data?.[rootField] as
    { userErrors?: { field?: string[] | string | null; message: string }[] } | undefined)?.userErrors;
  if (ue && ue.length > 0) {
    return err(
      ue
        .map((e) => `${Array.isArray(e.field) ? e.field.join(".") : e.field || "?"}: ${e.message}`)
        .join("; ")
    );
  }
  return null;
}

// Resolve store by key ("1","2","3") or name. Defaults to the first store ONLY
// when no key is supplied. A provided-but-unknown key THROWS rather than silently
// falling back to STORES[0] — silent fallback could route a write (or a publish)
// to the wrong store and, since the publish guards key off store.name, around the
// gateway guard. Throwing is guard-strengthening; the MCP SDK surfaces it as an error.
function resolveStore(storeKey?: string): StoreConfig {
  if (!storeKey) return STORES[0];
  const match = STORES.find(
    (s) => s.key === storeKey || s.name.toLowerCase() === storeKey.toLowerCase()
  );
  if (!match) {
    throw new Error(
      `Unknown store "${storeKey}". Valid options: ${STORES.map((s) => `"${s.key}" (${s.name})`).join(", ")}.`
    );
  }
  return match;
}

function storeSchema() {
  // Keep this description short: it is duplicated into the static manifest of every
  // store-scoped tool (~50x). Full key→name mapping lives in supliful_list_stores.
  return z
    .string()
    .optional()
    .describe(
      `Store key "${STORES.map((s) => s.key).join("\"/\"")}" (default "${STORES[0].key}"=${STORES[0].name}). Call supliful_list_stores for names.`
    );
}

// ─── Supliful publish guard ──────────────────────────────────────────────────
// HARD RULE: a product may be set ACTIVE only if EVERY variant has a Supliful SKU
// AND its inventory is stocked at the "Supliful Fulfillment" location.
async function assertSuplifulReady(
  store: StoreConfig,
  productId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  let res;
  try {
    res = await shopifyGql(
      store,
      `query($id: ID!) {
        product(id: $id) {
          title
          variants(first: 100) {
            edges { node { sku inventoryItem { inventoryLevels(first: 10) { edges { node { location { name } } } } } } }
          }
        }
      }`,
      { id: productId },
    );
  } catch (e) {
    return { ok: false, message: `Could not verify Supliful readiness: ${String(e)}` };
  }
  const p = (res.data as any)?.product;
  if (!p) return { ok: false, message: `Product ${productId} not found on ${store.name}.` };
  const variants = (p.variants?.edges || []).map((e: any) => e.node);
  const isSupliful = (n: string) => /supliful/i.test(n || "");
  const compliant =
    variants.length > 0 &&
    variants.every((v: any) => {
      const locs = (v.inventoryItem?.inventoryLevels?.edges || []).map((x: any) => x.node.location.name);
      return v.sku && locs.length > 0 && locs.every(isSupliful);
    });
  if (compliant) return { ok: true };
  return {
    ok: false,
    message:
      `🛑 BLOCKED — cannot publish "${p.title}" on ${store.name}: it is NOT connected to Supliful.\n\n` +
      `Hard rule: a product may be set ACTIVE only if EVERY variant has a Supliful SKU AND its ` +
      `inventory is stocked at the "Supliful Fulfillment" location.\n\n` +
      `Fix: connect the product through the Supliful app first (assigns the SKU and stocks it at ` +
      `Supliful Fulfillment), then publish. Until then it stays DRAFT.\n\n` +
      `Why: a product not stocked at Supliful routes to the merchant-managed location, gets marked ` +
      `FULFILLED with requestStatus=UNSUBMITTED, never ships, and is refunded (proven on #1001 & #1002).`,
  };
}

// ─── Gateway store guard ─────────────────────────────────────────────────────
// GenoMAX Gateway is a non-selling "gateway" store: it must NEVER have ACTIVE
// products. Any attempt to publish a product there is refused outright.
function assertSellableStore(
  store: StoreConfig,
): { ok: true } | { ok: false; message: string } {
  if (/gateway/i.test(store.name)) {
    return {
      ok: false,
      message:
        `🛑 BLOCKED — cannot publish on ${store.name}: it is a NON-SELLING gateway store.\n\n` +
        `Hard rule: ${store.name} never sells products, so NO product may be set ACTIVE here — ` +
        `it must stay DRAFT.\n\n` +
        `Fix: publish on a selling store (MAXima or MAXimo) instead, connected through Supliful.`,
    };
  }
  return { ok: true };
}

// ─── Server factory ──────────────────────────────────────────────────────────
function createMcpServer(): McpServer {
  const server = new McpServer({ name: "supliful-mcp", version: "2.0.0" });

  // ═══════════════════════════════════════════════════════════════════════════
  // MULTI-STORE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "supliful_list_stores",
    { description: "List all configured Shopify stores connected to this Supliful MCP server.", inputSchema: {} },
    async () => ok(STORES.map((s) => ({ key: s.key, name: s.name, domain: s.domain })))
  );

  server.registerTool(
    "supliful_cross_store_order_search",
    {
      description: "Search for orders by customer email across ALL connected stores simultaneously.",
      inputSchema: {
        email: z.string().email().describe("Customer email to search for"),
        first: z.number().optional().default(10),
      },
    },
    async ({ email, first }) => {
      const entries = await Promise.all(STORES.map(async (store): Promise<[string, unknown]> => {
        try {
          const res = await shopifyGql(store, `
            query CrossStoreSearch($query: String!, $first: Int!) {
              orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
                edges {
                  node {
                    id name email createdAt displayFulfillmentStatus displayFinancialStatus
                    totalPriceSet { shopMoney { amount currencyCode } }
                    lineItems(first: 5) { edges { node { title quantity sku } } }
                  }
                }
              }
            }`, { query: `email:${email}`, first });
          return [`${store.key}_${store.name}`, res.errors ? { error: res.errors } : res.data?.orders];
        } catch (e) {
          return [`${store.key}_${store.name}`, { error: String(e) }];
        }
      }));
      return ok(Object.fromEntries(entries));
    }
  );

  server.registerTool(
    "supliful_cross_store_unfulfilled_summary",
    {
      description: "Get a summary of unfulfilled paid orders across ALL stores at once.",
      inputSchema: {},
    },
    async () => {
      const entries = await Promise.all(STORES.map(async (store): Promise<[string, unknown]> => {
        try {
          const res = await shopifyGql(store, `
            query UnfulfilledSummary {
              orders(first: 50, query: "fulfillment_status:unfulfilled financial_status:paid") {
                edges {
                  node {
                    id name createdAt
                    totalPriceSet { shopMoney { amount currencyCode } }
                    shippingAddress { country }
                    lineItems(first: 5) { edges { node { title quantity } } }
                  }
                }
                pageInfo { hasNextPage }
              }
            }`);
          const edges = (res.data?.orders as { edges: unknown[]; pageInfo: { hasNextPage: boolean } })?.edges || [];
          return [`${store.key}_${store.name}`, {
            count: edges.length,
            hasMore: (res.data?.orders as { pageInfo: { hasNextPage: boolean } })?.pageInfo?.hasNextPage,
            orders: edges,
          }];
        } catch (e) {
          return [`${store.key}_${store.name}`, { error: String(e) }];
        }
      }));
      return ok(Object.fromEntries(entries));
    }
  );

  server.registerTool(
    "supliful_cross_store_sales_comparison",
    {
      description: "Compare sales across all stores for a given date range.",
      inputSchema: {
        startDate: z.string().describe("ISO date e.g. 2025-01-01"),
        endDate: z.string().describe("ISO date e.g. 2025-12-31"),
      },
    },
    async ({ startDate, endDate }) => {
      const q = `created_at:>=${startDate} created_at:<=${endDate} financial_status:paid`;
      const entries = await Promise.all(STORES.map(async (store): Promise<[string, unknown]> => {
        try {
          const res = await shopifyGql(store, `
            query StoreSales($query: String!) {
              orders(first: 250, query: $query) {
                edges { node { totalPriceSet { shopMoney { amount currencyCode } } } }
                pageInfo { hasNextPage }
              }
            }`, { query: q });
          const edges = (res.data?.orders as { edges: { node: { totalPriceSet: { shopMoney: { amount: string; currencyCode: string } } } }[] })?.edges || [];
          const total = edges.reduce((s, e) => s + parseFloat(e.node.totalPriceSet.shopMoney.amount), 0);
          return [`${store.key}_${store.name}`, {
            orderCount: edges.length,
            totalRevenue: total.toFixed(2),
            currency: edges[0]?.node.totalPriceSet.shopMoney.currencyCode ?? "USD",
            hasMore: (res.data?.orders as { pageInfo: { hasNextPage: boolean } })?.pageInfo?.hasNextPage,
          }];
        } catch (e) {
          return [`${store.key}_${store.name}`, { error: String(e) }];
        }
      }));
      return ok({ period: { startDate, endDate }, stores: Object.fromEntries(entries) });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // PRODUCTS
  // ═══════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "supliful_list_products",
    {
      description: "List products published from Supliful to Shopify.",
      inputSchema: {
        store: storeSchema(),
        first: z.number().optional().default(50),
        after: z.string().optional(),
        status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]).optional(),
        query: z.string().optional().describe("Free-text search"),
      },
    },
    async ({ store: storeKey, first, after, status, query }) => {
      const store = resolveStore(storeKey);
      const filters = [status ? `status:${status}` : "", query || ""].filter(Boolean).join(" AND ");
      try {
        const res = await shopifyGql(store, `
          query ListProducts($first: Int!, $after: String, $query: String) {
            products(first: $first, after: $after, query: $query) {
              edges {
                node {
                  id title handle status descriptionHtml totalInventory createdAt updatedAt tags productType vendor
                  images(first: 5) { edges { node { url altText } } }
                  variants(first: 20) {
                    edges {
                      node {
                        id title price compareAtPrice sku availableForSale
                        inventoryItem { id tracked measurement { weight { value unit } } }
                      }
                    }
                  }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }`, { first, after, query: filters || undefined });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok({ store: store.name, ...res.data?.products as object });
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_get_product",
    {
      description: "Get full details of a Supliful product by its Shopify GID.",
      inputSchema: {
        store: storeSchema(),
        id: z.string().describe("Product GID e.g. gid://shopify/Product/123"),
      },
    },
    async ({ store: storeKey, id }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          query GetProduct($id: ID!) {
            product(id: $id) {
              id title handle status descriptionHtml tags productType vendor createdAt updatedAt totalInventory
              images(first: 10) { edges { node { url altText } } }
              variants(first: 30) {
                edges {
                  node {
                    id title price compareAtPrice sku barcode availableForSale
                    inventoryItem {
                      id tracked measurement { weight { unit value } }
                      inventoryLevels(first: 5) { edges { node { location { name isFulfillmentService fulfillmentService { serviceName handle } } } } }
                    }
                  }
                }
              }
              metafields(first: 20) { edges { node { namespace key value type } } }
              seo { title description }
            }
          }`, { id });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.product);
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_search_products_by_sku",
    {
      description: "Search for Supliful products by SKU.",
      inputSchema: {
        store: storeSchema(),
        sku: z.string(),
      },
    },
    async ({ store: storeKey, sku }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          query SearchBySku($query: String!) {
            products(first: 10, query: $query) {
              edges {
                node {
                  id title status
                  variants(first: 10) { edges { node { id sku title price } } }
                }
              }
            }
          }`, { query: `sku:${sku}` });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.products);
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_list_collections",
    {
      description: "List all Shopify collections (product groups) in a store.",
      inputSchema: {
        store: storeSchema(),
        first: z.number().optional().default(30),
      },
    },
    async ({ store: storeKey, first }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          query ListCollections($first: Int!) {
            collections(first: $first) {
              edges {
                node {
                  id title handle updatedAt
                  productsCount { count }
                  image { url altText }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }`, { first });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.collections);
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_update_product",
    {
      description: "Update a product's title, description, tags, SEO, or status.",
      inputSchema: {
        store: storeSchema(),
        id: z.string().describe("Product GID"),
        title: z.string().optional(),
        descriptionHtml: z.string().optional(),
        tags: z.array(z.string()).optional(),
        status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]).optional(),
        seoTitle: z.string().optional(),
        seoDescription: z.string().optional(),
      },
    },
    async ({ store: storeKey, id, title, descriptionHtml, tags, status, seoTitle, seoDescription }) => {
      const store = resolveStore(storeKey);
      if (status === "ACTIVE") {
        const sellable = assertSellableStore(store);
        if (!sellable.ok) {
          console.error(`[GUARD] ${store.name}: blocked ACTIVE publish of ${id} — non-selling gateway store.`);
          return err(sellable.message);
        }
        const guard = await assertSuplifulReady(store, id);
        if (!guard.ok) {
          console.error(`[GUARD] ${store.name}: blocked ACTIVE publish of ${id} — not Supliful-ready.`);
          return err(guard.message);
        }
      }
      const input: Record<string, unknown> = { id };
      if (title !== undefined) input.title = title;
      if (descriptionHtml !== undefined) input.descriptionHtml = descriptionHtml;
      if (tags !== undefined) input.tags = tags;
      if (status !== undefined) input.status = status;
      if (seoTitle || seoDescription) input.seo = { title: seoTitle, description: seoDescription };
      try {
        const res = await shopifyGql(store, `
          mutation UpdateProduct($input: ProductInput!) {
            productUpdate(input: $input) {
              product { id title status tags }
              userErrors { field message }
            }
          }`, { input });
        if (res.errors) return err(JSON.stringify(res.errors));
        { const ue = userErrorOf(res, "productUpdate"); if (ue) return ue; }
        return ok(res.data?.productUpdate);
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_update_variant_price",
    {
      description: "Update price and compareAtPrice for a product variant.",
      inputSchema: {
        store: storeSchema(),
        productId: z.string().describe("Product GID"),
        variants: z.array(z.object({
          id: z.string().describe("Variant GID"),
          price: z.string().optional().describe("e.g. '29.99'"),
          compareAtPrice: z.string().optional().describe("Original price for strikethrough"),
        })),
      },
    },
    async ({ store: storeKey, productId, variants }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          mutation UpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              productVariants { id price compareAtPrice }
              userErrors { field message }
            }
          }`, { productId, variants });
        if (res.errors) return err(JSON.stringify(res.errors));
        { const ue = userErrorOf(res, "productVariantsBulkUpdate"); if (ue) return ue; }
        return ok(res.data?.productVariantsBulkUpdate);
      } catch (e) { return err(String(e)); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ORDERS
  // ═══════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "supliful_list_orders",
    {
      description: "List Shopify orders routed to Supliful for fulfillment.",
      inputSchema: {
        store: storeSchema(),
        first: z.number().optional().default(25),
        after: z.string().optional(),
        query: z.string().optional().describe("e.g. 'fulfillment_status:unfulfilled financial_status:paid created_at:>=2025-01-01'"),
        sortKey: z.enum(["CREATED_AT", "UPDATED_AT", "PROCESSED_AT", "TOTAL_PRICE", "ID"]).optional().default("CREATED_AT"),
        reverse: z.boolean().optional().default(true),
      },
    },
    async ({ store: storeKey, first, after, query, sortKey, reverse }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          query ListOrders($first: Int!, $after: String, $query: String, $sortKey: OrderSortKeys, $reverse: Boolean) {
            orders(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
              edges {
                node {
                  id name email phone createdAt processedAt updatedAt closedAt cancelledAt
                  displayFinancialStatus displayFulfillmentStatus
                  totalPriceSet { shopMoney { amount currencyCode } }
                  subtotalPriceSet { shopMoney { amount currencyCode } }
                  totalShippingPriceSet { shopMoney { amount currencyCode } }
                  lineItems(first: 20) {
                    edges {
                      node {
                        id title quantity sku
                        originalUnitPriceSet { shopMoney { amount currencyCode } }
                        variant { id sku }
                      }
                    }
                  }
                  shippingAddress { firstName lastName address1 address2 city province country zip phone }
                  fulfillmentOrders(first: 5) {
                    edges {
                      node {
                        id status requestStatus
                        fulfillments(first: 5) {
                          edges { node { id status trackingInfo { number url company } } }
                        }
                      }
                    }
                  }
                  note tags customAttributes { key value }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }`, { first, after, query, sortKey, reverse });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok({ store: store.name, ...res.data?.orders as object });
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_get_order",
    {
      description: "Get full order details by GID or order name (#1234).",
      inputSchema: {
        store: storeSchema(),
        id: z.string().describe("Order GID or '#1234' name"),
      },
    },
    async ({ store: storeKey, id }) => {
      const store = resolveStore(storeKey);
      try {
        let orderId = id;
        if (id.startsWith("#") || /^\d+$/.test(id)) {
          const name = id.startsWith("#") ? id : `#${id}`;
          const searchRes = await shopifyGql(store, `
            query FindOrder($query: String!) {
              orders(first: 1, query: $query) { edges { node { id } } }
            }`, { query: `name:${name}` });
          const edges = (searchRes.data?.orders as { edges: { node: { id: string } }[] })?.edges;
          if (!edges?.length) return err(`Order ${name} not found in ${store.name}`);
          orderId = edges[0].node.id;
        }
        const res = await shopifyGql(store, `
          query GetOrder($id: ID!) {
            order(id: $id) {
              id name email phone note tags
              createdAt processedAt updatedAt closedAt cancelledAt cancelReason
              displayFinancialStatus displayFulfillmentStatus
              totalPriceSet { shopMoney { amount currencyCode } }
              subtotalPriceSet { shopMoney { amount currencyCode } }
              totalTaxSet { shopMoney { amount currencyCode } }
              totalShippingPriceSet { shopMoney { amount currencyCode } }
              totalDiscountsSet { shopMoney { amount currencyCode } }
              customer { id email firstName lastName phone }
              shippingAddress { firstName lastName company address1 address2 city province country zip phone }
              billingAddress { firstName lastName company address1 address2 city province country zip phone }
              lineItems(first: 30) {
                edges {
                  node {
                    id title quantity sku refundableQuantity
                    originalUnitPriceSet { shopMoney { amount currencyCode } }
                    discountedUnitPriceSet { shopMoney { amount currencyCode } }
                    variant { id sku title price inventoryItem { id inventoryLevels(first: 5) { edges { node { location { name fulfillmentService { serviceName handle } } } } } } }
                  }
                }
              }
              fulfillmentOrders(first: 10) {
                edges {
                  node {
                    id status requestStatus
                    assignedLocation { name address { address1 city country } }
                    lineItems(first: 20) {
                      edges { node { id remainingQuantity lineItem { title sku } } }
                    }
                    fulfillments(first: 10) {
                      edges {
                        node {
                          id status createdAt updatedAt
                          trackingInfo { number url company }
                        }
                      }
                    }
                  }
                }
              }
              transactions(first: 10) {
                edges { node { id status kind gateway processedAt amountSet { shopMoney { amount currencyCode } } } }
              }
              customAttributes { key value }
              refunds(first: 5) {
                edges { node { id createdAt note totalRefundedSet { shopMoney { amount currencyCode } } } }
              }
            }
          }`, { id: orderId });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok({ store: store.name, ...res.data?.order as object });
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_create_order",
    {
      description: "Create a Shopify order that Supliful will automatically fulfill.",
      inputSchema: {
        store: storeSchema(),
        lineItems: z.array(z.object({
          variantId: z.string().describe("Shopify variant GID"),
          quantity: z.number().int().min(1),
        })),
        shippingAddress: z.object({
          firstName: z.string(),
          lastName: z.string(),
          address1: z.string(),
          address2: z.string().optional(),
          city: z.string(),
          provinceCode: z.string().optional(),
          countryCode: z.string(),
          zip: z.string(),
          phone: z.string().describe("Required by Supliful"),
          company: z.string().optional(),
        }),
        email: z.string().email().describe("Required by Supliful"),
        phone: z.string().describe("Required by Supliful"),
        internalOrderId: z.string().optional(),
        customerId: z.string().optional().describe("Shopify customer GID"),
        note: z.string().optional(),
        financialStatus: z.enum(["PENDING", "PAID"]).optional().default("PAID"),
        sendReceipt: z.boolean().optional().default(false),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ store: storeKey, lineItems, shippingAddress, email, phone, internalOrderId, customerId, note, financialStatus, sendReceipt, tags }) => {
      const store = resolveStore(storeKey);
      const orderNote = [note, internalOrderId ? `Internal ID: ${internalOrderId}` : ""].filter(Boolean).join(" | ");
      const customAttributes = internalOrderId ? [{ key: "internal_order_id", value: internalOrderId }] : [];
      const orderInput: Record<string, unknown> = {
        lineItems, shippingAddress, billingAddress: shippingAddress,
        email, phone, note: orderNote, financialStatus, sendReceipt,
        sendFulfillmentReceipt: false, customAttributes, tags,
      };
      if (customerId) orderInput.customerToAssociate = customerId;
      try {
        const res = await shopifyGql(store, `
          mutation CreateOrder($order: OrderCreateOrderInput!) {
            orderCreate(order: $order) {
              order {
                id name displayFinancialStatus displayFulfillmentStatus
                totalPriceSet { shopMoney { amount currencyCode } }
                customer { id email }
              }
              userErrors { field message }
            }
          }`, { order: orderInput });
        if (res.errors) return err(JSON.stringify(res.errors));
        const result = res.data?.orderCreate as { userErrors?: { field: string; message: string }[] };
        if (result?.userErrors?.length) return err(JSON.stringify(result.userErrors));
        return ok({ store: store.name, ...result });
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_cancel_order",
    {
      description: "Cancel a Shopify order not yet fulfilled by Supliful.",
      inputSchema: {
        store: storeSchema(),
        orderId: z.string(),
        reason: z.enum(["CUSTOMER", "FRAUD", "INVENTORY", "DECLINED", "OTHER"]).optional().default("OTHER"),
        refund: z.boolean().optional().default(true),
        notifyCustomer: z.boolean().optional().default(false),
      },
    },
    async ({ store: storeKey, orderId, reason, refund, notifyCustomer }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          mutation CancelOrder($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!, $notifyCustomer: Boolean!) {
            orderCancel(orderId: $orderId, reason: $reason, refund: $refund, notifyCustomer: $notifyCustomer) {
              orderCancelUserErrors { field message code }
              userErrors { field message }
            }
          }`, { orderId, reason, refund, notifyCustomer });
        if (res.errors) return err(JSON.stringify(res.errors));
        { const ue = userErrorOf(res, "orderCancel"); if (ue) return ue; }
        return ok(res.data?.orderCancel);
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_update_order",
    {
      description: "Update order note, tags, or custom attributes.",
      inputSchema: {
        store: storeSchema(),
        orderId: z.string(),
        note: z.string().optional(),
        tags: z.array(z.string()).optional(),
        customAttributes: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
      },
    },
    async ({ store: storeKey, orderId, note, tags, customAttributes }) => {
      const store = resolveStore(storeKey);
      const input: Record<string, unknown> = { id: orderId };
      if (note !== undefined) input.note = note;
      if (tags !== undefined) input.tags = tags;
      if (customAttributes !== undefined) input.customAttributes = customAttributes;
      try {
        const res = await shopifyGql(store, `
          mutation UpdateOrder($input: OrderInput!) {
            orderUpdate(input: $input) {
              order { id name note tags customAttributes { key value } }
              userErrors { field message }
            }
          }`, { input });
        if (res.errors) return err(JSON.stringify(res.errors));
        { const ue = userErrorOf(res, "orderUpdate"); if (ue) return ue; }
        return ok(res.data?.orderUpdate);
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_list_unfulfilled_orders",
    {
      description: "List all paid but unfulfilled orders (Supliful fulfillment queue).",
      inputSchema: {
        store: storeSchema(),
        first: z.number().optional().default(50),
        after: z.string().optional(),
      },
    },
    async ({ store: storeKey, first, after }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          query UnfulfilledOrders($first: Int!, $after: String) {
            orders(first: $first, after: $after, query: "fulfillment_status:unfulfilled financial_status:paid", sortKey: CREATED_AT, reverse: false) {
              edges {
                node {
                  id name email createdAt displayFulfillmentStatus displayFinancialStatus
                  totalPriceSet { shopMoney { amount currencyCode } }
                  lineItems(first: 10) { edges { node { title quantity sku } } }
                  shippingAddress { firstName lastName country }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }`, { first, after });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok({ store: store.name, ...res.data?.orders as object });
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_list_orders_on_hold",
    {
      description: "List orders that are on hold due to payment failure or Supliful issues.",
      inputSchema: {
        store: storeSchema(),
        first: z.number().optional().default(25),
      },
    },
    async ({ store: storeKey, first }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          query OnHoldOrders($first: Int!) {
            orders(first: $first, query: "financial_status:pending fulfillment_status:unfulfilled") {
              edges {
                node {
                  id name email createdAt displayFinancialStatus displayFulfillmentStatus
                  totalPriceSet { shopMoney { amount currencyCode } }
                  note tags
                  lineItems(first: 5) { edges { node { title quantity } } }
                }
              }
              pageInfo { hasNextPage }
            }
          }`, { first });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok({ store: store.name, ...res.data?.orders as object });
      } catch (e) { return err(String(e)); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // FULFILLMENT
  // ═══════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "supliful_get_fulfillment_orders",
    {
      description: "Get Supliful fulfillment status for a specific order.",
      inputSchema: {
        store: storeSchema(),
        orderId: z.string(),
      },
    },
    async ({ store: storeKey, orderId }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          query GetFulfillmentOrders($orderId: ID!) {
            order(id: $orderId) {
              id name
              fulfillmentOrders(first: 10) {
                edges {
                  node {
                    id status requestStatus createdAt updatedAt
                    assignedLocation { name address { address1 city country } }
                    lineItems(first: 20) {
                      edges { node { id remainingQuantity totalQuantity lineItem { id title sku quantity } } }
                    }
                    fulfillments(first: 10) {
                      edges {
                        node {
                          id status createdAt updatedAt
                          trackingInfo { number url company }
                          fulfillmentLineItems(first: 10) {
                            edges { node { id quantity lineItem { title sku } } }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }`, { orderId });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.order);
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_get_tracking_info",
    {
      description: "Get tracking numbers and URLs for a fulfilled Supliful order.",
      inputSchema: {
        store: storeSchema(),
        orderId: z.string(),
      },
    },
    async ({ store: storeKey, orderId }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          query GetTracking($orderId: ID!) {
            order(id: $orderId) {
              id name displayFulfillmentStatus
              fulfillments(first: 10) {
                edges {
                  node {
                    id status createdAt updatedAt
                    trackingInfo { number url company }
                    fulfillmentLineItems(first: 10) {
                      edges { node { id quantity lineItem { title sku } } }
                    }
                  }
                }
              }
            }
          }`, { orderId });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.order);
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_update_shipping_address",
    {
      description: "Update the shipping address on an order before Supliful ships it.",
      inputSchema: {
        store: storeSchema(),
        orderId: z.string(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        address1: z.string().optional(),
        address2: z.string().optional(),
        city: z.string().optional(),
        provinceCode: z.string().optional(),
        countryCode: z.string().optional(),
        zip: z.string().optional(),
        phone: z.string().optional(),
        company: z.string().optional(),
      },
    },
    async ({ store: storeKey, orderId, ...addressFields }) => {
      const store = resolveStore(storeKey);
      const shippingAddress = Object.fromEntries(
        Object.entries(addressFields).filter(([, v]) => v !== undefined)
      );
      try {
        const res = await shopifyGql(store, `
          mutation UpdateShippingAddress($orderId: ID!, $shippingAddress: MailingAddressInput!) {
            orderUpdate(input: { id: $orderId, shippingAddress: $shippingAddress }) {
              order { id name shippingAddress { firstName lastName address1 city country zip phone } }
              userErrors { field message }
            }
          }`, { orderId, shippingAddress });
        if (res.errors) return err(JSON.stringify(res.errors));
        { const ue = userErrorOf(res, "orderUpdate"); if (ue) return ue; }
        return ok(res.data?.orderUpdate);
      } catch (e) { return err(String(e)); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // CUSTOMERS
  // ═══════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "supliful_create_customer",
    {
      description: "Create a customer record in Shopify.",
      inputSchema: {
        store: storeSchema(),
        firstName: z.string(),
        lastName: z.string(),
        email: z.string().email(),
        phone: z.string().optional(),
        note: z.string().optional(),
        tags: z.array(z.string()).optional(),
        acceptsMarketing: z.boolean().optional().default(false),
      },
    },
    async ({ store: storeKey, firstName, lastName, email, phone, note, tags, acceptsMarketing }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          mutation CreateCustomer($input: CustomerInput!) {
            customerCreate(input: $input) {
              customer { id email firstName lastName phone }
              userErrors { field message }
            }
          }`, { input: { firstName, lastName, email, phone, note, tags, acceptsMarketing } });
        if (res.errors) return err(JSON.stringify(res.errors));
        { const ue = userErrorOf(res, "customerCreate"); if (ue) return ue; }
        return ok(res.data?.customerCreate);
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_find_customer",
    {
      description: "Find a customer by email, phone, or name across a store.",
      inputSchema: {
        store: storeSchema(),
        query: z.string().describe("e.g. 'email:user@example.com' or 'phone:+15555' or 'John Smith'"),
        first: z.number().optional().default(5),
      },
    },
    async ({ store: storeKey, query, first }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          query FindCustomer($query: String!, $first: Int!) {
            customers(first: $first, query: $query) {
              edges {
                node {
                  id email firstName lastName phone createdAt updatedAt ordersCount totalSpent tags
                }
              }
            }
          }`, { query, first });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.customers);
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_get_customer",
    {
      description: "Get full customer details including order history.",
      inputSchema: {
        store: storeSchema(),
        id: z.string().describe("Customer GID"),
      },
    },
    async ({ store: storeKey, id }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          query GetCustomer($id: ID!) {
            customer(id: $id) {
              id email firstName lastName phone note createdAt updatedAt
              defaultAddress { address1 address2 city province country zip }
              addresses(first: 5) { edges { node { address1 city country zip } } }
              orders(first: 10, sortKey: CREATED_AT, reverse: true) {
                edges {
                  node {
                    id name createdAt displayFulfillmentStatus displayFinancialStatus
                    totalPriceSet { shopMoney { amount currencyCode } }
                  }
                }
              }
              tags ordersCount totalSpent
            }
          }`, { id });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.customer);
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_update_customer",
    {
      description: "Update customer details.",
      inputSchema: {
        store: storeSchema(),
        id: z.string(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        note: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ store: storeKey, id, firstName, lastName, email, phone, note, tags }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          mutation UpdateCustomer($input: CustomerInput!) {
            customerUpdate(input: $input) {
              customer { id email firstName lastName phone }
              userErrors { field message }
            }
          }`, { input: { id, firstName, lastName, email, phone, note, tags } });
        if (res.errors) return err(JSON.stringify(res.errors));
        const ue = userErrorOf(res, "customerUpdate"); if (ue) return ue;
        return ok(res.data?.customerUpdate);
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_list_customers",
    {
      description: "List or search all customers in a store.",
      inputSchema: {
        store: storeSchema(),
        first: z.number().optional().default(25),
        after: z.string().optional(),
        query: z.string().optional().describe("Shopify customer search e.g. 'orders_count:>5' or 'tag:vip'"),
        sortKey: z.enum(["CREATED_AT", "UPDATED_AT", "ORDERS_COUNT", "TOTAL_SPENT", "NAME", "ID"]).optional().default("CREATED_AT"),
        reverse: z.boolean().optional().default(true),
      },
    },
    async ({ store: storeKey, first, after, query, sortKey, reverse }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          query ListCustomers($first: Int!, $after: String, $query: String, $sortKey: CustomerSortKeys, $reverse: Boolean) {
            customers(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
              edges {
                node {
                  id email firstName lastName phone createdAt ordersCount totalSpent tags
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }`, { first, after, query, sortKey, reverse });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok({ store: store.name, ...res.data?.customers as object });
      } catch (e) { return err(String(e)); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // REFUNDS
  // ═══════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "supliful_list_refunds",
    {
      description: "List refunds for a specific order.",
      inputSchema: {
        store: storeSchema(),
        orderId: z.string(),
      },
    },
    async ({ store: storeKey, orderId }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          query GetRefunds($id: ID!) {
            order(id: $id) {
              id name
              refunds(first: 20) {
                edges {
                  node {
                    id createdAt note
                    totalRefundedSet { shopMoney { amount currencyCode } }
                    refundLineItems(first: 10) {
                      edges { node { quantity lineItem { title sku } restockType } }
                    }
                    transactions(first: 5) {
                      edges { node { id kind status amountSet { shopMoney { amount currencyCode } } } }
                    }
                  }
                }
              }
            }
          }`, { id: orderId });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.order);
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_create_refund",
    {
      description: "Issue a refund on an order. Use for damaged/wrong products from Supliful.",
      inputSchema: {
        store: storeSchema(),
        orderId: z.string(),
        note: z.string().optional().describe("Reason for refund"),
        refundLineItems: z.array(z.object({
          lineItemId: z.string(),
          quantity: z.number().int().min(1),
          restockType: z.enum(["NO_RESTOCK", "CANCEL", "RETURN", "LEGACY_RESTOCK"]).optional().default("NO_RESTOCK"),
        })).optional(),
        transactions: z.array(z.object({
          orderId: z.string(),
          amount: z.string(),
          kind: z.enum(["REFUND", "SUGGESTED_REFUND"]).optional().default("REFUND"),
          gateway: z.string().optional(),
        })).optional(),
        notify: z.boolean().optional().default(false),
      },
    },
    async ({ store: storeKey, orderId, note, refundLineItems, transactions, notify }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          mutation CreateRefund($input: RefundInput!) {
            refundCreate(input: $input) {
              refund {
                id createdAt note
                totalRefundedSet { shopMoney { amount currencyCode } }
                refundLineItems(first: 10) { edges { node { quantity lineItem { title } } } }
              }
              userErrors { field message }
            }
          }`, { input: { orderId, note, refundLineItems, transactions, notify } });
        if (res.errors) return err(JSON.stringify(res.errors));
        const ue = userErrorOf(res, "refundCreate"); if (ue) return ue;
        return ok(res.data?.refundCreate);
      } catch (e) { return err(String(e)); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // DRAFT ORDERS
  // ═══════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "supliful_create_draft_order",
    {
      description: "Create a draft order for manual review before completing.",
      inputSchema: {
        store: storeSchema(),
        lineItems: z.array(z.object({
          variantId: z.string(),
          quantity: z.number().int().min(1),
          appliedDiscount: z.object({
            description: z.string().optional(),
            value: z.number(),
            valueType: z.enum(["PERCENTAGE", "FIXED_AMOUNT"]),
          }).optional(),
        })),
        email: z.string().email(),
        phone: z.string().optional(),
        shippingAddress: z.object({
          firstName: z.string(), lastName: z.string(),
          address1: z.string(), city: z.string(),
          countryCode: z.string(), zip: z.string(),
          phone: z.string().optional(),
        }),
        note: z.string().optional(),
        tags: z.array(z.string()).optional(),
        customAttributes: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
      },
    },
    async ({ store: storeKey, lineItems, email, phone, shippingAddress, note, tags, customAttributes }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          mutation CreateDraftOrder($input: DraftOrderInput!) {
            draftOrderCreate(input: $input) {
              draftOrder {
                id name status invoiceUrl
                totalPriceSet { shopMoney { amount currencyCode } }
              }
              userErrors { field message }
            }
          }`, { input: { lineItems, email, phone, shippingAddress, note, tags, customAttributes } });
        if (res.errors) return err(JSON.stringify(res.errors));
        const ue = userErrorOf(res, "draftOrderCreate"); if (ue) return ue;
        return ok(res.data?.draftOrderCreate);
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_complete_draft_order",
    {
      description: "Complete a draft order to create a real Shopify order for Supliful.",
      inputSchema: {
        store: storeSchema(),
        draftOrderId: z.string(),
        paymentPending: z.boolean().optional().default(false),
      },
    },
    async ({ store: storeKey, draftOrderId, paymentPending }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          mutation CompleteDraftOrder($id: ID!, $paymentPending: Boolean!) {
            draftOrderComplete(id: $id, paymentPending: $paymentPending) {
              draftOrder {
                id status
                order { id name displayFinancialStatus displayFulfillmentStatus }
              }
              userErrors { field message }
            }
          }`, { id: draftOrderId, paymentPending });
        if (res.errors) return err(JSON.stringify(res.errors));
        const ue = userErrorOf(res, "draftOrderComplete"); if (ue) return ue;
        return ok(res.data?.draftOrderComplete);
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_list_draft_orders",
    {
      description: "List draft orders in a store.",
      inputSchema: {
        store: storeSchema(),
        first: z.number().optional().default(25),
        after: z.string().optional(),
        query: z.string().optional(),
      },
    },
    async ({ store: storeKey, first, after, query }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          query ListDraftOrders($first: Int!, $after: String, $query: String) {
            draftOrders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
              edges {
                node {
                  id name status email createdAt updatedAt
                  invoiceUrl
                  totalPriceSet { shopMoney { amount currencyCode } }
                  lineItems(first: 5) { edges { node { title quantity } } }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }`, { first, after, query });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok({ store: store.name, ...res.data?.draftOrders as object });
      } catch (e) { return err(String(e)); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // WEBHOOKS
  // ═══════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "supliful_list_webhooks",
    {
      description: "List all webhook subscriptions in a store.",
      inputSchema: { store: storeSchema() },
    },
    async ({ store: storeKey }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          query ListWebhooks {
            webhookSubscriptions(first: 50) {
              edges {
                node {
                  id topic createdAt updatedAt
                  endpoint {
                    __typename
                    ... on WebhookHttpEndpoint { callbackUrl }
                    ... on WebhookEventBridgeEndpoint { arn }
                    ... on WebhookPubSubEndpoint { pubSubProject pubSubTopic }
                  }
                }
              }
            }
          }`);
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok({ store: store.name, ...res.data?.webhookSubscriptions as object });
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_create_webhook",
    {
      description: "Create a webhook for order/fulfillment events.",
      inputSchema: {
        store: storeSchema(),
        topic: z.enum([
          "ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_FULFILLED", "ORDERS_CANCELLED", "ORDERS_PARTIALLY_FULFILLED",
          "FULFILLMENTS_CREATE", "FULFILLMENTS_UPDATE",
          "PRODUCTS_CREATE", "PRODUCTS_UPDATE", "PRODUCTS_DELETE",
          "CUSTOMERS_CREATE", "CUSTOMERS_UPDATE", "CUSTOMERS_DELETE",
          "REFUNDS_CREATE", "DRAFT_ORDERS_CREATE", "DRAFT_ORDERS_UPDATE",
        ]),
        callbackUrl: z.string().url(),
      },
    },
    async ({ store: storeKey, topic, callbackUrl }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
            webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
              webhookSubscription {
                id topic
                endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } }
              }
              userErrors { field message }
            }
          }`, { topic, webhookSubscription: { callbackUrl, format: "JSON" } });
        if (res.errors) return err(JSON.stringify(res.errors));
        { const ue = userErrorOf(res, "webhookSubscriptionCreate"); if (ue) return ue; }
        return ok(res.data?.webhookSubscriptionCreate);
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_delete_webhook",
    {
      description: "Delete a webhook subscription.",
      inputSchema: { store: storeSchema(), id: z.string().describe("Webhook GID") },
    },
    async ({ store: storeKey, id }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          mutation DeleteWebhook($id: ID!) {
            webhookSubscriptionDelete(id: $id) {
              deletedWebhookSubscriptionId
              userErrors { field message }
            }
          }`, { id });
        if (res.errors) return err(JSON.stringify(res.errors));
        { const ue = userErrorOf(res, "webhookSubscriptionDelete"); if (ue) return ue; }
        return ok(res.data?.webhookSubscriptionDelete);
      } catch (e) { return err(String(e)); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // SHOP INFO & INVENTORY
  // ═══════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "supliful_get_shop_info",
    {
      description: "Get store info and confirm Supliful fulfillment service is connected.",
      inputSchema: { store: storeSchema() },
    },
    async ({ store: storeKey }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          query ShopInfo {
            shop {
              name email primaryDomain { url }
              plan { displayName partnerDevelopment }
              currencyCode weightUnit
              fulfillmentServices {
                serviceName handle type inventoryManagement trackingSupport
                location { name id address { address1 city country } }
              }
            }
          }`);
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.shop);
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_list_locations",
    {
      description: "List all fulfillment locations including Supliful.",
      inputSchema: { store: storeSchema() },
    },
    async ({ store: storeKey }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          query Locations {
            locations(first: 30) {
              edges {
                node {
                  id name isActive isPrimary
                  fulfillmentService { serviceName handle }
                  address { address1 city country }
                }
              }
            }
          }`);
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.locations);
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_check_product_inventory",
    {
      description: "Check inventory levels for a product across all locations.",
      inputSchema: {
        store: storeSchema(),
        productId: z.string(),
      },
    },
    async ({ store: storeKey, productId }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          query ProductInventory($id: ID!) {
            product(id: $id) {
              id title totalInventory
              variants(first: 20) {
                edges {
                  node {
                    id title sku
                    inventoryItem {
                      id tracked
                      inventoryLevels(first: 10) {
                        edges {
                          node {
                            id
                            quantities(names: ["available","on_hand","committed","incoming"]) { name quantity }
                            location { id name isFulfillmentService fulfillmentService { serviceName handle } }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }`, { id: productId });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.product);
      } catch (e) { return err(String(e)); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ANALYTICS
  // ═══════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "supliful_get_sales_summary",
    {
      description: "Get sales summary (revenue, order count, top products) for a date range.",
      inputSchema: {
        store: storeSchema(),
        startDate: z.string(),
        endDate: z.string(),
        first: z.number().optional().default(100),
      },
    },
    async ({ store: storeKey, startDate, endDate, first }) => {
      const store = resolveStore(storeKey);
      const query = `created_at:>=${startDate} created_at:<=${endDate} financial_status:paid`;
      try {
        const res = await shopifyGql(store, `
          query SalesSummary($query: String!, $first: Int!) {
            orders(first: $first, query: $query, sortKey: CREATED_AT) {
              edges {
                node {
                  id name createdAt displayFulfillmentStatus
                  totalPriceSet { shopMoney { amount currencyCode } }
                  lineItems(first: 10) {
                    edges { node { title quantity sku originalUnitPriceSet { shopMoney { amount currencyCode } } } }
                  }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }`, { query, first });
        if (res.errors) return err(JSON.stringify(res.errors));
        const orders = (res.data?.orders as { edges: { node: { totalPriceSet: { shopMoney: { amount: string; currencyCode: string } } } }[] })?.edges || [];
        const total = orders.reduce((s, e) => s + parseFloat(e.node.totalPriceSet.shopMoney.amount), 0);
        // Return only the computed summary — NOT the raw order list (use
        // supliful_list_orders for rows). Dumping the full edges/nodes here was the
        // single largest payload in the server.
        return ok({
          store: store.name, period: { startDate, endDate },
          orderCount: orders.length,
          totalRevenue: `${total.toFixed(2)} ${orders[0]?.node.totalPriceSet.shopMoney.currencyCode ?? "USD"}`,
          hasMore: (res.data?.orders as { pageInfo: { hasNextPage: boolean } })?.pageInfo?.hasNextPage,
        });
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_get_fulfillment_metrics",
    {
      description: "Get fulfillment breakdown (fulfilled/unfulfilled/partial) for a date range.",
      inputSchema: {
        store: storeSchema(),
        startDate: z.string(),
        endDate: z.string(),
      },
    },
    async ({ store: storeKey, startDate, endDate }) => {
      const store = resolveStore(storeKey);
      const base = `created_at:>=${startDate} created_at:<=${endDate} financial_status:paid`;
      const statuses = ["fulfilled", "unfulfilled", "partial", "restocked"] as const;
      // One round-trip: count each status via an aliased ordersCount in a single query
      // (was 4 serial fetches of up to 250 order ids each, just to read .length).
      const aliased = statuses
        .map((s) => `${s}: ordersCount(query: "${base} fulfillment_status:${s}") { count }`)
        .join("\n");
      const results: Record<string, number | { count: null; error: string }> = {};
      try {
        const res = await shopifyGql(store, `query Counts { ${aliased} }`);
        if (res.errors) return err(JSON.stringify(res.errors));
        for (const s of statuses) {
          results[s] = (res.data?.[s] as { count: number })?.count ?? 0;
        }
      } catch (e) {
        for (const s of statuses) results[s] = { count: null, error: String(e) };
      }
      return ok({ store: store.name, period: { startDate, endDate }, fulfillmentBreakdown: results });
    }
  );

  server.registerTool(
    "supliful_get_top_products",
    {
      description: "Get top selling products by order count for a date range.",
      inputSchema: {
        store: storeSchema(),
        startDate: z.string(),
        endDate: z.string(),
        first: z.number().optional().default(100),
      },
    },
    async ({ store: storeKey, startDate, endDate, first }) => {
      const store = resolveStore(storeKey);
      const query = `created_at:>=${startDate} created_at:<=${endDate} financial_status:paid`;
      try {
        const res = await shopifyGql(store, `
          query TopProducts($query: String!, $first: Int!) {
            orders(first: $first, query: $query) {
              edges {
                node {
                  lineItems(first: 20) {
                    edges { node { title quantity sku originalUnitPriceSet { shopMoney { amount currencyCode } } } }
                  }
                }
              }
            }
          }`, { query, first });
        if (res.errors) return err(JSON.stringify(res.errors));
        // Aggregate
        const productMap: Record<string, { title: string; sku: string; quantity: number; revenue: number; currency: string }> = {};
        for (const { node: order } of (res.data?.orders as { edges: { node: { lineItems: { edges: { node: { title: string; quantity: number; sku: string; originalUnitPriceSet: { shopMoney: { amount: string; currencyCode: string } } } }[] } } }[] })?.edges || []) {
          for (const { node: item } of order.lineItems.edges) {
            const key = item.sku || item.title;
            if (!productMap[key]) productMap[key] = { title: item.title, sku: item.sku, quantity: 0, revenue: 0, currency: item.originalUnitPriceSet.shopMoney.currencyCode };
            productMap[key].quantity += item.quantity;
            productMap[key].revenue += parseFloat(item.originalUnitPriceSet.shopMoney.amount) * item.quantity;
          }
        }
        const sorted = Object.values(productMap).sort((a, b) => b.quantity - a.quantity).slice(0, 20);
        return ok({ store: store.name, period: { startDate, endDate }, topProducts: sorted });
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_get_orders_by_country",
    {
      description: "Break down orders by destination country for a date range.",
      inputSchema: {
        store: storeSchema(),
        startDate: z.string(),
        endDate: z.string(),
        first: z.number().optional().default(250),
      },
    },
    async ({ store: storeKey, startDate, endDate, first }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          query OrdersByCountry($query: String!, $first: Int!) {
            orders(first: $first, query: $query) {
              edges {
                node {
                  shippingAddress { country countryCode }
                  totalPriceSet { shopMoney { amount currencyCode } }
                }
              }
            }
          }`, { query: `created_at:>=${startDate} created_at:<=${endDate} financial_status:paid`, first });
        if (res.errors) return err(JSON.stringify(res.errors));
        const countryMap: Record<string, { count: number; revenue: number }> = {};
        for (const { node } of (res.data?.orders as { edges: { node: { shippingAddress: { country: string }; totalPriceSet: { shopMoney: { amount: string } } } }[] })?.edges || []) {
          const c = node.shippingAddress?.country || "Unknown";
          if (!countryMap[c]) countryMap[c] = { count: 0, revenue: 0 };
          countryMap[c].count++;
          countryMap[c].revenue += parseFloat(node.totalPriceSet.shopMoney.amount);
        }
        const sorted = Object.entries(countryMap).sort((a, b) => b[1].count - a[1].count);
        return ok({ store: store.name, period: { startDate, endDate }, byCountry: Object.fromEntries(sorted) });
      } catch (e) { return err(String(e)); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // DISCOUNTS
  // ═══════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "supliful_list_discount_codes",
    {
      description: "List discount codes in a Shopify store.",
      inputSchema: {
        store: storeSchema(),
        first: z.number().optional().default(20),
        query: z.string().optional().describe("Search by code e.g. 'SUMMER20'"),
      },
    },
    async ({ store: storeKey, first, query }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          query ListDiscounts($first: Int!, $query: String) {
            codeDiscountNodes(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) {
              edges {
                node {
                  id
                  codeDiscount {
                    ... on DiscountCodeBasic {
                      title status
                      codes(first: 5) { edges { node { code asyncUsageCount } } }
                      customerGets {
                        value {
                          ... on DiscountPercentage { percentage }
                          ... on DiscountAmount { amount { amount currencyCode } }
                        }
                      }
                      startsAt endsAt
                      usageLimit
                    }
                    ... on DiscountCodeFreeShipping {
                      title status
                      codes(first: 5) { edges { node { code asyncUsageCount } } }
                      startsAt endsAt usageLimit
                    }
                  }
                }
              }
              pageInfo { hasNextPage }
            }
          }`, { first, query });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok({ store: store.name, ...res.data?.codeDiscountNodes as object });
      } catch (e) { return err(String(e)); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // HEALTH & DIAGNOSTICS
  // ═══════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "supliful_health_check",
    {
      description: "Verify connection to all stores and confirm Supliful fulfillment is active.",
      inputSchema: {
        store: z.string().optional().describe("Check a specific store, or omit to check ALL stores"),
      },
    },
    async ({ store: storeKey }) => {
      const targets = storeKey ? [resolveStore(storeKey)] : STORES;
      // Independent per-store checks — fan out in parallel (was serial, latency scaled
      // linearly with store count).
      const entries = await Promise.all(targets.map(async (store): Promise<[string, unknown]> => {
        try {
          const res = await shopifyGql(store, `
            query HealthCheck {
              shop {
                name email
                fulfillmentServices { serviceName handle type inventoryManagement }
              }
            }`);
          if (res.errors) return [store.name, { status: "error", errors: res.errors }];
          const shop = res.data?.shop as { name: string; email: string; fulfillmentServices: { serviceName: string; handle: string }[] };
          const suplifulConnected = shop?.fulfillmentServices?.some(
            (f) => f.serviceName?.toLowerCase().includes("supliful") || f.handle?.toLowerCase().includes("supliful")
          );
          return [store.name, {
            status: "ok", domain: store.domain,
            shopName: shop?.name, shopEmail: shop?.email,
            suplifulConnected, fulfillmentServices: shop?.fulfillmentServices,
          }];
        } catch (e) {
          return [store.name, { status: "error", error: String(e) }];
        }
      }));
      return ok({ shopifyApiVersion: SHOPIFY_API_VERSION, stores: Object.fromEntries(entries) });
    }
  );

  server.registerTool(
    "supliful_get_api_rate_limit",
    {
      description: "Check remaining Shopify API rate limit quota for a store.",
      inputSchema: { store: storeSchema() },
    },
    async ({ store: storeKey }) => {
      const store = resolveStore(storeKey);
      try {
        const url = `https://${store.domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": store.token },
          body: JSON.stringify({ query: "{ shop { name } }" }),
        });
        const remaining = res.headers.get("X-Shopify-Shop-Api-Call-Limit");
        const retryAfter = res.headers.get("Retry-After");
        const data = await res.json() as Record<string, unknown>;
        return ok({ store: store.name, rateLimitHeader: remaining, retryAfter, extensions: data.extensions });
      } catch (e) { return err(String(e)); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // PARITY TOOLS — general Admin API coverage (match the official Shopify MCP)
  // ═══════════════════════════════════════════════════════════════════════════

  // Arbitrary READ access to the Admin GraphQL API (all stores). Mutations are
  // refused here on purpose so writes can't bypass the publish guards — use the
  // dedicated guarded tools for writes.
  server.registerTool(
    "supliful_graphql_query",
    {
      description: "Run an arbitrary READ-ONLY Shopify Admin GraphQL query (any resource). Mutations are rejected — use the dedicated write tools.",
      inputSchema: {
        store: storeSchema(),
        query: z.string().describe("A GraphQL query (read-only). Must not contain a mutation."),
        variables: z.record(z.any()).optional(),
      },
    },
    async ({ store: storeKey, query, variables }) => {
      const store = resolveStore(storeKey);
      if (/\bmutation\b/i.test(query)) {
        return err("Read-only passthrough: mutations are not allowed here (they could bypass the publish guards). Use a dedicated write tool.");
      }
      try {
        const res = await shopifyGql(store, query, variables || {});
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok({ store: store.name, data: res.data });
      } catch (e) { return err(String(e)); }
    }
  );

  // Create a product. Never creates ACTIVE directly: if ACTIVE is requested the
  // product is created DRAFT and only flipped to ACTIVE if it passes the guards.
  server.registerTool(
    "supliful_create_product",
    {
      description: "Create a product. If status=ACTIVE is requested, the publish guards apply (gateway store + Supliful readiness); otherwise the product stays DRAFT.",
      inputSchema: {
        store: storeSchema(),
        title: z.string(),
        descriptionHtml: z.string().optional(),
        vendor: z.string().optional(),
        productType: z.string().optional(),
        tags: z.array(z.string()).optional(),
        status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]).optional().default("DRAFT"),
        seoTitle: z.string().optional(),
        seoDescription: z.string().optional(),
      },
    },
    async ({ store: storeKey, title, descriptionHtml, vendor, productType, tags, status, seoTitle, seoDescription }) => {
      const store = resolveStore(storeKey);
      const wantsActive = status === "ACTIVE";
      const input: Record<string, unknown> = { title, status: wantsActive ? "DRAFT" : (status || "DRAFT") };
      if (descriptionHtml !== undefined) input.descriptionHtml = descriptionHtml;
      if (vendor !== undefined) input.vendor = vendor;
      if (productType !== undefined) input.productType = productType;
      if (tags !== undefined) input.tags = tags;
      if (seoTitle || seoDescription) input.seo = { title: seoTitle, description: seoDescription };
      try {
        const res = await shopifyGql(store, `
          mutation CreateProduct($input: ProductInput!) {
            productCreate(input: $input) {
              product { id title status handle }
              userErrors { field message }
            }
          }`, { input });
        if (res.errors) return err(JSON.stringify(res.errors));
        const created = res.data?.productCreate as { product?: { id: string; title: string; status: string }; userErrors?: { field: string; message: string }[] };
        if (created?.userErrors?.length) return err(JSON.stringify(created.userErrors));
        const product = created.product!;
        if (!wantsActive) return ok({ store: store.name, product });
        // ACTIVE requested: run the publish guards before flipping live.
        const sellable = assertSellableStore(store);
        const guard = sellable.ok ? await assertSuplifulReady(store, product.id) : sellable;
        if (!guard.ok) {
          console.error(`[GUARD] ${store.name}: refused ACTIVE on create of ${product.id} — kept DRAFT.`);
          return ok({ store: store.name, product, activationRefused: true, message: guard.message });
        }
        const upd = await shopifyGql(store, `
          mutation Publish($input: ProductInput!) {
            productUpdate(input: $input) { product { id title status } userErrors { field message } }
          }`, { input: { id: product.id, status: "ACTIVE" } });
        if (upd.errors) return err(JSON.stringify(upd.errors));
        { const ue = userErrorOf(upd, "productUpdate"); if (ue) return ue; }
        return ok({ store: store.name, ...(upd.data?.productUpdate as object) });
      } catch (e) { return err(String(e)); }
    }
  );

  // Bulk set product status. When the target is ACTIVE, each id is guarded
  // individually and non-compliant products are blocked (not published).
  server.registerTool(
    "supliful_bulk_update_product_status",
    {
      description: "Set status on many products at once. For status=ACTIVE the publish guards are applied per product; non-compliant ones are blocked.",
      inputSchema: {
        store: storeSchema(),
        ids: z.array(z.string()).describe("Product GIDs"),
        status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]),
      },
    },
    async ({ store: storeKey, ids, status }) => {
      const store = resolveStore(storeKey);
      const results: { id: string; result: string; message?: string }[] = [];
      for (const id of ids) {
        if (status === "ACTIVE") {
          const sellable = assertSellableStore(store);
          const guard = sellable.ok ? await assertSuplifulReady(store, id) : sellable;
          if (!guard.ok) {
            console.error(`[GUARD] ${store.name}: blocked ACTIVE of ${id} (bulk).`);
            results.push({ id, result: "BLOCKED", message: guard.message });
            continue;
          }
        }
        try {
          const res = await shopifyGql(store, `
            mutation UpdateStatus($input: ProductInput!) {
              productUpdate(input: $input) { product { id status } userErrors { field message } }
            }`, { input: { id, status } });
          const ue = (res.data?.productUpdate as { userErrors?: { message: string }[] })?.userErrors;
          if (res.errors || ue?.length) results.push({ id, result: "error", message: JSON.stringify(res.errors || ue) });
          else results.push({ id, result: status });
        } catch (e) { results.push({ id, result: "error", message: String(e) }); }
      }
      return ok({ store: store.name, status, results });
    }
  );

  server.registerTool(
    "supliful_set_inventory",
    {
      description: "Set the on-hand/available inventory quantity for an inventory item at a location.",
      inputSchema: {
        store: storeSchema(),
        inventoryItemId: z.string().describe("InventoryItem GID"),
        locationId: z.string().describe("Location GID"),
        quantity: z.number().int(),
        name: z.enum(["available", "on_hand"]).optional().default("available"),
      },
    },
    async ({ store: storeKey, inventoryItemId, locationId, quantity, name }) => {
      const store = resolveStore(storeKey);
      try {
        const cur = await shopifyGql(store, `
          query($id: ID!, $loc: ID!) {
            inventoryItem(id: $id) { inventoryLevel(locationId: $loc) { quantities(names: ["${name}"]) { name quantity } } }
          }`, { id: inventoryItemId, loc: locationId });
        if (cur.errors) return err(JSON.stringify(cur.errors));
        const levels = (cur.data?.inventoryItem as { inventoryLevel?: { quantities?: { name: string; quantity: number }[] } })?.inventoryLevel?.quantities || [];
        const compareQuantity = levels.find((q) => q.name === name)?.quantity ?? 0;
        const res = await shopifyGql(store, `
          mutation SetInv($input: InventorySetQuantitiesInput!) {
            inventorySetQuantities(input: $input) {
              inventoryAdjustmentGroup { createdAt reason }
              userErrors { field message }
            }
          }`, { input: { name, reason: "correction", quantities: [{ inventoryItemId, locationId, quantity, compareQuantity }] } });
        if (res.errors) return err(JSON.stringify(res.errors));
        { const ue = userErrorOf(res, "inventorySetQuantities"); if (ue) return ue; }
        return ok({ store: store.name, ...(res.data?.inventorySetQuantities as object) });
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_create_discount",
    {
      description: "Create a basic percentage discount code (applies to all products).",
      inputSchema: {
        store: storeSchema(),
        title: z.string(),
        code: z.string(),
        percentage: z.number().min(1).max(100).describe("Percent off, e.g. 20 for 20%"),
        startsAt: z.string().optional().describe("ISO datetime; defaults to now"),
        endsAt: z.string().optional(),
        usageLimit: z.number().int().optional(),
      },
    },
    async ({ store: storeKey, title, code, percentage, startsAt, endsAt, usageLimit }) => {
      const store = resolveStore(storeKey);
      const basicCodeDiscount: Record<string, unknown> = {
        title, code,
        startsAt: startsAt || new Date().toISOString(),
        customerSelection: { all: true },
        customerGets: { value: { percentage: percentage / 100 }, items: { all: true } },
      };
      if (endsAt) basicCodeDiscount.endsAt = endsAt;
      if (usageLimit !== undefined) basicCodeDiscount.usageLimit = usageLimit;
      try {
        const res = await shopifyGql(store, `
          mutation CreateDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
            discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
              codeDiscountNode { id }
              userErrors { field message }
            }
          }`, { basicCodeDiscount });
        if (res.errors) return err(JSON.stringify(res.errors));
        { const ue = userErrorOf(res, "discountCodeBasicCreate"); if (ue) return ue; }
        return ok({ store: store.name, ...(res.data?.discountCodeBasicCreate as object) });
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_get_collection",
    {
      description: "Get a collection's details by GID.",
      inputSchema: { store: storeSchema(), id: z.string().describe("Collection GID") },
    },
    async ({ store: storeKey, id }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          query($id: ID!) {
            collection(id: $id) {
              id title handle descriptionHtml updatedAt sortOrder
              productsCount { count }
              image { url altText }
            }
          }`, { id });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.collection);
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_create_collection",
    {
      description: "Create a manual collection.",
      inputSchema: {
        store: storeSchema(),
        title: z.string(),
        descriptionHtml: z.string().optional(),
      },
    },
    async ({ store: storeKey, title, descriptionHtml }) => {
      const store = resolveStore(storeKey);
      const input: Record<string, unknown> = { title };
      if (descriptionHtml !== undefined) input.descriptionHtml = descriptionHtml;
      try {
        const res = await shopifyGql(store, `
          mutation CreateCollection($input: CollectionInput!) {
            collectionCreate(input: $input) {
              collection { id title handle }
              userErrors { field message }
            }
          }`, { input });
        if (res.errors) return err(JSON.stringify(res.errors));
        { const ue = userErrorOf(res, "collectionCreate"); if (ue) return ue; }
        return ok({ store: store.name, ...(res.data?.collectionCreate as object) });
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_add_to_collection",
    {
      description: "Add products to a manual collection.",
      inputSchema: {
        store: storeSchema(),
        collectionId: z.string().describe("Collection GID"),
        productIds: z.array(z.string()).describe("Product GIDs"),
      },
    },
    async ({ store: storeKey, collectionId, productIds }) => {
      const store = resolveStore(storeKey);
      try {
        const res = await shopifyGql(store, `
          mutation AddToCollection($id: ID!, $productIds: [ID!]!) {
            collectionAddProducts(id: $id, productIds: $productIds) {
              collection { id title productsCount { count } }
              userErrors { field message }
            }
          }`, { id: collectionId, productIds });
        if (res.errors) return err(JSON.stringify(res.errors));
        { const ue = userErrorOf(res, "collectionAddProducts"); if (ue) return ue; }
        return ok({ store: store.name, ...(res.data?.collectionAddProducts as object) });
      } catch (e) { return err(String(e)); }
    }
  );

  server.registerTool(
    "supliful_update_collection",
    {
      description: "Update a collection's title or description.",
      inputSchema: {
        store: storeSchema(),
        id: z.string().describe("Collection GID"),
        title: z.string().optional(),
        descriptionHtml: z.string().optional(),
      },
    },
    async ({ store: storeKey, id, title, descriptionHtml }) => {
      const store = resolveStore(storeKey);
      const input: Record<string, unknown> = { id };
      if (title !== undefined) input.title = title;
      if (descriptionHtml !== undefined) input.descriptionHtml = descriptionHtml;
      try {
        const res = await shopifyGql(store, `
          mutation UpdateCollection($input: CollectionInput!) {
            collectionUpdate(input: $input) {
              collection { id title handle }
              userErrors { field message }
            }
          }`, { input });
        if (res.errors) return err(JSON.stringify(res.errors));
        { const ue = userErrorOf(res, "collectionUpdate"); if (ue) return ue; }
        return ok({ store: store.name, ...(res.data?.collectionUpdate as object) });
      } catch (e) { return err(String(e)); }
    }
  );

  // Attach image(s) to a product from public HTTPS URL(s); Shopify fetches them.
  server.registerTool(
    "supliful_add_product_image",
    {
      description: "Attach image(s) to a product from public HTTPS URL(s).",
      inputSchema: {
        store: storeSchema(),
        productId: z.string().describe("Product GID"),
        images: z.array(z.object({ url: z.string().url(), alt: z.string().optional() })).min(1),
      },
    },
    async ({ store: storeKey, productId, images }) => {
      const store = resolveStore(storeKey);
      const media = images.map((i) => ({ originalSource: i.url, mediaContentType: "IMAGE", alt: i.alt }));
      try {
        const res = await shopifyGql(store, `
          mutation AddMedia($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
            productUpdate(product: $product, media: $media) {
              product { id media(first: 20) { edges { node { ... on MediaImage { id image { url } } } } } }
              userErrors { field message }
            }
          }`, { product: { id: productId }, media });
        if (res.errors) return err(JSON.stringify(res.errors));
        { const ue = userErrorOf(res, "productUpdate"); if (ue) return ue; }
        return ok({ store: store.name, ...(res.data?.productUpdate as object) });
      } catch (e) { return err(String(e)); }
    }
  );

  // Arbitrary WRITE access to the Admin GraphQL API — but mutations that would
  // set a product ACTIVE are refused, so the publish guards cannot be bypassed.
  server.registerTool(
    "supliful_graphql_mutation",
    {
      description: "Run an arbitrary Shopify Admin GraphQL mutation. Mutations that set a product ACTIVE are refused — publish via supliful_update_product / supliful_bulk_update_product_status (which enforce the guards).",
      inputSchema: {
        store: storeSchema(),
        query: z.string().describe("A GraphQL mutation."),
        variables: z.record(z.any()).optional(),
      },
    },
    async ({ store: storeKey, query, variables }) => {
      const store = resolveStore(storeKey);
      const blob = `${query} ${JSON.stringify(variables || {})}`;
      // Whole-word field match (was a loose substring that false-positived on
      // "inactive"/"proactive"). Pair with the uppercase ACTIVE enum (case-sensitive
      // \bACTIVE\b) so a status set via a query literal OR a variable value is caught,
      // while benign text mentioning "active" is not. Guard-strengthening only.
      const touchesProductMutation =
        /\b(productCreate|productUpdate|productSet|productChangeStatus|productDuplicate)\b/.test(query);
      if (touchesProductMutation && /\bACTIVE\b/.test(blob)) {
        return err(
          "🛑 BLOCKED — this mutation appears to set a product ACTIVE. To publish, use " +
          "supliful_update_product or supliful_bulk_update_product_status, which enforce the " +
          "Supliful-readiness and non-selling-gateway publish guards.");
      }
      try {
        const res = await shopifyGql(store, query, variables || {});
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok({ store: store.name, data: res.data });
      } catch (e) { return err(String(e)); }
    }
  );

  return server;
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────
const sessions = new Map<string, SSEServerTransport>();

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok", service: "supliful-mcp", version: "2.0.0",
      stores: STORES.map((s) => ({ key: s.key, name: s.name, domain: s.domain })),
    }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/sse") {
    const transport = new SSEServerTransport("/messages", res);
    sessions.set(transport.sessionId, transport);
    res.on("close", () => sessions.delete(transport.sessionId));
    const server = createMcpServer();
    server.connect(transport).catch((e: Error) => console.error("Connect error:", e));
    return;
  }

  if (req.method === "POST" && url.pathname === "/messages") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) { res.writeHead(400); res.end("Missing sessionId"); return; }
    const transport = sessions.get(sessionId);
    if (!transport) { res.writeHead(404); res.end("Session not found"); return; }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("error", () => { if (!res.headersSent) { res.writeHead(400); res.end("Request error"); } });
    req.on("end", () => {
      // Guard JSON.parse: a malformed body used to throw synchronously inside this
      // callback as an uncaught exception, which can take down the SSE server for
      // all sessions. Reply 400 instead.
      let parsed: unknown;
      try {
        parsed = body ? JSON.parse(body) : undefined;
      } catch {
        res.writeHead(400); res.end("Invalid JSON");
        return;
      }
      transport.handlePostMessage(req, res, parsed);
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

httpServer.listen(PORT, () => {
  console.log(`Supliful MCP Server v2.0 running on port ${PORT}`);
  console.log(`Stores: ${STORES.map((s) => `${s.name} (${s.domain})`).join(" | ")}`);
  console.log(`SSE: http://localhost:${PORT}/sse`);
});
