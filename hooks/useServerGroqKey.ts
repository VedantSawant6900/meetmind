"use client";

import { useEffect, useRef, useState } from "react";
import type { ConfigResponse } from "../lib/client-types";

export function useServerGroqKey() {
  const [serverGroqKeyAvailable, setServerGroqKeyAvailable] = useState(false);
  const serverGroqKeyAvailableRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const loadConfig = async () => {
      try {
        const response = await fetch("/api/config", {
          method: "GET",
        });
        const payload = (await response.json().catch(() => null)) as ConfigResponse | null;

        if (!cancelled) {
          setServerGroqKeyAvailable(Boolean(response.ok && payload?.hasServerGroqKey));
        }
      } catch {
        if (!cancelled) {
          setServerGroqKeyAvailable(false);
        }
      }
    };

    void loadConfig();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    serverGroqKeyAvailableRef.current = serverGroqKeyAvailable;
  }, [serverGroqKeyAvailable]);

  return {
    serverGroqKeyAvailable,
    serverGroqKeyAvailableRef,
  };
}
