// Frigo Solo — Supabase Edge Function: admin-ops
// Deploy this file as the `admin-ops` function (verify JWT enabled).
// The service-role key is read only from Supabase's server environment.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
function keyFromEnvironment(jsonName: string, fallbackName: string) {
  try { return JSON.parse(Deno.env.get(jsonName) ?? '{}').default ?? Deno.env.get(fallbackName); }
  catch { return Deno.env.get(fallbackName); }
}
const anonKey = keyFromEnvironment('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
const serviceRoleKey = keyFromEnvironment('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
if (!supabaseUrl || !anonKey || !serviceRoleKey) throw new Error('Variables Supabase manquantes');
const allowedOrigins = new Set([
  'https://frigosolo.com',
  'https://www.frigosolo.com',
  'https://clementcourtin.github.io',
]);

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function cors(req: Request, strict = true) {
  const origin = req.headers.get('origin');
  if (origin && !allowedOrigins.has(origin)) {
    if (strict) throw new HttpError(403, 'Origine refusée');
    return { 'Vary': 'Origin' };
  }
  return {
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function reply(req: Request, payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors(req, false), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function service() {
  return createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function owner(req: Request) {
  const authorization = req.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) throw new HttpError(401, 'Session requise');
  const caller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: { user }, error } = await caller.auth.getUser();
  if (error || !user) throw new HttpError(401, 'Session invalide');

  const admin = service();
  const { data: row, error: roleError } = await admin.from('app_admins').select('role').eq('user_id', user.id).maybeSingle();
  if (roleError) throw new HttpError(500, 'Vérification des droits impossible');
  if (row?.role !== 'owner') throw new HttpError(403, 'Droit propriétaire requis');
  return { user, admin };
}

async function writeAudit(admin: ReturnType<typeof service>, actorId: string, targetId: string | null, action: string, outcome: 'started' | 'succeeded' | 'failed', metadata: Record<string, unknown> = {}, errorCode?: string) {
  const { data, error } = await admin.from('admin_audit_logs').insert({ actor_id: actorId, target_user_id: targetId, action, outcome, metadata, error_code: errorCode ?? null, completed_at: outcome === 'started' ? null : new Date().toISOString() }).select('id').single();
  if (error || !data) throw new HttpError(503, 'Journal d’administration indisponible');
  return data.id as string;
}

async function finishAudit(admin: ReturnType<typeof service>, id: string, outcome: 'succeeded' | 'failed', errorCode?: string) {
  await admin.from('admin_audit_logs').update({ outcome, error_code: errorCode ?? null, completed_at: new Date().toISOString() }).eq('id', id);
}

async function getTarget(admin: ReturnType<typeof service>, id: string) {
  const { data, error } = await admin.auth.admin.getUserById(id);
  if (error || !data.user) throw new HttpError(404, 'Compte introuvable');
  return data.user;
}

async function purgeAccountData(admin: ReturnType<typeof service>, userId: string) {
  for (const table of ['food_items', 'shopping_items', 'calendar_feeds', 'admin_notes']) {
    const targetColumn = table === 'admin_notes' ? 'target_user_id' : 'user_id';
    const { error } = await admin.from(table).delete().eq(targetColumn, userId);
    if (error) throw new HttpError(500, 'Purge partielle impossible');
  }
}

Deno.serve(async (req) => {
  try {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
    if (req.method !== 'POST') return reply(req, { error: 'Méthode refusée' }, 405);

    const body = await req.json().catch(() => null) as { action?: string; target_user_id?: string } | null;
    if (!body || !isUuid(body.target_user_id)) throw new HttpError(400, 'Compte cible invalide');

    const { user: actor, admin } = await owner(req);
    if (body.target_user_id === actor.id && ['delete_account', 'suspend_account'].includes(body.action ?? '')) {
      throw new HttpError(409, 'Utilise la suppression de compte personnelle pour cette action');
    }
    const target = await getTarget(admin, body.target_user_id);
    const action = body.action;
    if (!['suspend_account', 'restore_account', 'send_login_code', 'rotate_calendar', 'delete_account'].includes(action ?? '')) {
      throw new HttpError(400, 'Action inconnue');
    }

    const auditId = await writeAudit(admin, actor.id, target.id, action!, 'started', { target_email: target.email ?? null });
    try {
      if (action === 'suspend_account') {
        const { error } = await admin.auth.admin.updateUserById(target.id, { ban_duration: '876000h' });
        if (error) throw new HttpError(500, 'Suspension impossible');
      }
      if (action === 'restore_account') {
        const { error } = await admin.auth.admin.updateUserById(target.id, { ban_duration: 'none' });
        if (error) throw new HttpError(500, 'Restauration impossible');
      }
      if (action === 'send_login_code') {
        if (!target.email) throw new HttpError(409, 'Ce compte n’a pas d’adresse e-mail');
        const auth = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
        const { error } = await auth.auth.signInWithOtp({
          email: target.email,
          options: { shouldCreateUser: false, emailRedirectTo: 'https://frigosolo.com/' },
        });
        if (error) throw new HttpError(502, 'Envoi impossible');
      }
      if (action === 'rotate_calendar') {
        // calendar_feeds.token est un UUID cryptographiquement aléatoire (122 bits).
        const { data: existing, error: readError } = await admin.from('calendar_feeds').select('user_id').eq('user_id', target.id).maybeSingle();
        if (readError) throw new HttpError(500, 'Calendrier introuvable');
        const token = crypto.randomUUID();
        const result = existing
          ? await admin.from('calendar_feeds').update({ token }).eq('user_id', target.id)
          : await admin.from('calendar_feeds').insert({ user_id: target.id, token });
        if (result.error) throw new HttpError(500, 'Réinitialisation impossible');
      }
      if (action === 'delete_account') {
        const { data: role } = await admin.from('app_admins').select('role').eq('user_id', target.id).maybeSingle();
        if (role?.role === 'owner') throw new HttpError(409, 'Un propriétaire ne peut pas être supprimé depuis la console');
        await purgeAccountData(admin, target.id);
        await admin.from('app_admins').delete().eq('user_id', target.id);
        const { error } = await admin.auth.admin.deleteUser(target.id);
        if (error) throw new HttpError(500, 'Suppression du compte impossible');
      }
      await finishAudit(admin, auditId, 'succeeded');
      return reply(req, { ok: true });
    } catch (error) {
      await finishAudit(admin, auditId, 'failed', error instanceof HttpError ? String(error.status) : 'internal');
      throw error;
    }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    return reply(req, { error: status >= 500 ? 'Action impossible pour le moment' : error.message }, status);
  }
});
