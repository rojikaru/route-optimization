import { requireEnvVar } from "~/lib/env.ts";

const HEALTHCHECK_ENDPOINT = requireEnvVar("HEALTHCHECK_ENDPOINT");
const USER_AGENT = requireEnvVar("USER_AGENT");

export const healthCheck = async () => {
  try {
    const response = await fetch(HEALTHCHECK_ENDPOINT, { 
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(5000), // 5 seconds timeout
    });
    if (!response.ok) {
      console.error(
        `Health check failed with status: ${response.status} ${response.statusText}`,
      );
    }
  } catch (error) {
    console.error("Health check error:", error);
  }
};
