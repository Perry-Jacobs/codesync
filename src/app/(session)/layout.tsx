import { SessionProvider } from '@/components/providers/session-provider';

export const dynamic = 'force-dynamic';

/** Wraps every key-scoped surface in the WebSocket session context. */
export default function SessionLayout({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
