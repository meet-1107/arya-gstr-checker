"use client";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { ApiError } from "@/lib/client/api";
import { SessionProvider } from "./session";
import { ThemeProvider } from "./theme";
import { ToastProvider } from "./ui/toast";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        revalidateOnFocus: false,
        dedupingInterval: 3000,
        // Don't hammer on client errors (4xx); retry transient ones a couple of times.
        shouldRetryOnError: (e) => !(e instanceof ApiError) || e.status === 0 || e.status >= 500,
        errorRetryCount: 2,
      }}
    >
      <ThemeProvider>
        <ToastProvider>
          <SessionProvider>{children}</SessionProvider>
        </ToastProvider>
      </ThemeProvider>
    </SWRConfig>
  );
}
