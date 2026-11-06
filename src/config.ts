// .env is loaded by env.ts, which the entry points import first.
import "./env.js";

export const X = {
  apiKey: process.env.X_API_KEY ?? "",
  apiSecret: process.env.X_API_KEY_SECRET ?? "",
  accessToken: process.env.X_ACCESS_TOKEN ?? "",
  accessSecret: process.env.X_ACCESS_TOKEN_SECRET ?? "",
  bearer: process.env.X_BEARER_TOKEN ?? "",
  userId: process.env.X_USER_ID || (process.env.X_ACCESS_TOKEN ?? "").split("-")[0] || "",
};

export function xConfigured(): boolean {
  return Boolean(X.apiKey && X.apiSecret && X.accessToken && X.accessSecret && X.userId);
}
