export const runtime = "nodejs";

export function GET() {
  return Response.json({
    hasServerGroqKey: Boolean(process.env.GROQ_API_KEY?.trim()),
  });
}
