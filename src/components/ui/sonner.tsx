"use client";

import { useEffect, useState } from "react";
import { Toaster as SonnerToaster } from "sonner";
import { useTheme } from "@/components/providers/theme-provider";

export function Toaster() {
  const { theme } = useTheme();
  const [compact, setCompact] = useState(false);

  // On compact widths the side rail and waiting room are bottom-heavy sheets.
  // Bottom-right toasts land on top of the chat composer and the waiting-room
  // switches, so move them to the top-right, just below the top bar.
  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = (): void => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return (
    <SonnerToaster
      theme={theme}
      position={compact ? "top-right" : "bottom-right"}
      offset={
        compact ? { top: 56, right: 12, bottom: 16, left: 12 } : undefined
      }
      closeButton
      richColors
      toastOptions={{
        classNames: {
          toast: "font-sans text-sm",
        },
      }}
    />
  );
}
