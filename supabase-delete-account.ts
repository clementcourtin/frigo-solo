// Frigo Solo — Supabase Edge Function: delete-account
// Deploy as `delete-account` with "Verify JWT with legacy secret" set to OFF.
// Authentication is verified server-side with auth.getUser() below.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const allowedOrigins = new Set([
  'https://frigosolo.com',
  'https://www.frigosolo.com',
  'https://clementcourtin.github.io',
]);

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function keyFromEnvironment(jsonName: string, fallbackName: string) {
  const fallback = Deno.env.get(fallbackName);
  const raw = Deno.env.get(jsonName);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
    return typeof parsed?.default === 'string' ? parsed.default : fallback;
  } catch {
    return fallback;
  }
}

function config() {
  const url = Deno.env.get('SUPABASE_URL');
  const publishableKey = keyFromEnvironment('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
  const serviceRoleKey = keyFromEnvironment('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !publishableKey || !serviceRoleKey) {
    throw new HttpError(500, 'Configuration serveur indisponible');
  }
  return { url, publishableKey, serviceRoleKey };
}

function corsHeaders(request: Request) {
  const origin = request.headers.get('origin');
  return {
    ...(origin && allowedOrigins.has(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Origin',
  };
}

function response(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(request) });
}

function requireAllowedOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && !allowedOrigins.has(origin)) {
    throw new HttpError(403, 'Origine refusée');
  }
}

function isMissingTable(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return code === '42P01' || code === 'PGRST205';
}

function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
}

async function deleteRows(
  admin: ReturnType<typeof createClient>,
  table: string,
  column: string,
  userId: string,
) {
  const { error } = await admin.from(table).delete().eq(column, userId);
  // admin_notes/app_admins may not exist on an older, pre-admin installation.
  if (error && !isMissingTable(error)) {
    console.error('account_cleanup_failed', { table, column, code: errorCode(error) });
    throw new HttpError(500, 'Suppression des données impossible');
  }
}

async function purgeAccountData(admin: ReturnType<typeof createClient>, userId: string) {
  await deleteRows(admin, 'food_items', 'user_id', userId);
  await deleteRows(admin, 'shopping_items', 'user_id', userId);
  await deleteRows(admin, 'calendar_feeds', 'user_id', userId);
  // These two calls make the deletion work for an admin/owner account too.
  await deleteRows(admin, 'admin_notes', 'target_user_id', userId);
  await deleteRows(admin, 'admin_notes', 'actor_id', userId);
  await deleteRows(admin, 'app_admins', 'user_id', userId);
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders(request) });
  }

  try {
    requireAllowedOrigin(request);
    if (request.method !== 'POST') throw new HttpError(405, 'Méthode refusée');

    const authorization = request.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ')) {
      throw new HttpError(401, 'Session requise');
    }

    const { url, publishableKey, serviceRoleKey } = config();
    const caller = createClient(url, publishableKey, {
      global: { headers: { Authorization: authorization } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: userError } = await caller.auth.getUser();
    if (userError || !user) throw new HttpError(401, 'Session invalide');

    const admin = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await purgeAccountData(admin, user.id);

    const { error: deleteUserError } = await admin.auth.admin.deleteUser(user.id);
    if (deleteUserError) {
      console.error('auth_user_delete_failed', { code: errorCode(deleteUserError) });
      throw new HttpError(500, 'Suppression du compte impossible');
    }

    return response(request, { deleted: true });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (!(error instanceof HttpError)) console.error('delete_account_unexpected_error', error);
    return response(request, {
      error: status >= 500
        ? 'La suppression n’a pas pu aboutir. Réessaie dans quelques instants.'
        : error.message,
    }, status);
  }
});
