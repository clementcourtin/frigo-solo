import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const allowedOrigins = new Set([
  'https://frigosolo.com',
  'https://www.frigosolo.com',
  'https://clementcourtin.github.io',
]);

function corsHeaders(request: Request) {
  const origin = request.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': allowedOrigins.has(origin) ? origin : 'https://frigosolo.com',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function response(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) });
  if (request.method !== 'POST') return response(request, { error: 'Method not allowed' }, 405);

  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return response(request, { error: 'Unauthorized' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const publishableKeys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}');
  const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
  const publishableKey = publishableKeys.default ?? Deno.env.get('SUPABASE_ANON_KEY');
  const secretKey = secretKeys.default ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !publishableKey || !secretKey) {
    console.error('Missing Supabase function environment variables');
    return response(request, { error: 'Server configuration error' }, 500);
  }

  const caller = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authorization } },
  });
  const { data: { user }, error: userError } = await caller.auth.getUser();
  if (userError || !user) {
    console.error('Could not authenticate deletion request', userError);
    return response(request, { error: 'Unauthorized' }, 401);
  }

  const admin = createClient(supabaseUrl, secretKey);
  for (const table of ['food_items', 'shopping_items', 'calendar_feeds']) {
    const { error } = await admin.from(table).delete().eq('user_id', user.id);
    if (error) {
      console.error('Could not delete account data', { table, code: error.code, message: error.message });
      return response(request, { error: 'Could not delete account data' }, 500);
    }
  }

  const { error: deleteUserError } = await admin.auth.admin.deleteUser(user.id);
  if (deleteUserError) {
    console.error('Could not delete account', { code: deleteUserError.code, message: deleteUserError.message });
    return response(request, { error: 'Could not delete account' }, 500);
  }

  return response(request, { deleted: true });
});
