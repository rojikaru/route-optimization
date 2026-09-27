import { requireEnvVar } from "~/lib/env.ts";

const HEALTHCHECK_ENDPOINT = requireEnvVar("HEALTHCHECK_ENDPOINT");

export const healthCheck = async () => {
  try {
    const response = await fetch(HEALTHCHECK_ENDPOINT, { method: "GET" });
    if (!response.ok) {
      console.error(
        `Health check failed with status: ${response.status} ${response.statusText}`,
      );
    }
  } catch (error) {
    console.error("Health check error:", error);
  }
};
