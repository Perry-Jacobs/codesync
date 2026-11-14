import type { Metadata } from 'next';
import { LandingPage } from '@/components/landing/LandingPage';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'CodeSync — Code together. Talk it through.',
};

export default function HomePage() {
  return <LandingPage />;
}
