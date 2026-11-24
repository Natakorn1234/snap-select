import { CullStatus } from '@/lib/types';
export const STATUS_LABEL: Record<CullStatus, string> = { UNRATED: 'Unrated', KEEP: 'Keep', MAYBE: 'Maybe', REJECT: 'Reject' };
export const STATUS_RING: Record<CullStatus, string> = {
  UNRATED: 'ring-neutral-700',
  KEEP: 'ring-emerald-500',
  MAYBE: 'ring-amber-400',
  REJECT: 'ring-red-600',
};
export const STATUS_BADGE: Record<CullStatus, string> = {
  UNRATED: 'bg-neutral-700 text-neutral-200',
  KEEP: 'bg-emerald-600 text-white',
  MAYBE: 'bg-amber-500 text-black',
  REJECT: 'bg-red-600 text-white',
};
