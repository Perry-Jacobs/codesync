'use client';

import { Toaster as SonnerToaster } from 'sonner';
import { useTheme } from '@/components/providers/theme-provider';

export function Toaster() {
  const { theme } = useTheme();
  return (
    <SonnerToaster
      theme={theme}
      position="bottom-right"
      closeButton
      richColors
      toastOptions={{
        classNames: {
          toast: 'font-sans text-sm',
        },
      }}
    />
  );
}
