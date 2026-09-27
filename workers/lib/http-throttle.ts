/**
 * Calculates how much we should sleep before the next invocation.
 * 
 * Give a plain 10 minute wait during curfew hours (5:00-6:00 local time) in Lviv, Ukraine.
 * 
 * @param defaultIntervalMs The default interval to use if there is not enough data to estimate.
 */
export const nextInvocationInterval = (
  defaultIntervalMs: number = 4_000,
) => {
  const now = Temporal.Now.zonedDateTimeISO("Europe/Kyiv");

  /**
   * NOTE: This is a temporary hack that conservatively cuts
   * curfew hours in Lviv, Ukraine (service is running ~6:00-23:00 local time).
   * 
   * FUTURE: this branch may be removed once the curfew is lifted,
   * AND the service will run at night as well.
   */
  if (now.hour < 5) {
    return 10 * 60 * 1000; // minutes in milliseconds
  }

  const jitterMs = 200 + Math.floor(Math.random() * 200); // [200, 400]
  return defaultIntervalMs + jitterMs;
};
