"use client";

import { useEffect, useState } from "react";

export function useCurrentTime(intervalMs = 1_000) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [intervalMs]);

  return nowMs;
}
