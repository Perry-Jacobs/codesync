import { redirect } from 'next/navigation';
import { Lobby } from '@/components/session/Lobby';
import { isValidSessionKey } from '@/utils/sessionKey';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ preview?: string | string[] }>;
}

export default async function JoinPage({ params, searchParams }: PageProps) {
  const { key } = await params;
  const { preview } = await searchParams;
  if (!isValidSessionKey(key)) redirect('/join?invalidKey=1');
  const isPreview = (Array.isArray(preview) ? preview[0] : preview) === '1';
  return <Lobby roomKey={key} preview={isPreview} />;
}
