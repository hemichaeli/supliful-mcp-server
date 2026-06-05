import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import http from "http";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shopify GraphQL client
// ---------------------------------------------------------------------------

const SHOPIFY_STORE = process.env.SHOPIFY_STORE_DOMAIN ?? "";
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN ?? "";
const API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2025-07";
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET ?? "";
const PORT = parseInt(process.env.PORT ?? "3000", 10);

const GQL_ENDPOINT = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`;

async function gql(query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch(GQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify API HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { errors?: unknown; data?: unknown };
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function createMcpServer() {
  const server = new McpServer({
    name: "supliful-mcp-server",
    version: "1.0.0",
  });

  // =========================================================================
  // SHOP / ACCOUNT
  // =========================================================================

  server.registerTool(
    "get_shop_info",
    {
      description: "Get basic info about the connected Shopify store (name, email, domain, currency, timezone). Useful to verify connectivity and confirm which store is linked to Supliful.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const data = await gql(`query {
        shop {
          name email myshopifyDomain primaryDomain { url }
          currencyCode weightUnit timezoneAbbreviation
          plan { displayName }
          createdAt updatedAt
        }
      }`);
      return ok(data);
    }
  );

  // =========================================================================
  // PRODUCTS
  // =========================================================================

  server.registerTool(
    "list_products",
    {
      description: "List products in the Shopify store (which includes Supliful published products). Returns product ID, title, status, variants (with IDs, SKUs, prices), images, and fulfillment service info. Use cursor pagination for large catalogs.",
      inputSchema: {
        first: z.number().int().min(1).max(250).default(50).describe("Number of products to return (max 250)"),
        after: z.string().optional().describe("Pagination cursor (endCursor from previous call)"),
        query: z.string().optional().describe("Filter query e.g. 'status:active' or 'vendor:Supliful'"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ first, after, query }) => {
      const data = await gql(`
        query ListProducts($first: Int!, $after: String, $query: String) {
          products(first: $first, after: $after, query: $query) {
            edges {
              node {
                id title descriptionHtml status vendor productType
                tags handle createdAt updatedAt
                images(first: 5) { edges { node { id url altText } } }
                variants(first: 20) {
                  edges {
                    node {
                      id title sku price compareAtPrice weight weightUnit
                      availableForSale inventoryQuantity
                      inventoryItem { id tracked }
                      selectedOptions { name value }
                    }
                  }
                }
              }
              cursor
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      `, { first, after: after ?? null, query: query ?? null });
      return ok(data);
    }
  );

  server.registerTool(
    "get_product",
    {
      description: "Get full details for a single product by Shopify GID (e.g. gid://shopify/Product/123). Returns all variants, images, metafields, and fulfillment service assignment.",
      inputSchema: {
        id: z.string().describe("Shopify product GID e.g. gid://shopify/Product/123456789"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const data = await gql(`
        query GetProduct($id: ID!) {
          product(id: $id) {
            id title descriptionHtml status vendor productType handle
            tags createdAt updatedAt
            images(first: 10) { edges { node { id url altText } } }
            variants(first: 50) {
              edges {
                node {
                  id title sku price compareAtPrice weight weightUnit
                  availableForSale inventoryQuantity
                  inventoryItem { id tracked measurement { weight { unit value } } }
                  fulfillmentService { handle serviceName type }
                  selectedOptions { name value }
                }
              }
            }
            metafields(first: 20) { edges { node { namespace key value type } } }
          }
        }
      `, { id });
      return ok(data);
    }
  );

  server.registerTool(
    "get_product_by_handle",
    {
      description: "Get a product by its URL handle (slug). Useful when you know the product handle but not the GID.",
      inputSchema: {
        handle: z.string().describe("Product URL handle e.g. 'vitamin-c-1000mg'"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ handle }) => {
      const data = await gql(`
        query GetProductByHandle($handle: String!) {
          productByHandle(handle: $handle) {
            id title status descriptionHtml vendor productType handle tags
            variants(first: 50) {
              edges {
                node {
                  id title sku price compareAtPrice inventoryQuantity
                  fulfillmentService { handle serviceName }
                }
              }
            }
          }
        }
      `, { handle });
      return ok(data);
    }
  );

  server.registerTool(
    "list_supliful_products",
    {
      description: "List only products fulfilled by Supliful (those assigned to the 'supliful' fulfillment service). Returns product and variant IDs ready for order creation.",
      inputSchema: {
        first: z.number().int().min(1).max(250).default(50).describe("Number of products to return"),
        after: z.string().optional().describe("Pagination cursor"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ first, after }) => {
      // Fetch all products and filter by Supliful fulfillment service
      const data = await gql(`
        query ListProducts($first: Int!, $after: String) {
          products(first: $first, after: $after, query: "status:active") {
            edges {
              node {
                id title status handle
                variants(first: 20) {
                  edges {
                    node {
                      id title sku price
                      fulfillmentService { handle serviceName }
                    }
                  }
                }
              }
              cursor
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      `, { first, after: after ?? null });

      // Filter to Supliful variants only
      const raw = data as { products: { edges: Array<{ node: { variants: { edges: Array<{ node: { fulfillmentService?: { handle: string } } }> } } }>; pageInfo: unknown } };
      const filtered = raw.products.edges.filter(e =>
        e.node.variants.edges.some(v => v.node.fulfillmentService?.handle?.toLowerCase().includes("supliful"))
      );
      return ok({ supliful_products: filtered, pageInfo: raw.products.pageInfo });
    }
  );

  // =========================================================================
  // CUSTOMERS
  // =========================================================================

  server.registerTool(
    "list_customers",
    {
      description: "List customers in the Shopify store. Supports filtering by email, name, phone, etc.",
      inputSchema: {
        first: z.number().int().min(1).max(250).default(50).describe("Number to return"),
        after: z.string().optional().describe("Pagination cursor"),
        query: z.string().optional().describe("Filter e.g. 'email:user@example.com'"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ first, after, query }) => {
      const data = await gql(`
        query ListCustomers($first: Int!, $after: String, $query: String) {
          customers(first: $first, after: $after, query: $query) {
            edges {
              node {
                id email firstName lastName phone
                ordersCount amountSpent { amount currencyCode }
                createdAt updatedAt
                defaultAddress {
                  address1 address2 city provinceCode countryCode zip phone
                }
              }
              cursor
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      `, { first, after: after ?? null, query: query ?? null });
      return ok(data);
    }
  );

  server.registerTool(
    "get_customer",
    {
      description: "Get full details of a specific customer by GID, including all addresses and order history summary.",
      inputSchema: {
        id: z.string().describe("Customer GID e.g. gid://shopify/Customer/123456789"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const data = await gql(`
        query GetCustomer($id: ID!) {
          customer(id: $id) {
            id email firstName lastName phone
            ordersCount amountSpent { amount currencyCode }
            createdAt updatedAt
            addresses {
              address1 address2 city provinceCode countryCode zip phone firstName lastName
            }
            defaultAddress {
              address1 address2 city provinceCode countryCode zip phone
            }
            orders(first: 10, sortKey: CREATED_AT, reverse: true) {
              edges {
                node {
                  id name createdAt displayFinancialStatus displayFulfillmentStatus
                  totalPriceSet { shopMoney { amount currencyCode } }
                }
              }
            }
          }
        }
      `, { id });
      return ok(data);
    }
  );

  server.registerTool(
    "create_customer",
    {
      description: "Create a new customer in Shopify. Required before creating orders if you want to associate a customer. Returns the new customer GID.",
      inputSchema: {
        email: z.string().email().describe("Customer email address"),
        firstName: z.string().describe("First name"),
        lastName: z.string().describe("Last name"),
        phone: z.string().optional().describe("Phone in E.164 format e.g. +15555551234"),
        acceptsMarketing: z.boolean().default(false).describe("Whether customer opts in to marketing"),
        address: z.object({
          address1: z.string(),
          address2: z.string().optional(),
          city: z.string(),
          provinceCode: z.string().describe("2-letter state/province code e.g. KY"),
          countryCode: z.string().describe("2-letter country code e.g. US"),
          zip: z.string(),
          phone: z.string().optional(),
        }).optional().describe("Default shipping address"),
      },
      annotations: { destructiveHint: false },
    },
    async ({ email, firstName, lastName, phone, acceptsMarketing, address }) => {
      const input: Record<string, unknown> = { email, firstName, lastName, acceptsMarketing };
      if (phone) input.phone = phone;
      if (address) input.addresses = [address];
      const data = await gql(`
        mutation CreateCustomer($input: CustomerInput!) {
          customerCreate(input: $input) {
            customer { id email firstName lastName phone createdAt }
            userErrors { field message }
          }
        }
      `, { input });
      return ok(data);
    }
  );

  server.registerTool(
    "update_customer",
    {
      description: "Update an existing customer's details (name, email, phone, marketing preference).",
      inputSchema: {
        id: z.string().describe("Customer GID"),
        email: z.string().email().optional(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        phone: z.string().optional(),
        acceptsMarketing: z.boolean().optional(),
      },
      annotations: { idempotentHint: true },
    },
    async ({ id, ...fields }) => {
      const data = await gql(`
        mutation UpdateCustomer($input: CustomerInput!) {
          customerUpdate(input: $input) {
            customer { id email firstName lastName phone updatedAt }
            userErrors { field message }
          }
        }
      `, { input: { id, ...fields } });
      return ok(data);
    }
  );

  server.registerTool(
    "find_customer_by_email",
    {
      description: "Find a customer by email address. Returns customer GID if found, useful before creating an order.",
      inputSchema: {
        email: z.string().email().describe("Email to search for"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ email }) => {
      const data = await gql(`
        query FindCustomer($query: String!) {
          customers(first: 1, query: $query) {
            edges {
              node { id email firstName lastName phone createdAt }
            }
          }
        }
      `, { query: `email:${email}` });
      return ok(data);
    }
  );

  // =========================================================================
  // ORDERS
  // =========================================================================

  server.registerTool(
    "list_orders",
    {
      description: "List orders in the Shopify store. Filter by financial status, fulfillment status, date, customer, etc. Returns order IDs, line items, shipping address, status, and tracking.",
      inputSchema: {
        first: z.number().int().min(1).max(250).default(50).describe("Number to return"),
        after: z.string().optional().describe("Pagination cursor"),
        query: z.string().optional().describe("Filter e.g. 'financial_status:paid fulfillment_status:unfulfilled'"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ first, after, query }) => {
      const data = await gql(`
        query ListOrders($first: Int!, $after: String, $query: String) {
          orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                id name createdAt updatedAt
                displayFinancialStatus displayFulfillmentStatus
                totalPriceSet { shopMoney { amount currencyCode } }
                email phone note
                customer { id email firstName lastName }
                shippingAddress {
                  firstName lastName address1 address2 city provinceCode countryCode zip phone
                }
                lineItems(first: 20) {
                  edges {
                    node {
                      id title quantity sku variantTitle
                      originalUnitPriceSet { shopMoney { amount currencyCode } }
                      variant { id sku fulfillmentService { handle serviceName } }
                    }
                  }
                }
                fulfillments {
                  id status trackingInfo { number url company }
                  createdAt updatedAt
                }
                customAttributes { key value }
              }
              cursor
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      `, { first, after: after ?? null, query: query ?? null });
      return ok(data);
    }
  );

  server.registerTool(
    "get_order",
    {
      description: "Get full details of a specific order by GID including all line items, fulfillments, tracking, and timeline events.",
      inputSchema: {
        id: z.string().describe("Order GID e.g. gid://shopify/Order/1234567890"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const data = await gql(`
        query GetOrder($id: ID!) {
          order(id: $id) {
            id name createdAt updatedAt processedAt
            displayFinancialStatus displayFulfillmentStatus
            totalPriceSet { shopMoney { amount currencyCode } }
            subtotalPriceSet { shopMoney { amount currencyCode } }
            totalShippingPriceSet { shopMoney { amount currencyCode } }
            totalTaxSet { shopMoney { amount currencyCode } }
            email phone note
            customer { id email firstName lastName phone }
            shippingAddress {
              firstName lastName address1 address2 city provinceCode countryCode zip phone
            }
            billingAddress {
              firstName lastName address1 address2 city provinceCode countryCode zip phone
            }
            lineItems(first: 50) {
              edges {
                node {
                  id title quantity sku variantTitle
                  originalUnitPriceSet { shopMoney { amount currencyCode } }
                  variant {
                    id sku price
                    fulfillmentService { handle serviceName }
                  }
                  fulfillmentStatus
                }
              }
            }
            fulfillments {
              id status
              trackingInfo { number url company }
              createdAt updatedAt
              fulfillmentLineItems(first: 20) {
                edges { node { id quantity lineItem { id title sku } } }
              }
            }
            fulfillmentOrders(first: 10) {
              edges {
                node {
                  id status requestStatus
                  assignedLocation { name address { city countryCode } }
                  lineItems(first: 20) {
                    edges { node { id remainingQuantity totalQuantity lineItem { id title } } }
                  }
                }
              }
            }
            transactions(first: 10) {
              id kind status gateway amount { amount currencyCode }
              processedAt
            }
            customAttributes { key value }
            tags
          }
        }
      `, { id });
      return ok(data);
    }
  );

  server.registerTool(
    "create_order",
    {
      description: "Create a new Shopify order for Supliful fulfillment. This is the primary way to submit orders from a custom app. Requires line items with exact Shopify variant GIDs, shipping address with phone, customer email, and financial status PAID. Supliful will auto-fulfill if automatic fulfillment is enabled.",
      inputSchema: {
        lineItems: z.array(z.object({
          variantId: z.string().describe("Shopify variant GID e.g. gid://shopify/ProductVariant/123456"),
          quantity: z.number().int().min(1),
        })).min(1).describe("Line items to order"),
        shippingAddress: z.object({
          firstName: z.string(),
          lastName: z.string(),
          address1: z.string(),
          address2: z.string().optional(),
          city: z.string(),
          provinceCode: z.string().describe("2-letter state/province"),
          countryCode: z.string().describe("2-letter country code"),
          zip: z.string(),
          phone: z.string().describe("Required by Supliful - E.164 format"),
        }),
        billingAddress: z.object({
          firstName: z.string(),
          lastName: z.string(),
          address1: z.string(),
          address2: z.string().optional(),
          city: z.string(),
          provinceCode: z.string(),
          countryCode: z.string(),
          zip: z.string(),
          phone: z.string().optional(),
        }).optional().describe("Defaults to shipping address if not provided"),
        email: z.string().email().describe("Customer email - required by Supliful"),
        phone: z.string().optional().describe("Customer phone"),
        note: z.string().optional().describe("Internal note e.g. your app order ID"),
        financialStatus: z.enum(["PENDING", "AUTHORIZED", "PARTIALLY_PAID", "PAID", "PARTIALLY_REFUNDED", "REFUNDED", "VOIDED"]).default("PAID"),
        sendReceipt: z.boolean().default(false),
        sendFulfillmentReceipt: z.boolean().default(false),
        customAttributes: z.array(z.object({ key: z.string(), value: z.string() })).optional().describe("Key-value pairs e.g. [{key: 'internal_order_id', value: 'APP-123'}]"),
        customerId: z.string().optional().describe("Customer GID to associate with order"),
      },
      annotations: { destructiveHint: false },
    },
    async ({ lineItems, shippingAddress, billingAddress, email, phone, note, financialStatus, sendReceipt, sendFulfillmentReceipt, customAttributes, customerId }) => {
      const order: Record<string, unknown> = {
        lineItems,
        shippingAddress,
        billingAddress: billingAddress ?? shippingAddress,
        email,
        financialStatus,
        sendReceipt,
        sendFulfillmentReceipt,
      };
      if (phone) order.phone = phone;
      if (note) order.note = note;
      if (customAttributes) order.customAttributes = customAttributes;
      if (customerId) order.customerToAssociate = { customerId };

      const data = await gql(`
        mutation CreateOrder($order: OrderCreateOrderInput!) {
          orderCreate(order: $order) {
            order {
              id name createdAt
              displayFinancialStatus displayFulfillmentStatus
              totalPriceSet { shopMoney { amount currencyCode } }
              customer { id email }
            }
            userErrors { field message }
          }
        }
      `, { order });
      return ok(data);
    }
  );

  server.registerTool(
    "assign_customer_to_order",
    {
      description: "Associate an existing customer with an order using orderCustomerSet mutation. Use this after order creation if you didn't include customerToAssociate.",
      inputSchema: {
        orderId: z.string().describe("Order GID"),
        customerId: z.string().describe("Customer GID"),
      },
    },
    async ({ orderId, customerId }) => {
      const data = await gql(`
        mutation AssignCustomer($orderId: ID!, $customerId: ID!) {
          orderCustomerSet(input: { orderId: $orderId, customerId: $customerId }) {
            order { id name customer { id email firstName lastName } }
            userErrors { field message }
          }
        }
      `, { orderId, customerId });
      return ok(data);
    }
  );

  server.registerTool(
    "cancel_order",
    {
      description: "Cancel a Shopify order. Supliful will also stop processing it if it hasn't been picked.",
      inputSchema: {
        id: z.string().describe("Order GID"),
        reason: z.enum(["CUSTOMER", "FRAUD", "INVENTORY", "DECLINED", "OTHER"]).default("OTHER"),
        notifyCustomer: z.boolean().default(false),
        refund: z.boolean().default(false).describe("Whether to issue a refund"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ id, reason, notifyCustomer, refund }) => {
      const data = await gql(`
        mutation CancelOrder($id: ID!, $reason: OrderCancelReason!, $notifyCustomer: Boolean!, $refund: Boolean!) {
          orderCancel(orderId: $id, reason: $reason, notifyCustomer: $notifyCustomer, refund: $refund) {
            order { id name displayFinancialStatus cancelledAt }
            userErrors { field message }
          }
        }
      `, { id, reason, notifyCustomer, refund });
      return ok(data);
    }
  );

  server.registerTool(
    "update_order",
    {
      description: "Update order metadata: note, tags, email, shipping address (if not fulfilled yet).",
      inputSchema: {
        id: z.string().describe("Order GID"),
        note: z.string().optional(),
        email: z.string().email().optional(),
        tags: z.array(z.string()).optional(),
        shippingAddress: z.object({
          firstName: z.string().optional(),
          lastName: z.string().optional(),
          address1: z.string().optional(),
          address2: z.string().optional(),
          city: z.string().optional(),
          provinceCode: z.string().optional(),
          countryCode: z.string().optional(),
          zip: z.string().optional(),
          phone: z.string().optional(),
        }).optional(),
      },
    },
    async ({ id, note, email, tags, shippingAddress }) => {
      const input: Record<string, unknown> = { id };
      if (note !== undefined) input.note = note;
      if (email !== undefined) input.email = email;
      if (tags !== undefined) input.tags = tags;
      if (shippingAddress !== undefined) input.shippingAddress = shippingAddress;
      const data = await gql(`
        mutation UpdateOrder($input: OrderInput!) {
          orderUpdate(input: $input) {
            order { id name note updatedAt }
            userErrors { field message }
          }
        }
      `, { input });
      return ok(data);
    }
  );

  server.registerTool(
    "add_order_tags",
    {
      description: "Add tags to an order for organization and tracking.",
      inputSchema: {
        id: z.string().describe("Order GID"),
        tags: z.array(z.string()).describe("Tags to add"),
      },
    },
    async ({ id, tags }) => {
      const data = await gql(`
        mutation AddTags($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) {
            node { id }
            userErrors { field message }
          }
        }
      `, { id, tags });
      return ok(data);
    }
  );

  // =========================================================================
  // FULFILLMENTS
  // =========================================================================

  server.registerTool(
    "get_fulfillment_orders",
    {
      description: "Get fulfillment orders for a specific Shopify order. Shows which fulfillment service (Supliful) has been assigned and the current request/fulfillment status.",
      inputSchema: {
        orderId: z.string().describe("Order GID e.g. gid://shopify/Order/123"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ orderId }) => {
      const data = await gql(`
        query GetFulfillmentOrders($orderId: ID!) {
          order(id: $orderId) {
            id name
            fulfillmentOrders(first: 20) {
              edges {
                node {
                  id status requestStatus
                  createdAt updatedAt
                  assignedLocation {
                    name
                    address { address1 city provinceCode countryCode zip }
                  }
                  fulfillmentService { handle serviceName type }
                  lineItems(first: 50) {
                    edges {
                      node {
                        id remainingQuantity totalQuantity
                        lineItem { id title sku quantity variantTitle }
                      }
                    }
                  }
                  deliveryMethod { methodType minDeliveryDateTime maxDeliveryDateTime }
                }
              }
            }
          }
        }
      `, { orderId });
      return ok(data);
    }
  );

  server.registerTool(
    "get_fulfillment",
    {
      description: "Get full details of a specific fulfillment including tracking number, carrier, and tracking URL. This is what Supliful populates when it ships an order.",
      inputSchema: {
        id: z.string().describe("Fulfillment GID e.g. gid://shopify/Fulfillment/123"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const data = await gql(`
        query GetFulfillment($id: ID!) {
          fulfillment(id: $id) {
            id status createdAt updatedAt
            trackingInfo { number url company }
            order { id name email }
            fulfillmentLineItems(first: 50) {
              edges {
                node {
                  id quantity
                  lineItem { id title sku variantTitle }
                }
              }
            }
          }
        }
      `, { id });
      return ok(data);
    }
  );

  server.registerTool(
    "create_fulfillment",
    {
      description: "Manually create a fulfillment for an order (if you are not using auto-fulfillment). Specify the fulfillment order IDs and optionally tracking information.",
      inputSchema: {
        fulfillmentOrderIds: z.array(z.string()).min(1).describe("Fulfillment order GIDs to fulfill"),
        trackingInfo: z.object({
          number: z.string().describe("Tracking number"),
          url: z.string().url().optional().describe("Tracking URL"),
          company: z.string().optional().describe("Carrier name"),
        }).optional(),
        notifyCustomer: z.boolean().default(true),
      },
    },
    async ({ fulfillmentOrderIds, trackingInfo, notifyCustomer }) => {
      const fulfillment: Record<string, unknown> = {
        lineItemsByFulfillmentOrder: fulfillmentOrderIds.map(id => ({ fulfillmentOrderId: id })),
        notifyCustomer,
      };
      if (trackingInfo) fulfillment.trackingInfo = trackingInfo;

      const data = await gql(`
        mutation CreateFulfillment($fulfillment: FulfillmentV2Input!) {
          fulfillmentCreateV2(fulfillment: $fulfillment) {
            fulfillment {
              id status createdAt
              trackingInfo { number url company }
            }
            userErrors { field message }
          }
        }
      `, { fulfillment });
      return ok(data);
    }
  );

  server.registerTool(
    "update_fulfillment_tracking",
    {
      description: "Update tracking information on an existing fulfillment. Useful when you receive tracking updates from Supliful via webhook.",
      inputSchema: {
        fulfillmentId: z.string().describe("Fulfillment GID"),
        trackingInfoUpdateInput: z.object({
          numbers: z.array(z.string()).optional().describe("Tracking numbers"),
          urls: z.array(z.string()).optional().describe("Tracking URLs"),
          company: z.string().optional().describe("Carrier name"),
        }),
        notifyCustomer: z.boolean().default(true),
      },
    },
    async ({ fulfillmentId, trackingInfoUpdateInput, notifyCustomer }) => {
      const data = await gql(`
        mutation UpdateTracking($fulfillmentId: ID!, $trackingInfoUpdateInput: FulfillmentTrackingInput!, $notifyCustomer: Boolean) {
          fulfillmentTrackingInfoUpdateV2(
            fulfillmentId: $fulfillmentId
            trackingInfoUpdateInput: $trackingInfoUpdateInput
            notifyCustomer: $notifyCustomer
          ) {
            fulfillment {
              id status
              trackingInfo { number url company }
              updatedAt
            }
            userErrors { field message }
          }
        }
      `, { fulfillmentId, trackingInfoUpdateInput, notifyCustomer });
      return ok(data);
    }
  );

  server.registerTool(
    "submit_fulfillment_request",
    {
      description: "Submit a fulfillment request to Supliful for a specific fulfillment order. Use this when automatic fulfillment is disabled and you want to manually trigger Supliful to process the order.",
      inputSchema: {
        fulfillmentOrderId: z.string().describe("Fulfillment order GID"),
        message: z.string().optional().describe("Optional message to Supliful"),
      },
    },
    async ({ fulfillmentOrderId, message }) => {
      const data = await gql(`
        mutation SubmitFulfillmentRequest($id: ID!, $message: String) {
          fulfillmentOrderSubmitFulfillmentRequest(id: $id, message: $message) {
            submittedFulfillmentOrder { id requestStatus }
            unsubmittedFulfillmentOrder { id requestStatus }
            originalFulfillmentOrder { id requestStatus }
            userErrors { field message }
          }
        }
      `, { id: fulfillmentOrderId, message: message ?? null });
      return ok(data);
    }
  );

  server.registerTool(
    "cancel_fulfillment_request",
    {
      description: "Cancel a pending fulfillment request sent to Supliful. Only works if Supliful hasn't started processing yet.",
      inputSchema: {
        fulfillmentOrderId: z.string().describe("Fulfillment order GID"),
        message: z.string().optional(),
      },
      annotations: { destructiveHint: true },
    },
    async ({ fulfillmentOrderId, message }) => {
      const data = await gql(`
        mutation CancelFulfillmentRequest($id: ID!, $message: String) {
          fulfillmentOrderSubmitCancellationRequest(id: $id, message: $message) {
            fulfillmentOrder { id requestStatus status }
            userErrors { field message }
          }
        }
      `, { id: fulfillmentOrderId, message: message ?? null });
      return ok(data);
    }
  );

  // =========================================================================
  // INVENTORY
  // =========================================================================

  server.registerTool(
    "get_inventory_levels",
    {
      description: "Get inventory levels for a specific product variant across all locations. Supliful products typically show 'on demand' (untracked) inventory.",
      inputSchema: {
        inventoryItemId: z.string().describe("Inventory item GID (from variant.inventoryItem.id)"),
        first: z.number().int().default(10).describe("Number of locations"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ inventoryItemId, first }) => {
      const data = await gql(`
        query GetInventory($inventoryItemId: ID!, $first: Int!) {
          inventoryItem(id: $inventoryItemId) {
            id tracked sku
            inventoryLevels(first: $first) {
              edges {
                node {
                  id available
                  location { id name isActive }
                  updatedAt
                }
              }
            }
          }
        }
      `, { inventoryItemId, first });
      return ok(data);
    }
  );

  server.registerTool(
    "list_locations",
    {
      description: "List all fulfillment locations including the Supliful Fulfillment location. Returns location IDs needed for inventory and fulfillment operations.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const data = await gql(`
        query {
          locations(first: 50) {
            edges {
              node {
                id name isActive isFulfillmentService
                address { address1 city provinceCode countryCode zip }
                fulfillmentService { handle serviceName }
              }
            }
          }
        }
      `);
      return ok(data);
    }
  );

  // =========================================================================
  // WEBHOOKS
  // =========================================================================

  server.registerTool(
    "list_webhooks",
    {
      description: "List all webhook subscriptions configured on this Shopify store. Shows which events (orders fulfilled, fulfillments created/updated, etc.) are being forwarded to which endpoints.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const data = await gql(`
        query {
          webhookSubscriptions(first: 50) {
            edges {
              node {
                id topic
                endpoint {
                  __typename
                  ... on WebhookHttpEndpoint { callbackUrl }
                  ... on WebhookEventBridgeEndpoint { arn }
                  ... on WebhookPubSubEndpoint { pubSubProject pubSubTopic }
                }
                createdAt updatedAt
              }
            }
          }
        }
      `);
      return ok(data);
    }
  );

  server.registerTool(
    "create_webhook",
    {
      description: "Subscribe to Shopify webhook events. For Supliful integrations, key topics are: ORDERS_FULFILLED, FULFILLMENTS_CREATE, FULFILLMENTS_UPDATE, ORDERS_CANCELLED, ORDERS_UPDATED, ORDERS_PAID, PRODUCTS_CREATE, PRODUCTS_UPDATE, PRODUCTS_DELETE.",
      inputSchema: {
        topic: z.enum([
          "ORDERS_FULFILLED",
          "ORDERS_CANCELLED",
          "ORDERS_UPDATED",
          "ORDERS_PAID",
          "ORDERS_CREATED",
          "FULFILLMENTS_CREATE",
          "FULFILLMENTS_UPDATE",
          "INVENTORY_LEVELS_UPDATE",
          "PRODUCTS_CREATE",
          "PRODUCTS_UPDATE",
          "PRODUCTS_DELETE",
          "CUSTOMERS_CREATE",
          "CUSTOMERS_UPDATE",
          "CUSTOMERS_DELETE",
          "REFUNDS_CREATE",
          "DISPUTES_CREATE",
          "DISPUTES_UPDATE",
          "APP_UNINSTALLED",
          "SHOP_UPDATE",
        ]).describe("Webhook topic to subscribe to"),
        callbackUrl: z.string().url().describe("HTTPS endpoint to receive webhook payloads"),
        format: z.enum(["JSON", "XML"]).default("JSON"),
      },
    },
    async ({ topic, callbackUrl, format }) => {
      const data = await gql(`
        mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
          webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
            webhookSubscription {
              id topic
              endpoint {
                __typename
                ... on WebhookHttpEndpoint { callbackUrl }
              }
              createdAt
            }
            userErrors { field message }
          }
        }
      `, { topic, webhookSubscription: { callbackUrl, format } });
      return ok(data);
    }
  );

  server.registerTool(
    "delete_webhook",
    {
      description: "Delete a webhook subscription by GID.",
      inputSchema: {
        id: z.string().describe("Webhook subscription GID e.g. gid://shopify/WebhookSubscription/123"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ id }) => {
      const data = await gql(`
        mutation DeleteWebhook($id: ID!) {
          webhookSubscriptionDelete(id: $id) {
            deletedWebhookSubscriptionId
            userErrors { field message }
          }
        }
      `, { id });
      return ok(data);
    }
  );

  server.registerTool(
    "update_webhook",
    {
      description: "Update an existing webhook subscription's callback URL or format.",
      inputSchema: {
        id: z.string().describe("Webhook subscription GID"),
        callbackUrl: z.string().url().optional().describe("New callback URL"),
        format: z.enum(["JSON", "XML"]).optional(),
      },
    },
    async ({ id, callbackUrl, format }) => {
      const webhookSubscription: Record<string, unknown> = {};
      if (callbackUrl) webhookSubscription.callbackUrl = callbackUrl;
      if (format) webhookSubscription.format = format;
      const data = await gql(`
        mutation UpdateWebhook($id: ID!, $webhookSubscription: WebhookSubscriptionInput!) {
          webhookSubscriptionUpdate(id: $id, webhookSubscription: $webhookSubscription) {
            webhookSubscription {
              id topic
              endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } }
              updatedAt
            }
            userErrors { field message }
          }
        }
      `, { id, webhookSubscription });
      return ok(data);
    }
  );

  // =========================================================================
  // DRAFT ORDERS
  // =========================================================================

  server.registerTool(
    "create_draft_order",
    {
      description: "Create a draft order (alternative to orderCreate). Useful for reviewing before completing. Draft orders can be sent as invoices or completed to create real orders.",
      inputSchema: {
        lineItems: z.array(z.object({
          variantId: z.string().describe("Variant GID"),
          quantity: z.number().int().min(1),
        })).min(1),
        shippingAddress: z.object({
          firstName: z.string(),
          lastName: z.string(),
          address1: z.string(),
          city: z.string(),
          provinceCode: z.string(),
          countryCode: z.string(),
          zip: z.string(),
          phone: z.string(),
        }),
        email: z.string().email(),
        note: z.string().optional(),
        tags: z.array(z.string()).optional(),
        customAttributes: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
      },
    },
    async ({ lineItems, shippingAddress, email, note, tags, customAttributes }) => {
      const input: Record<string, unknown> = { lineItems, shippingAddress, email };
      if (note) input.note = note;
      if (tags) input.tags = tags;
      if (customAttributes) input.customAttributes = customAttributes;
      const data = await gql(`
        mutation CreateDraftOrder($input: DraftOrderInput!) {
          draftOrderCreate(input: $input) {
            draftOrder {
              id name status
              totalPriceSet { shopMoney { amount currencyCode } }
              invoiceUrl createdAt
            }
            userErrors { field message }
          }
        }
      `, { input });
      return ok(data);
    }
  );

  server.registerTool(
    "complete_draft_order",
    {
      description: "Complete a draft order to create a real order. The completed order will be routed to Supliful for fulfillment.",
      inputSchema: {
        id: z.string().describe("Draft order GID"),
        paymentPending: z.boolean().default(false).describe("Set true if payment not yet received"),
      },
    },
    async ({ id, paymentPending }) => {
      const data = await gql(`
        mutation CompleteDraftOrder($id: ID!, $paymentPending: Boolean!) {
          draftOrderComplete(id: $id, paymentPending: $paymentPending) {
            draftOrder {
              id order {
                id name displayFulfillmentStatus displayFinancialStatus
                totalPriceSet { shopMoney { amount currencyCode } }
              }
            }
            userErrors { field message }
          }
        }
      `, { id, paymentPending });
      return ok(data);
    }
  );

  server.registerTool(
    "list_draft_orders",
    {
      description: "List draft orders. Useful for checking pending orders awaiting completion.",
      inputSchema: {
        first: z.number().int().default(20),
        after: z.string().optional(),
        query: z.string().optional().describe("Filter e.g. 'status:open'"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ first, after, query }) => {
      const data = await gql(`
        query ListDraftOrders($first: Int!, $after: String, $query: String) {
          draftOrders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                id name status email createdAt updatedAt
                totalPriceSet { shopMoney { amount currencyCode } }
                customer { id email firstName lastName }
                lineItems(first: 10) {
                  edges { node { id title quantity variantTitle } }
                }
              }
              cursor
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      `, { first, after: after ?? null, query: query ?? null });
      return ok(data);
    }
  );

  // =========================================================================
  // REFUNDS
  // =========================================================================

  server.registerTool(
    "create_refund",
    {
      description: "Create a refund on an order. Note: Supliful has its own refund/replacement policy - check their policy before issuing refunds for fulfillment issues.",
      inputSchema: {
        orderId: z.string().describe("Order GID"),
        note: z.string().optional().describe("Reason for refund"),
        notify: z.boolean().default(true),
        refundLineItems: z.array(z.object({
          lineItemId: z.string().describe("Line item GID"),
          quantity: z.number().int().min(1),
          restockType: z.enum(["RETURN", "CANCEL", "NO_RESTOCK", "LEGACY_RESTOCK"]).default("NO_RESTOCK"),
        })).optional(),
      },
    },
    async ({ orderId, note, notify, refundLineItems }) => {
      const refund: Record<string, unknown> = { orderId, notify };
      if (note) refund.note = note;
      if (refundLineItems) refund.refundLineItems = refundLineItems;
      const data = await gql(`
        mutation CreateRefund($refund: RefundInput!) {
          refundCreate(refund: $refund) {
            refund {
              id createdAt note
              totalRefundedSet { shopMoney { amount currencyCode } }
            }
            order { id displayFinancialStatus }
            userErrors { field message }
          }
        }
      `, { refund });
      return ok(data);
    }
  );

  server.registerTool(
    "get_order_refunds",
    {
      description: "Get all refunds on a specific order.",
      inputSchema: {
        orderId: z.string().describe("Order GID"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ orderId }) => {
      const data = await gql(`
        query GetRefunds($orderId: ID!) {
          order(id: $orderId) {
            id name
            refunds {
              id createdAt note
              totalRefundedSet { shopMoney { amount currencyCode } }
              refundLineItems(first: 20) {
                edges {
                  node {
                    quantity restockType
                    lineItem { id title sku }
                    priceSet { shopMoney { amount currencyCode } }
                  }
                }
              }
            }
          }
        }
      `, { orderId });
      return ok(data);
    }
  );

  // =========================================================================
  // FULFILLMENT SERVICES
  // =========================================================================

  server.registerTool(
    "list_fulfillment_services",
    {
      description: "List all fulfillment services connected to this Shopify store. The Supliful fulfillment service should appear here when the app is installed correctly.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const data = await gql(`
        query {
          fulfillmentServices {
            id handle serviceName type
            inventoryManagement callbackUrl
            fulfillmentOrdersOptIn
          }
        }
      `);
      return ok(data);
    }
  );

  // =========================================================================
  // SHIPPING
  // =========================================================================

  server.registerTool(
    "get_shipping_zones",
    {
      description: "Get all shipping zones and rates configured on the store, including Supliful Fulfillment shipping zones.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const data = await gql(`
        query {
          deliveryProfiles(first: 20) {
            edges {
              node {
                id name isDefault
                profileItems(first: 10) {
                  edges {
                    node {
                      product { id title }
                      variants { edges { node { id title } } }
                    }
                  }
                }
                profileLocationGroups {
                  locationGroupZones(first: 20) {
                    edges {
                      node {
                        zone {
                          id name
                          countries { name code { countryCode } }
                        }
                        methodDefinitions(first: 10) {
                          edges {
                            node {
                              id name active
                              rateProvider {
                                ... on DeliveryRateDefinition {
                                  price { amount currencyCode }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `);
      return ok(data);
    }
  );

  // =========================================================================
  // PRICE RULES & DISCOUNTS
  // =========================================================================

  server.registerTool(
    "list_price_rules",
    {
      description: "List discount price rules on the store.",
      inputSchema: {
        first: z.number().int().default(20),
        after: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ first, after }) => {
      const data = await gql(`
        query ListPriceRules($first: Int!, $after: String) {
          priceRules(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                id title status startsAt endsAt
                valueV2 { ... on MoneyV2 { amount currencyCode } ... on PricingPercentageValue { percentage } }
                usageLimit
                discountCodes(first: 5) { edges { node { code } } }
              }
              cursor
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      `, { first, after: after ?? null });
      return ok(data);
    }
  );

  // =========================================================================
  // ANALYTICS / REPORTS
  // =========================================================================

  server.registerTool(
    "get_order_analytics",
    {
      description: "Get order count and revenue summary for Supliful orders within a date range.",
      inputSchema: {
        startDate: z.string().describe("ISO date e.g. 2025-01-01"),
        endDate: z.string().describe("ISO date e.g. 2025-12-31"),
        fulfillmentService: z.string().default("supliful").describe("Filter by fulfillment service handle"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ startDate, endDate, fulfillmentService }) => {
      const query = `created_at:>='${startDate}' created_at:<='${endDate}'`;
      const data = await gql(`
        query OrderAnalytics($query: String!) {
          orders(first: 250, query: $query) {
            edges {
              node {
                id name createdAt displayFulfillmentStatus displayFinancialStatus
                totalPriceSet { shopMoney { amount currencyCode } }
                lineItems(first: 20) {
                  edges {
                    node {
                      title quantity
                      variant { fulfillmentService { handle } }
                      originalTotalSet { shopMoney { amount currencyCode } }
                    }
                  }
                }
              }
            }
            pageInfo { hasNextPage }
          }
        }
      `, { query });

      // Compute summary
      const raw = data as { orders: { edges: Array<{ node: { totalPriceSet: { shopMoney: { amount: string } }; lineItems: { edges: Array<{ node: { variant?: { fulfillmentService?: { handle: string } }; originalTotalSet: { shopMoney: { amount: string } } } }> } } }> } };
      let totalOrders = 0;
      let suplifulRevenue = 0;
      for (const edge of raw.orders.edges) {
        let hasSupliful = false;
        for (const li of edge.node.lineItems.edges) {
          if (li.node.variant?.fulfillmentService?.handle?.toLowerCase().includes(fulfillmentService)) {
            hasSupliful = true;
            suplifulRevenue += parseFloat(li.node.originalTotalSet.shopMoney.amount);
          }
        }
        if (hasSupliful) totalOrders++;
      }

      return ok({ summary: { totalOrders, suplifulRevenue: suplifulRevenue.toFixed(2), startDate, endDate }, rawData: data });
    }
  );

  // =========================================================================
  // UTILITY
  // =========================================================================

  server.registerTool(
    "run_graphql_query",
    {
      description: "Run an arbitrary read-only Shopify Admin GraphQL query. Use this for advanced queries not covered by other tools. Only use query operations, not mutations.",
      inputSchema: {
        query: z.string().describe("GraphQL query string (read-only, no mutations)"),
        variables: z.record(z.unknown()).optional().describe("Query variables"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, variables }) => {
      if (/mutation/i.test(query)) {
        throw new Error("Use run_graphql_mutation for mutations. This tool is read-only.");
      }
      const data = await gql(query, variables ?? {});
      return ok(data);
    }
  );

  server.registerTool(
    "run_graphql_mutation",
    {
      description: "Run an arbitrary Shopify Admin GraphQL mutation. Use with caution - this can modify store data. Prefer specific tools when available.",
      inputSchema: {
        mutation: z.string().describe("GraphQL mutation string"),
        variables: z.record(z.unknown()).optional(),
      },
      annotations: { destructiveHint: true },
    },
    async ({ mutation, variables }) => {
      const data = await gql(mutation, variables ?? {});
      return ok(data);
    }
  );

  server.registerTool(
    "get_api_info",
    {
      description: "Get info about the connected store and API configuration (store domain, API version). Does not expose the token.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      return ok({
        store: SHOPIFY_STORE,
        apiVersion: API_VERSION,
        endpoint: GQL_ENDPOINT,
        webhookSecretConfigured: !!SHOPIFY_WEBHOOK_SECRET,
      });
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP server with SSE transport
// ---------------------------------------------------------------------------

const sessions = new Map<string, SSEServerTransport>();

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", store: SHOPIFY_STORE, version: "1.0.0" }));
    return;
  }

  if (url.pathname === "/sse" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    const transport = new SSEServerTransport("/messages", res);
    const server = createMcpServer();
    sessions.set(transport.sessionId, transport);

    req.on("close", () => {
      sessions.delete(transport.sessionId);
    });

    await server.connect(transport);
    return;
  }

  if (url.pathname === "/messages" && req.method === "POST") {
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.writeHead(404);
      res.end("Session not found");
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        await transport.handlePostMessage(req, res, JSON.parse(body));
      } catch (err) {
        console.error("handlePostMessage error:", err);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end("Internal error");
        }
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

httpServer.listen(PORT, () => {
  console.log(`Supliful MCP Server running on port ${PORT}`);
  console.log(`  Store: ${SHOPIFY_STORE}`);
  console.log(`  API version: ${API_VERSION}`);
  console.log(`  SSE: http://localhost:${PORT}/sse`);
  console.log(`  Health: http://localhost:${PORT}/health`);
});
