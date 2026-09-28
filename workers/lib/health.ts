import { requireEnvVar } from "~/lib/env.ts";
import type { HealthCheckMode } from "~/lib/types.ts";

const USER_AGENT = requireEnvVar("USER_AGENT");

const urlForMode = (endpoint: string, mode: HealthCheckMode) => {
  const healthcheckSeparator = endpoint.endsWith("/") ? "" : "/";

  if (typeof mode === "number") {
    return `${endpoint}${healthcheckSeparator}${mode}`;
  }

  switch (mode) {
    case "success":
      return endpoint;
    case "failure":
      return `${endpoint}${healthcheckSeparator}fail`;
    case "startup":
      return `${endpoint}${healthcheckSeparator}start`;
  }
};

export const healthCheck = async (endpoint: string, mode: HealthCheckMode = "success") => {
  try {
    const response = await fetch(urlForMode(endpoint, mode), {
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
