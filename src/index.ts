import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import http from "http";

// ─── Env ────────────────────────────────────────────────────────────────────
const SHOPIFY_STORE = process.env.SHOPIFY_STORE!; // e.g. "my-store.myshopify.com"
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN!;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-07";
const PORT = parseInt(process.env.PORT || "3000");

if (!SHOPIFY_STORE || !SHOPIFY_ACCESS_TOKEN) {
  console.error("Missing SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN");
  process.exit(1);
}

// ─── Shopify GraphQL client ──────────────────────────────────────────────────
async function shopifyGql(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<{ data?: Record<string, unknown>; errors?: unknown[] }> {
  const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<{ data?: Record<string, unknown>; errors?: unknown[] }>;
}

function ok(data: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(msg: string): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: `ERROR: ${msg}` }] };
}

// ─── Server factory ──────────────────────────────────────────────────────────
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "supliful-mcp",
    version: "1.0.0",
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PRODUCTS
  // ═══════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "supliful_list_products",
    {
      description:
        "List all products published from Supliful to Shopify. Supports pagination and filtering by status.",
      inputSchema: {
        first: z.number().optional().default(50).describe("Number of products to fetch (max 250)"),
        after: z.string().optional().describe("Cursor for pagination (endCursor from previous response)"),
        status: z
          .enum(["ACTIVE", "DRAFT", "ARCHIVED"])
          .optional()
          .describe("Filter by product status"),
        query: z.string().optional().describe("Free-text search query"),
      },
    },
    async ({ first, after, status, query }) => {
      const filters: string[] = [];
      if (status) filters.push(`status:${status}`);
      if (query) filters.push(query);
      const queryStr = filters.join(" AND ");

      const gql = `
        query ListProducts($first: Int!, $after: String, $query: String) {
          products(first: $first, after: $after, query: $query) {
            edges {
              node {
                id
                title
                handle
                status
                descriptionHtml
                totalInventory
                createdAt
                updatedAt
                tags
                productType
                vendor
                images(first: 5) {
                  edges { node { url altText } }
                }
                variants(first: 20) {
                  edges {
                    node {
                      id
                      title
                      price
                      compareAtPrice
                      sku
                      weight
                      weightUnit
                      availableForSale
                      inventoryItem {
                        id
                        tracked
                        fulfillmentService { serviceName handle }
                      }
                    }
                  }
                }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`;

      try {
        const res = await shopifyGql(gql, { first, after, query: queryStr || undefined });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.products);
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  server.registerTool(
    "supliful_get_product",
    {
      description: "Get full details of a single Shopify/Supliful product by its GID.",
      inputSchema: {
        id: z.string().describe("Product GID e.g. gid://shopify/Product/123456"),
      },
    },
    async ({ id }) => {
      const gql = `
        query GetProduct($id: ID!) {
          product(id: $id) {
            id title handle status descriptionHtml tags productType vendor
            createdAt updatedAt totalInventory
            images(first: 10) { edges { node { url altText } } }
            variants(first: 30) {
              edges {
                node {
                  id title price compareAtPrice sku weight weightUnit barcode availableForSale
                  inventoryItem {
                    id tracked measurement { weight { unit value } }
                    fulfillmentService { serviceName handle }
                  }
                }
              }
            }
            metafields(first: 20) { edges { node { namespace key value type } } }
          }
        }`;
      try {
        const res = await shopifyGql(gql, { id });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.product);
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  server.registerTool(
    "supliful_search_products_by_sku",
    {
      description: "Search for Supliful products by SKU.",
      inputSchema: {
        sku: z.string().describe("SKU to search for"),
      },
    },
    async ({ sku }) => {
      const gql = `
        query SearchBySku($query: String!) {
          products(first: 10, query: $query) {
            edges {
              node {
                id title status
                variants(first: 10) {
                  edges { node { id sku title price } }
                }
              }
            }
          }
        }`;
      try {
        const res = await shopifyGql(gql, { query: `sku:${sku}` });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.products);
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ORDERS
  // ═══════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "supliful_list_orders",
    {
      description:
        "List orders in Shopify that are routed to Supliful for fulfillment. Supports filtering by status, date, and financial status.",
      inputSchema: {
        first: z.number().optional().default(25).describe("Number of orders (max 250)"),
        after: z.string().optional().describe("Pagination cursor"),
        query: z
          .string()
          .optional()
          .describe(
            "Shopify order search query e.g. 'fulfillment_status:unfulfilled financial_status:paid'"
          ),
        sortKey: z
          .enum(["CREATED_AT", "UPDATED_AT", "PROCESSED_AT", "TOTAL_PRICE", "ID"])
          .optional()
          .default("CREATED_AT"),
        reverse: z.boolean().optional().default(true),
      },
    },
    async ({ first, after, query, sortKey, reverse }) => {
      const gql = `
        query ListOrders($first: Int!, $after: String, $query: String, $sortKey: OrderSortKeys, $reverse: Boolean) {
          orders(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
            edges {
              node {
                id name email phone
                createdAt processedAt updatedAt closedAt cancelledAt
                displayFinancialStatus displayFulfillmentStatus
                totalPriceSet { shopMoney { amount currencyCode } }
                subtotalPriceSet { shopMoney { amount currencyCode } }
                totalShippingPriceSet { shopMoney { amount currencyCode } }
                lineItems(first: 20) {
                  edges {
                    node {
                      id title quantity sku
                      originalUnitPriceSet { shopMoney { amount currencyCode } }
                      variant { id sku inventoryItem { fulfillmentService { serviceName } } }
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
                note
                tags
                customAttributes { key value }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`;
      try {
        const res = await shopifyGql(gql, { first, after, query, sortKey, reverse });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.orders);
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  server.registerTool(
    "supliful_get_order",
    {
      description: "Get full details of a single order by its Shopify GID or order name (#1234).",
      inputSchema: {
        id: z.string().describe("Order GID e.g. gid://shopify/Order/12345 or order name like #1234"),
      },
    },
    async ({ id }) => {
      // Handle order name lookup
      const isName = id.startsWith("#") || /^\d+$/.test(id);
      if (isName) {
        const name = id.startsWith("#") ? id : `#${id}`;
        const searchGql = `
          query FindOrder($query: String!) {
            orders(first: 1, query: $query) {
              edges { node { id name } }
            }
          }`;
        const searchRes = await shopifyGql(searchGql, { query: `name:${name}` });
        const edges = (searchRes.data?.orders as { edges: { node: { id: string } }[] })?.edges;
        if (!edges?.length) return err(`Order ${name} not found`);
        id = edges[0].node.id;
      }

      const gql = `
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
                  variant { id sku title price inventoryItem { fulfillmentService { serviceName handle } } }
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
                        id status
                        createdAt updatedAt
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
        }`;
      try {
        const res = await shopifyGql(gql, { id });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.order);
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  server.registerTool(
    "supliful_create_order",
    {
      description:
        "Create a Shopify order that Supliful will automatically fulfill. Requires variant IDs from Supliful products published to Shopify.",
      inputSchema: {
        lineItems: z
          .array(
            z.object({
              variantId: z.string().describe("Shopify variant GID e.g. gid://shopify/ProductVariant/123"),
              quantity: z.number().int().min(1),
            })
          )
          .describe("Items to order"),
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
        }),
        email: z.string().email().describe("Customer email - required by Supliful"),
        phone: z.string().describe("Customer phone - required by Supliful"),
        internalOrderId: z.string().optional().describe("Your internal order ID stored in note and customAttributes"),
        customerId: z.string().optional().describe("Shopify customer GID to associate with order"),
        note: z.string().optional(),
        financialStatus: z.enum(["PENDING", "PAID"]).optional().default("PAID"),
        sendReceipt: z.boolean().optional().default(false),
      },
    },
    async ({
      lineItems,
      shippingAddress,
      email,
      phone,
      internalOrderId,
      customerId,
      note,
      financialStatus,
      sendReceipt,
    }) => {
      const orderNote = [note, internalOrderId ? `Internal ID: ${internalOrderId}` : ""]
        .filter(Boolean)
        .join(" | ");
      const customAttributes = internalOrderId
        ? [{ key: "internal_order_id", value: internalOrderId }]
        : [];

      const gql = `
        mutation CreateOrder($order: OrderCreateOrderInput!) {
          orderCreate(order: $order) {
            order {
              id name displayFinancialStatus displayFulfillmentStatus
              totalPriceSet { shopMoney { amount currencyCode } }
              customer { id email }
            }
            userErrors { field message }
          }
        }`;

      const orderInput: Record<string, unknown> = {
        lineItems,
        shippingAddress,
        billingAddress: shippingAddress,
        email,
        phone,
        note: orderNote,
        financialStatus,
        sendReceipt,
        sendFulfillmentReceipt: false,
        customAttributes,
      };
      if (customerId) orderInput.customerToAssociate = customerId;

      try {
        const res = await shopifyGql(gql, { order: orderInput });
        if (res.errors) return err(JSON.stringify(res.errors));
        const result = res.data?.orderCreate as { userErrors?: { field: string; message: string }[] };
        if (result?.userErrors?.length) return err(JSON.stringify(result.userErrors));
        return ok(res.data?.orderCreate);
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  server.registerTool(
    "supliful_cancel_order",
    {
      description: "Cancel a Shopify order that has not yet been fulfilled by Supliful.",
      inputSchema: {
        orderId: z.string().describe("Order GID e.g. gid://shopify/Order/12345"),
        reason: z
          .enum(["CUSTOMER", "FRAUD", "INVENTORY", "DECLINED", "OTHER"])
          .optional()
          .default("OTHER"),
        refund: z.boolean().optional().default(true).describe("Issue a refund if applicable"),
        notifyCustomer: z.boolean().optional().default(false),
      },
    },
    async ({ orderId, reason, refund, notifyCustomer }) => {
      const gql = `
        mutation CancelOrder($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!, $notifyCustomer: Boolean!) {
          orderCancel(orderId: $orderId, reason: $reason, refund: $refund, notifyCustomer: $notifyCustomer) {
            orderCancelUserErrors { field message code }
            userErrors { field message }
          }
        }`;
      try {
        const res = await shopifyGql(gql, { orderId, reason, refund, notifyCustomer });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.orderCancel);
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  server.registerTool(
    "supliful_add_order_note",
    {
      description: "Add or update a note on an existing Shopify order.",
      inputSchema: {
        orderId: z.string().describe("Order GID"),
        note: z.string().describe("Note text to set on the order"),
      },
    },
    async ({ orderId, note }) => {
      const gql = `
        mutation UpdateOrderNote($input: OrderInput!) {
          orderUpdate(input: $input) {
            order { id name note }
            userErrors { field message }
          }
        }`;
      try {
        const res = await shopifyGql(gql, { input: { id: orderId, note } });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.orderUpdate);
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  server.registerTool(
    "supliful_tag_order",
    {
      description: "Add tags to a Shopify order.",
      inputSchema: {
        orderId: z.string().describe("Order GID"),
        tags: z.array(z.string()).describe("Tags to set (replaces existing tags)"),
      },
    },
    async ({ orderId, tags }) => {
      const gql = `
        mutation TagOrder($input: OrderInput!) {
          orderUpdate(input: $input) {
            order { id name tags }
            userErrors { field message }
          }
        }`;
      try {
        const res = await shopifyGql(gql, { input: { id: orderId, tags } });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.orderUpdate);
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // FULFILLMENT
  // ═══════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "supliful_get_fulfillment_orders",
    {
      description: "Get fulfillment orders for a specific Shopify order to see Supliful fulfillment status.",
      inputSchema: {
        orderId: z.string().describe("Order GID e.g. gid://shopify/Order/12345"),
      },
    },
    async ({ orderId }) => {
      const gql = `
        query GetFulfillmentOrders($orderId: ID!) {
          order(id: $orderId) {
            id name
            fulfillmentOrders(first: 10) {
              edges {
                node {
                  id status requestStatus
                  createdAt updatedAt
                  assignedLocation { name address { address1 city country } }
                  lineItems(first: 20) {
                    edges {
                      node {
                        id remainingQuantity totalQuantity
                        lineItem { id title sku quantity }
                      }
                    }
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
        }`;
      try {
        const res = await shopifyGql(gql, { orderId });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.order);
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  server.registerTool(
    "supliful_list_unfulfilled_orders",
    {
      description:
        "List all orders that are paid but not yet fulfilled by Supliful. Useful for monitoring fulfillment queue.",
      inputSchema: {
        first: z.number().optional().default(50),
        after: z.string().optional(),
      },
    },
    async ({ first, after }) => {
      const gql = `
        query UnfulfilledOrders($first: Int!, $after: String) {
          orders(first: $first, after: $after, query: "fulfillment_status:unfulfilled financial_status:paid", sortKey: CREATED_AT, reverse: false) {
            edges {
              node {
                id name email createdAt displayFulfillmentStatus displayFinancialStatus
                totalPriceSet { shopMoney { amount currencyCode } }
                lineItems(first: 10) {
                  edges { node { title quantity sku } }
                }
                shippingAddress { firstName lastName country }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`;
      try {
        const res = await shopifyGql(gql, { first, after });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.orders);
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  server.registerTool(
    "supliful_get_tracking_info",
    {
      description: "Get tracking information for a fulfilled Supliful order.",
      inputSchema: {
        orderId: z.string().describe("Order GID e.g. gid://shopify/Order/12345"),
      },
    },
    async ({ orderId }) => {
      const gql = `
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
        }`;
      try {
        const res = await shopifyGql(gql, { orderId });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.order);
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // CUSTOMERS
  // ═══════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "supliful_create_customer",
    {
      description: "Create a customer record in Shopify before placing a Supliful order.",
      inputSchema: {
        firstName: z.string(),
        lastName: z.string(),
        email: z.string().email(),
        phone: z.string().optional(),
        note: z.string().optional(),
        tags: z.array(z.string()).optional(),
        acceptsMarketing: z.boolean().optional().default(false),
      },
    },
    async ({ firstName, lastName, email, phone, note, tags, acceptsMarketing }) => {
      const gql = `
        mutation CreateCustomer($input: CustomerInput!) {
          customerCreate(input: $input) {
            customer { id email firstName lastName phone }
            userErrors { field message }
          }
        }`;
      try {
        const res = await shopifyGql(gql, {
          input: { firstName, lastName, email, phone, note, tags, acceptsMarketing },
        });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.customerCreate);
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  server.registerTool(
    "supliful_find_customer",
    {
      description: "Find a Shopify customer by email or phone.",
      inputSchema: {
        query: z.string().describe("Search query e.g. 'email:user@example.com' or 'phone:+1555...'"),
      },
    },
    async ({ query }) => {
      const gql = `
        query FindCustomer($query: String!) {
          customers(first: 5, query: $query) {
            edges {
              node {
                id email firstName lastName phone
                createdAt updatedAt
                ordersCount totalSpent
                tags
              }
            }
          }
        }`;
      try {
        const res = await shopifyGql(gql, { query });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.customers);
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  server.registerTool(
    "supliful_get_customer",
    {
      description: "Get full customer details including order history.",
      inputSchema: {
        id: z.string().describe("Customer GID e.g. gid://shopify/Customer/12345"),
      },
    },
    async ({ id }) => {
      const gql = `
        query GetCustomer($id: ID!) {
          customer(id: $id) {
            id email firstName lastName phone note
            createdAt updatedAt
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
            tags
            ordersCount totalSpent
          }
        }`;
      try {
        const res = await shopifyGql(gql, { id });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.customer);
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  server.registerTool(
    "supliful_update_customer",
    {
      description: "Update a customer's details in Shopify.",
      inputSchema: {
        id: z.string().describe("Customer GID"),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        note: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ id, firstName, lastName, email, phone, note, tags }) => {
      const gql = `
        mutation UpdateCustomer($input: CustomerInput!) {
          customerUpdate(input: $input) {
            customer { id email firstName lastName phone }
            userErrors { field message }
          }
        }`;
      try {
        const res = await shopifyGql(gql, {
          input: { id, firstName, lastName, email, phone, note, tags },
        });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.customerUpdate);
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // WEBHOOKS
  // ═══════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "supliful_list_webhooks",
    {
      description: "List all webhook subscriptions configured in Shopify for Supliful order/fulfillment events.",
      inputSchema: {},
    },
    async () => {
      const gql = `
        query ListWebhooks {
          webhookSubscriptions(first: 50) {
            edges {
              node {
                id topic
                createdAt updatedAt
                endpoint {
                  __typename
                  ... on WebhookHttpEndpoint { callbackUrl }
                  ... on WebhookEventBridgeEndpoint { arn }
                  ... on WebhookPubSubEndpoint { pubSubProject pubSubTopic }
                }
              }
            }
          }
        }`;
      try {
        const res = await shopifyGql(gql);
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.webhookSubscriptions);
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  server.registerTool(
    "supliful_create_webhook",
    {
      description:
        "Create a webhook subscription to receive Supliful/Shopify order and fulfillment events. Common topics: ORDERS_CREATE, ORDERS_UPDATED, ORDERS_FULFILLED, ORDERS_CANCELLED, FULFILLMENTS_CREATE, FULFILLMENTS_UPDATE.",
      inputSchema: {
        topic: z
          .enum([
            "ORDERS_CREATE",
            "ORDERS_UPDATED",
            "ORDERS_FULFILLED",
            "ORDERS_CANCELLED",
            "ORDERS_PARTIALLY_FULFILLED",
            "FULFILLMENTS_CREATE",
            "FULFILLMENTS_UPDATE",
            "PRODUCTS_CREATE",
            "PRODUCTS_UPDATE",
            "PRODUCTS_DELETE",
            "CUSTOMERS_CREATE",
            "CUSTOMERS_UPDATE",
            "REFUNDS_CREATE",
          ])
          .describe("Webhook topic"),
        callbackUrl: z.string().url().describe("HTTPS URL to receive webhook payloads"),
      },
    },
    async ({ topic, callbackUrl }) => {
      const gql = `
        mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
          webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
            webhookSubscription {
              id topic
              endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } }
            }
            userErrors { field message }
          }
        }`;
      try {
        const res = await shopifyGql(gql, {
          topic,
          webhookSubscription: { callbackUrl, format: "JSON" },
        });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.webhookSubscriptionCreate);
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  server.registerTool(
    "supliful_delete_webhook",
    {
      description: "Delete a webhook subscription by its GID.",
      inputSchema: {
        id: z.string().describe("Webhook GID e.g. gid://shopify/WebhookSubscription/123"),
      },
    },
    async ({ id }) => {
      const gql = `
        mutation DeleteWebhook($id: ID!) {
          webhookSubscriptionDelete(id: $id) {
            deletedWebhookSubscriptionId
            userErrors { field message }
          }
        }`;
      try {
        const res = await shopifyGql(gql, { id });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.webhookSubscriptionDelete);
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // SHOP INFO & INVENTORY
  // ═══════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "supliful_get_shop_info",
    {
      description: "Get Shopify store info including connected fulfillment services (confirms Supliful connection).",
      inputSchema: {},
    },
    async () => {
      const gql = `
        query ShopInfo {
          shop {
            name email primaryDomain { url }
            plan { displayName partnerDevelopment }
            currencyCode
            weightUnit
            fulfillmentServices {
              serviceName handle type inventoryManagement trackingSupport
              location { name id address { address1 city country } }
            }
          }
        }`;
      try {
        const res = await shopifyGql(gql);
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.shop);
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  server.registerTool(
    "supliful_list_locations",
    {
      description: "List all Shopify locations including the Supliful fulfillment location.",
      inputSchema: {},
    },
    async () => {
      const gql = `
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
        }`;
      try {
        const res = await shopifyGql(gql);
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.locations);
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  server.registerTool(
    "supliful_check_product_inventory",
    {
      description: "Check inventory levels for a specific product across all locations including Supliful.",
      inputSchema: {
        productId: z.string().describe("Product GID"),
      },
    },
    async ({ productId }) => {
      const gql = `
        query ProductInventory($id: ID!) {
          product(id: $id) {
            id title totalInventory
            variants(first: 20) {
              edges {
                node {
                  id title sku
                  inventoryItem {
                    id tracked
                    fulfillmentService { serviceName handle }
                    inventoryLevels(first: 10) {
                      edges {
                        node {
                          id quantities(names: ["available","on_hand","committed","incoming"]) { name quantity }
                          location { id name }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }`;
      try {
        const res = await shopifyGql(gql, { id: productId });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.product);
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ANALYTICS
  // ═══════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "supliful_get_sales_summary",
    {
      description:
        "Get a sales summary for a date range. Returns order count, total revenue, and top products.",
      inputSchema: {
        startDate: z.string().describe("ISO date e.g. '2024-01-01'"),
        endDate: z.string().describe("ISO date e.g. '2024-12-31'"),
        first: z.number().optional().default(100),
      },
    },
    async ({ startDate, endDate, first }) => {
      const query = `created_at:>=${startDate} created_at:<=${endDate} financial_status:paid`;
      const gql = `
        query SalesSummary($query: String!, $first: Int!) {
          orders(first: $first, query: $query, sortKey: CREATED_AT) {
            edges {
              node {
                id name createdAt
                totalPriceSet { shopMoney { amount currencyCode } }
                displayFulfillmentStatus
                lineItems(first: 10) {
                  edges { node { title quantity sku originalUnitPriceSet { shopMoney { amount currencyCode } } } }
                }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`;
      try {
        const res = await shopifyGql(gql, { query, first });
        if (res.errors) return err(JSON.stringify(res.errors));
        const orders = (res.data?.orders as { edges: { node: { totalPriceSet: { shopMoney: { amount: string; currencyCode: string } } } }[] })?.edges || [];
        const total = orders.reduce(
          (sum: number, e) => sum + parseFloat(e.node.totalPriceSet.shopMoney.amount),
          0
        );
        return ok({
          period: { startDate, endDate },
          orderCount: orders.length,
          totalRevenue: `${total.toFixed(2)} ${orders[0]?.node.totalPriceSet.shopMoney.currencyCode ?? "USD"}`,
          orders: res.data?.orders,
        });
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  server.registerTool(
    "supliful_get_fulfillment_metrics",
    {
      description: "Get fulfillment metrics: how many orders are fulfilled vs pending vs cancelled.",
      inputSchema: {
        startDate: z.string().describe("ISO date"),
        endDate: z.string().describe("ISO date"),
      },
    },
    async ({ startDate, endDate }) => {
      const baseQuery = `created_at:>=${startDate} created_at:<=${endDate} financial_status:paid`;
      const statuses = ["fulfilled", "unfulfilled", "partial", "restocked"];
      const results: Record<string, number> = {};
      for (const status of statuses) {
        const q = `${baseQuery} fulfillment_status:${status}`;
        const gql = `query Count($query: String!) { orders(first: 1, query: $query) { edges { node { id } } pageInfo { hasNextPage } } }`;
        try {
          const res = await shopifyGql(gql, { query: q });
          results[status] = (res.data?.orders as { edges: unknown[] })?.edges?.length ?? 0;
        } catch {
          results[status] = -1;
        }
      }
      return ok({ period: { startDate, endDate }, fulfillmentBreakdown: results });
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
        orderId: z.string().describe("Order GID"),
      },
    },
    async ({ orderId }) => {
      const gql = `
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
        }`;
      try {
        const res = await shopifyGql(gql, { id: orderId });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.order);
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // DRAFT ORDERS
  // ═══════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "supliful_create_draft_order",
    {
      description:
        "Create a draft order for review before completing. Useful for manual orders with custom pricing or discounts.",
      inputSchema: {
        lineItems: z.array(
          z.object({
            variantId: z.string(),
            quantity: z.number().int().min(1),
            appliedDiscount: z
              .object({
                description: z.string().optional(),
                value: z.number(),
                valueType: z.enum(["PERCENTAGE", "FIXED_AMOUNT"]),
              })
              .optional(),
          })
        ),
        email: z.string().email(),
        phone: z.string().optional(),
        shippingAddress: z.object({
          firstName: z.string(),
          lastName: z.string(),
          address1: z.string(),
          city: z.string(),
          countryCode: z.string(),
          zip: z.string(),
          phone: z.string().optional(),
        }),
        note: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ lineItems, email, phone, shippingAddress, note, tags }) => {
      const gql = `
        mutation CreateDraftOrder($input: DraftOrderInput!) {
          draftOrderCreate(input: $input) {
            draftOrder {
              id name status
              invoiceUrl
              totalPriceSet { shopMoney { amount currencyCode } }
            }
            userErrors { field message }
          }
        }`;
      try {
        const res = await shopifyGql(gql, {
          input: { lineItems, email, phone, shippingAddress, note, tags },
        });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.draftOrderCreate);
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  server.registerTool(
    "supliful_complete_draft_order",
    {
      description: "Complete a draft order to convert it into a real Shopify order for Supliful fulfillment.",
      inputSchema: {
        draftOrderId: z.string().describe("Draft order GID e.g. gid://shopify/DraftOrder/123"),
        paymentPending: z.boolean().optional().default(false),
      },
    },
    async ({ draftOrderId, paymentPending }) => {
      const gql = `
        mutation CompleteDraftOrder($id: ID!, $paymentPending: Boolean!) {
          draftOrderComplete(id: $id, paymentPending: $paymentPending) {
            draftOrder {
              id status
              order { id name displayFinancialStatus displayFulfillmentStatus }
            }
            userErrors { field message }
          }
        }`;
      try {
        const res = await shopifyGql(gql, { id: draftOrderId, paymentPending });
        if (res.errors) return err(JSON.stringify(res.errors));
        return ok(res.data?.draftOrderComplete);
      } catch (e: unknown) {
        return err(String(e));
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // HEALTH CHECK
  // ═══════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "supliful_health_check",
    {
      description:
        "Verify that the Supliful MCP server can connect to Shopify and that the Supliful fulfillment service is active.",
      inputSchema: {},
    },
    async () => {
      try {
        const gql = `
          query HealthCheck {
            shop {
              name email
              fulfillmentServices {
                serviceName handle type inventoryManagement
              }
            }
          }`;
        const res = await shopifyGql(gql);
        if (res.errors) return err(JSON.stringify(res.errors));
        const shop = res.data?.shop as { name: string; email: string; fulfillmentServices: { serviceName: string; handle: string }[] };
        const suplifulConnected = shop?.fulfillmentServices?.some(
          (f) =>
            f.serviceName?.toLowerCase().includes("supliful") ||
            f.handle?.toLowerCase().includes("supliful")
        );
        return ok({
          status: "ok",
          shopName: shop?.name,
          shopEmail: shop?.email,
          suplifulConnected,
          fulfillmentServices: shop?.fulfillmentServices,
          shopifyApiVersion: SHOPIFY_API_VERSION,
        });
      } catch (e: unknown) {
        return err(`Connection failed: ${String(e)}`);
      }
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
    res.end(JSON.stringify({ status: "ok", service: "supliful-mcp", store: SHOPIFY_STORE }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/sse") {
    const transport = new SSEServerTransport("/messages", res);
    const sessionId = transport.sessionId;
    sessions.set(sessionId, transport);

    res.on("close", () => sessions.delete(sessionId));

    const server = createMcpServer();
    server.connect(transport).catch((e: Error) => console.error("Connect error:", e));
    return;
  }

  if (req.method === "POST" && url.pathname === "/messages") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      res.writeHead(400);
      res.end("Missing sessionId");
      return;
    }
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.writeHead(404);
      res.end("Session not found");
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      transport.handlePostMessage(req, res, body ? JSON.parse(body) : undefined);
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

httpServer.listen(PORT, () => {
  console.log(`Supliful MCP Server running on port ${PORT}`);
  console.log(`Store: ${SHOPIFY_STORE} | API: ${SHOPIFY_API_VERSION}`);
  console.log(`SSE: http://localhost:${PORT}/sse`);
});
