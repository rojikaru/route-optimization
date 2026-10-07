import assert from "node:assert";

import { requireEnvVar } from "~/lib/env.ts";
import type { HealthCheckMode } from "~/lib/types.ts";

const USER_AGENT = requireEnvVar("USER_AGENT");
const FETCH_TIMEOUT_MS = Number.parseInt(requireEnvVar("FETCH_TIMEOUT_MS"));

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

export const healthCheck = async (
  endpoint: string,
  mode: HealthCheckMode = "success",
  body?: unknown,
) => {
  const options: RequestInit = {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(urlForMode(endpoint, mode), options);
    if (!response.ok) {
      console.error(
        `Health check failed with status: ${response.status} ${response.statusText}`,
      );
    }
  } catch (error) {
    assert.ok(error instanceof Error, "Health check error is not an instance of Error");
    console.error("Health check error:", error.toString());
  }
};
