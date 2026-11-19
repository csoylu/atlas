import { useEffect, useState } from 'react';

/** The time now, refreshed every minute: keeps « In review · 2 h » current (#237). */
export function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}
