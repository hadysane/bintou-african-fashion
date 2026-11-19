import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { confirmCheckout } from "@/lib/shop.functions";
import { useCart } from "@/lib/cart";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/commande/confirmation")({
  validateSearch: (search: Record<string, unknown>): { session_id?: string | undefined; t?: string | undefined } => ({
    session_id: typeof search["session_id"] === "string" ? search["session_id"] : undefined,
    t: typeof search["t"] === "string" ? search["t"] : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Merci pour votre commande — Bintou" },
      { name: "description", content: "Confirmation de votre commande Bintou." },
      { property: "og:title", content: "Merci pour votre commande — Bintou" },
      { property: "og:description", content: "Confirmation de votre commande Bintou." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Confirmation,
});

function Confirmation() {
  const { session_id, t } = Route.useSearch();
  const confirm = useServerFn(confirmCheckout);
  const { clear } = useCart();
  const { data, isLoading } = useQuery({
    queryKey: ["confirm", session_id, t],
    queryFn: () => confirm({ data: { sessionId: session_id!, token: t! } }),
    enabled: !!session_id && !!t,
    retry: 1,
  });

  useEffect(() => {
    if (data?.paid) clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.paid]);

  return (
    <div className="mx-auto max-w-xl px-5 py-28 text-center">
      {isLoading ? (
        <>
          <Loader2 className="mx-auto size-10 animate-spin text-primary" />
          <p className="mt-6 text-muted-foreground">Nous vérifions votre paiement…</p>
        </>
      ) : data?.paid ? (
        <>
          <CheckCircle2 className="mx-auto size-14 text-forest" />
          <h1 className="mt-6 text-5xl">Merci !</h1>
          <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
            Votre commande est confirmée. Nous préparons vos pièces avec soin.
          </p>
          <Button asChild variant="ink" size="lg" className="mt-10">
            <Link to="/boutique" search={{ cat: undefined }}>Continuer mes achats</Link>
          </Button>
        </>
      ) : (
        <>
          <h1 className="text-4xl">Paiement non confirmé</h1>
          <p className="mt-4 text-muted-foreground">
            Nous n'avons pas pu confirmer votre paiement. Si vous avez été débité, contactez-nous et nous réglerons cela rapidement.
          </p>
          <Button asChild variant="ink" size="lg" className="mt-10">
            <Link to="/contact">Nous contacter</Link>
          </Button>
        </>
      )}
    </div>
  );
}
