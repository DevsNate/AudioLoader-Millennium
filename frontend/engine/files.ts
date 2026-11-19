// Helpers for replies from the Lua backend (backend/main.lua).

// Millennium hands a backend string that holds JSON to the frontend parsed.
export const fromBackendJson = <T>(reply: unknown): T => (typeof reply === 'string' ? JSON.parse(reply) : reply) as T;

export async function expectWrite(reply: Promise<{ success: boolean; error?: string }>): Promise<void> {
  const result = await reply;
  if (!result.success) throw new Error(result.error || 'The file could not be written.');
}

export async function expectBoolean(reply: Promise<boolean>, message: string): Promise<boolean> {
  if (!await reply) throw new Error(message);
  return true;
}
