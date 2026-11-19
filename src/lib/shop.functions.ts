import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Json } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { stockKey, validateCart, type StockMap } from "./cart-logic";

const SHIPPING_COUNTRIES = ["FR", "BE", "CH", "LU", "DE", "ES", "IT", "NL", "PT", "GB", "CA", "US", "SN", "CI", "ML", "CM", "GN"];

async function readStock(): Promise<StockMap> {
  // Stock rows are not readable directly by visitors; the server reads them and returns only quantities.
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.from("product_stock").select("product_slug, size, quantity");
  if (error) {
    console.error("[stock]", error.message);
    throw new Error("Stock indisponible");
  }
  const map: StockMap = {};
  for (const row of data) map[stockKey(row.product_slug, row.size)] = row.quantity;
  return map;
}

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

const DEV_ORIGIN = /^https?:\/\/(localhost(:\d+)?|127\.0\.0\.1(:\d+)?|[a-z0-9-]+\.lovable\.app|[a-z0-9-]+\.lovableproject\.com)$/;

/** Where Stripe sends shoppers back: always this site, never a caller-chosen host. */
async function trustedOrigin(clientOrigin: string): Promise<string> {
  const { getRequest } = await import("@tanstack/react-start/server");
  const requestOrigin = new URL(getRequest().url).origin;
  const host = new URL(requestOrigin).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") return requestOrigin;
  // Local dev server behind the editor preview: only accept known preview hosts.
  const candidate = new URL(clientOrigin).origin;
  return DEV_ORIGIN.test(candidate) ? candidate : requestOrigin;
}

export const getStock = createServerFn({ method: "GET" }).handler(async () => readStock());

const checkoutInput = z.object({
  lines: z
    .array(z.object({ slug: z.string().max(80), size: z.string().max(40), qty: z.number().int().min(1).max(50) }))
    .min(1)
    .max(30),
  origin: z.string().url().refine((u) => /^https?:\/\//.test(u)),
});

export const createCheckout = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => checkoutInput.parse(input))
  .handler(async ({ data }): Promise<{ url: string } | { error: string }> => {
    const check = validateCart(data.lines, await readStock());
    if (!check.ok) return { error: check.message };

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { stripeRequest } = await import("./stripe.server");
    type Session = import("./stripe.server").StripeSession;

    // Secret handed only to this buyer (in their return link) so only they can confirm the order.
    const confirmToken = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const { data: order, error } = await supabaseAdmin
      .from("orders")
      .insert({
        items: check.items as unknown as Json,
        amount_total: Math.round(check.total * 100),
        confirm_token_hash: await sha256Hex(confirmToken),
      })
      .select("id")
      .single();
    if (error || !order) {
      console.error("[checkout] order insert", error?.message);
      return { error: "Impossible de créer la commande. Réessayez." };
    }

    const origin = await trustedOrigin(data.origin);
    const params: Record<string, string> = {
      mode: "payment",
      locale: "fr",
      client_reference_id: order.id,
      "metadata[order_id]": order.id,
      success_url: `${origin}/commande/confirmation?session_id={CHECKOUT_SESSION_ID}&t=${confirmToken}`,
      cancel_url: `${origin}/boutique`,
      "phone_number_collection[enabled]": "true",
    };
    SHIPPING_COUNTRIES.forEach((c, i) => {
      params[`shipping_address_collection[allowed_countries][${i}]`] = c;
    });
    check.items.forEach((item, i) => {
      params[`line_items[${i}][quantity]`] = String(item.qty);
      params[`line_items[${i}][price_data][currency]`] = "eur";
      params[`line_items[${i}][price_data][unit_amount]`] = String(Math.round(item.price * 100));
      params[`line_items[${i}][price_data][product_data][name]`] = `${item.name} — ${item.size}`;
    });

    try {
      const session = await stripeRequest<Session>("checkout/sessions", "POST", params);
      await supabaseAdmin.from("orders").update({ stripe_session_id: session.id }).eq("id", order.id);
      if (!session.url) return { error: "Le paiement n'a pas pu démarrer." };
      return { url: session.url };
    } catch (e) {
      await supabaseAdmin.from("orders").delete().eq("id", order.id);
      return { error: e instanceof Error ? e.message : "Le paiement n'a pas pu démarrer." };
    }
  });

async function fulfillFromStripe(sessionId: string) {
  const { stripeRequest, sessionShipping } = await import("./stripe.server");
  type Session = import("./stripe.server").StripeSession;
  const session = await stripeRequest<Session>(`checkout/sessions/${encodeURIComponent(sessionId)}`);
  if (session.payment_status === "paid") {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.rpc("fulfill_order", {
      _session_id: session.id,
      _email: session.customer_details?.email ?? "",
      _name: session.customer_details?.name ?? "",
      _shipping: (sessionShipping(session) ?? {}) as Json,
      _amount: session.amount_total ?? 0,
    });
    if (error) console.error("[fulfill]", error.message);
  }
  return session;
}

/** Called from the thank-you page: requires the buyer's secret, verifies the payment with Stripe, then records it. */
export const confirmCheckout = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        sessionId: z.string().max(255).regex(/^cs_[A-Za-z0-9_]+$/),
        token: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ paid: boolean }> => {
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: order } = await supabaseAdmin
        .from("orders")
        .select("status, confirm_token_hash")
        .eq("stripe_session_id", data.sessionId)
        .maybeSingle();
      if (!order?.confirm_token_hash || order.confirm_token_hash !== (await sha256Hex(data.token))) {
        return { paid: false };
      }
      if (order.status !== "pending") return { paid: order.status === "paid" || order.status === "shipped" };
      const session = await fulfillFromStripe(data.sessionId);
      return { paid: session.payment_status === "paid" };
    } catch {
      return { paid: false };
    }
  });

/** Admin: re-check pending orders with Stripe (covers customers who closed the tab after paying). */
export const reconcileOrders = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: isAdmin } = await context.supabase.rpc("has_role", { _user_id: context.userId, _role: "admin" });
    if (!isAdmin) throw new Error("Accès refusé");
    const { data: pending } = await context.supabase
      .from("orders")
      .select("id, stripe_session_id")
      .eq("status", "pending")
      .not("stripe_session_id", "is", null)
      .limit(25);
    let updated = 0;
    for (const o of pending ?? []) {
      try {
        const session = await fulfillFromStripe(o.stripe_session_id!);
        if (session.payment_status === "paid") updated++;
        else if (session.status === "expired") {
          await context.supabase.from("orders").update({ status: "expired" }).eq("id", o.id);
          updated++;
        }
      } catch {
        // leave as pending, retry next time
      }
    }
    return { updated };
  });
