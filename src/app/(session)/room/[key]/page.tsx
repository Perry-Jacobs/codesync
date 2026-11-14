import { redirect } from 'next/navigation';
import { RoomShell } from '@/components/room/RoomShell';
import { isValidSessionKey } from '@/utils/sessionKey';

export const dynamic = 'force-dynamic';

interface RoomPageProps {
  params: Promise<{ key: string }>;
}

export default async function RoomPage({ params }: RoomPageProps) {
  const { key } = await params;
  if (!isValidSessionKey(key)) redirect('/join?invalidKey=1');
  return <RoomShell roomKey={key} />;
}
