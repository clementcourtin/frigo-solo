const SUPABASE_CALENDAR = "https://xxvxmefrrkuurlnxyxsn.supabase.co/functions/v1/calendar";

function textResponse(message, status = 404) {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const token = url.pathname.match(/^\/([^/]+)\.ics$/i)?.[1];

    if (!token) return textResponse("Calendrier introuvable.");

    const upstreamUrl = `${SUPABASE_CALENDAR}/${encodeURIComponent(token)}.ics`;
    let upstream;

    try {
      upstream = await fetch(upstreamUrl, {
        method: request.method === "HEAD" ? "HEAD" : "GET",
        headers: { Accept: "text/calendar, */*" },
      });
    } catch {
      return textResponse("Calendrier momentanément indisponible.", 502);
    }

    const headers = new Headers(upstream.headers);
    headers.set("Content-Type", "text/calendar; charset=utf-8");
    headers.set("Content-Disposition", 'inline; filename="frigo-solo.ics"');
    headers.set("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");
    headers.set("Pragma", "no-cache");
    headers.set("X-Content-Type-Options", "nosniff");

    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  },
};
