import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function JoinIndexPage() {
  redirect('/?invalidKey=1');
}
