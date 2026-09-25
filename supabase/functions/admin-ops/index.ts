// Frigo Solo — Supabase Edge Function: admin-ops
// Deploy as `admin-ops` with "Verify JWT with legacy secret" set to OFF.
// Every request is authenticated below and mutations remain owner-only.

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

function reply(request: Request, payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: corsHeaders(request) });
}

function requireAllowedOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && !allowedOrigins.has(origin)) throw new HttpError(403, 'Origine refusée');
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isMissingTable(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return code === '42P01' || code === 'PGRST205';
}

function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
}

function service() {
  const { url, serviceRoleKey } = config();
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function requireOwner(request: Request) {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) throw new HttpError(401, 'Session requise');
  const { url, publishableKey } = config();
  const caller = createClient(url, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: { user }, error: userError } = await caller.auth.getUser();
  if (userError || !user) throw new HttpError(401, 'Session invalide');

  const admin = service();
  const { data: role, error: roleError } = await admin
    .from('app_admins')
    .select('role')
    .eq('user_id', user.id)
    .maybeSingle();
  if (roleError) throw new HttpError(500, 'Vérification des droits impossible');
  if (role?.role !== 'owner') throw new HttpError(403, 'Droit propriétaire requis');
  return { user, admin };
}

async function checkedDelete(
  admin: ReturnType<typeof service>,
  table: string,
  column: string,
  userId: string,
) {
  const { error } = await admin.from(table).delete().eq(column, userId);
  if (error && !isMissingTable(error)) {
    console.error('admin_cleanup_failed', { table, column, code: errorCode(error) });
    throw new HttpError(500, 'Purge partielle impossible');
  }
}

async function purgeAccountData(admin: ReturnType<typeof service>, userId: string) {
  await checkedDelete(admin, 'food_items', 'user_id', userId);
  await checkedDelete(admin, 'shopping_items', 'user_id', userId);
  await checkedDelete(admin, 'calendar_feeds', 'user_id', userId);
  await checkedDelete(admin, 'admin_notes', 'target_user_id', userId);
  await checkedDelete(admin, 'admin_notes', 'actor_id', userId);
  await checkedDelete(admin, 'app_admins', 'user_id', userId);
}

async function getTarget(admin: ReturnType<typeof service>, targetUserId: string) {
  const { data, error } = await admin.auth.admin.getUserById(targetUserId);
  if (error || !data.user) throw new HttpError(404, 'Compte introuvable');
  return data.user;
}

async function writeAudit(
  admin: ReturnType<typeof service>,
  actorId: string,
  targetUserId: string,
  action: string,
  outcome: 'started' | 'succeeded' | 'failed',
  error?: string,
) {
  const { data, error: auditError } = await admin
    .from('admin_audit_logs')
    .insert({
      actor_id: actorId,
      target_user_id: targetUserId,
      action,
      outcome,
      metadata: {},
      error_code: error ?? null,
      completed_at: outcome === 'started' ? null : new Date().toISOString(),
    })
    .select('id')
    .single();
  if (auditError || !data) throw new HttpError(503, 'Journal d’administration indisponible');
  return data.id as string;
}

async function finishAudit(
  admin: ReturnType<typeof service>,
  auditId: string,
  outcome: 'succeeded' | 'failed',
  error?: string,
) {
  const { error: auditError } = await admin
    .from('admin_audit_logs')
    .update({ outcome, error_code: error ?? null, completed_at: new Date().toISOString() })
    .eq('id', auditId);
  if (auditError) console.error('admin_audit_finish_failed', { code: errorCode(auditError) });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders(request) });
  }

  try {
    requireAllowedOrigin(request);
    if (request.method !== 'POST') throw new HttpError(405, 'Méthode refusée');

    const body = await request.json().catch(() => null) as {
      action?: string;
      target_user_id?: string;
    } | null;
    if (!body || !isUuid(body.target_user_id)) throw new HttpError(400, 'Compte cible invalide');
    if (!['suspend_account', 'restore_account', 'send_login_code', 'rotate_calendar', 'delete_account'].includes(body.action ?? '')) {
      throw new HttpError(400, 'Action inconnue');
    }

    const { user: actor, admin } = await requireOwner(request);
    if (body.target_user_id === actor.id && ['delete_account', 'suspend_account'].includes(body.action ?? '')) {
      throw new HttpError(409, 'Utilise la suppression de compte personnelle pour cette action');
    }

    const target = await getTarget(admin, body.target_user_id);
    const { data: targetRole, error: targetRoleError } = await admin
      .from('app_admins')
      .select('role')
      .eq('user_id', target.id)
      .maybeSingle();
    if (targetRoleError) throw new HttpError(500, 'Vérification du compte impossible');
    if (targetRole?.role === 'owner' && ['delete_account', 'suspend_account'].includes(body.action ?? '')) {
      throw new HttpError(409, 'Un propriétaire ne peut pas être modifié depuis la console');
    }

    const auditId = await writeAudit(admin, actor.id, target.id, body.action!, 'started');
    try {
      if (body.action === 'suspend_account') {
        const { error } = await admin.auth.admin.updateUserById(target.id, { ban_duration: '876000h' });
        if (error) throw new HttpError(500, 'Suspension impossible');
      }
      if (body.action === 'restore_account') {
        const { error } = await admin.auth.admin.updateUserById(target.id, { ban_duration: 'none' });
        if (error) throw new HttpError(500, 'Restauration impossible');
      }
      if (body.action === 'send_login_code') {
        if (!target.email) throw new HttpError(409, 'Ce compte n’a pas d’adresse e-mail');
        const { url, publishableKey } = config();
        const auth = createClient(url, publishableKey, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        const { error } = await auth.auth.signInWithOtp({
          email: target.email,
          options: { shouldCreateUser: false, emailRedirectTo: 'https://frigosolo.com/' },
        });
        if (error) throw new HttpError(502, 'Envoi impossible');
      }
      if (body.action === 'rotate_calendar') {
        const token = crypto.randomUUID();
        const { data: existing, error: readError } = await admin
          .from('calendar_feeds')
          .select('user_id')
          .eq('user_id', target.id)
          .maybeSingle();
        if (readError) throw new HttpError(500, 'Calendrier introuvable');
        const { error } = existing
          ? await admin.from('calendar_feeds').update({ token }).eq('user_id', target.id)
          : await admin.from('calendar_feeds').insert({ user_id: target.id, token });
        if (error) throw new HttpError(500, 'Réinitialisation impossible');
      }
      if (body.action === 'delete_account') {
        await purgeAccountData(admin, target.id);
        const { error } = await admin.auth.admin.deleteUser(target.id);
        if (error) {
          console.error('admin_auth_delete_failed', { code: errorCode(error) });
          throw new HttpError(500, 'Suppression du compte impossible');
        }
      }
      await finishAudit(admin, auditId, 'succeeded');
      return reply(request, { ok: true });
    } catch (error) {
      await finishAudit(admin, auditId, 'failed', error instanceof HttpError ? String(error.status) : 'internal');
      throw error;
    }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (!(error instanceof HttpError)) console.error('admin_ops_unexpected_error', error);
    return reply(request, {
      error: status >= 500 ? 'Action impossible pour le moment' : error.message,
    }, status);
  }
});
