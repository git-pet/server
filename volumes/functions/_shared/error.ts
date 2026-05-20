import { corsHeaders } from "./response.ts";

export class GitPetError extends Error {
  constructor(
    public message: string,
    public status: number = 400,
  ) {
    super(message);
  }
}

export function errorResponse(err: unknown) {
  if (err instanceof GitPetError) {
    return new Response(
      JSON.stringify({ success: false, message: err.message }),
      {
        status: err.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
  console.error(err);
  return new Response(
    JSON.stringify({ success: false, message: "Internal Server Error" }),
    {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}
