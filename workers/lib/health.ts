import { requireEnvVar } from "~/lib/env.ts";

type HealthCheckMode = "success" | "failure" | "startup" | number;

const HEALTHCHECK_ENDPOINT = requireEnvVar("HEALTHCHECK_ENDPOINT");
const healthcheckSeparator = HEALTHCHECK_ENDPOINT.endsWith("/") ? "" : "/";

const USER_AGENT = requireEnvVar("USER_AGENT");

const urlForMode = (mode: HealthCheckMode) => {
  if (typeof mode === "number") {
    return `${HEALTHCHECK_ENDPOINT}${healthcheckSeparator}${mode}`;
  }

  switch (mode) {
    case "success":
      return HEALTHCHECK_ENDPOINT;
    case "failure":
      return `${HEALTHCHECK_ENDPOINT}${healthcheckSeparator}fail`;
    case "startup":
      return `${HEALTHCHECK_ENDPOINT}${healthcheckSeparator}start`;
  }
};

export const healthCheck = async (mode: HealthCheckMode = "success") => {
  try {
    const response = await fetch(urlForMode(mode), {
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
