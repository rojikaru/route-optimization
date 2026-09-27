import assert from "node:assert";
import process from "node:process";

/**
 * Ensures that the specified environment variable is present and returns its value.
 *
 * @param name The name of the environment variable to retrieve.
 * @returns The value of the environment variable.
 * @throws `AssertionError` if the environment variable is not set.
 */
export const requireEnvVar = (name: string): string => {
  const value = process.env[name];
  assert.ok(value, `Environment variable ${name} is required`);
  return value;
};
