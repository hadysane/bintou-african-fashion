-- Only invited accounts with a verified email become team members (no more "first account wins")
CREATE OR REPLACE FUNCTION public.handle_new_user_role()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.email IS NULL OR NEW.email_confirmed_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.team_invites WHERE lower(email) = lower(NEW.email)) THEN
    INSERT INTO public.user_roles (user_id, role, email) VALUES (NEW.id, 'admin', lower(NEW.email))
    ON CONFLICT DO NOTHING;
    DELETE FROM public.team_invites WHERE lower(email) = lower(NEW.email);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS on_auth_user_created_role ON auth.users;
CREATE TRIGGER on_auth_user_created_role AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_role();
DROP TRIGGER IF EXISTS on_auth_user_verified_role ON auth.users;
CREATE TRIGGER on_auth_user_verified_role AFTER UPDATE OF email, email_confirmed_at ON auth.users
  FOR EACH ROW
  WHEN (NEW.email_confirmed_at IS NOT NULL
        AND (OLD.email_confirmed_at IS NULL OR OLD.email IS DISTINCT FROM NEW.email))
  EXECUTE FUNCTION public.handle_new_user_role();

CREATE OR REPLACE FUNCTION public.handle_team_invite()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _uid uuid;
BEGIN
  NEW.email := lower(trim(NEW.email));
  SELECT id INTO _uid FROM auth.users
    WHERE lower(email) = NEW.email AND email_confirmed_at IS NOT NULL
    LIMIT 1;
  IF _uid IS NOT NULL THEN
    INSERT INTO public.user_roles (user_id, role, email) VALUES (_uid, 'admin', NEW.email)
    ON CONFLICT DO NOTHING;
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user_role() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_team_invite() FROM PUBLIC, anon, authenticated;

-- Stock: no more open table reads; the storefront reads quantities through the server
DROP POLICY IF EXISTS "Anyone reads stock" ON public.product_stock;
REVOKE SELECT ON public.product_stock FROM anon;
CREATE POLICY "Admins read stock" ON public.product_stock FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Orders: hash of the buyer's confirmation secret
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS confirm_token_hash text;