export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

export function ok(data: unknown) {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function created(data: unknown) {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 201,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
