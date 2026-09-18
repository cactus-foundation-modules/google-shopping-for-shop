// Who made a workbench change, as the change log records it.
import type { SessionUser } from '@/lib/auth/session'

export function changedBy(user: SessionUser): string {
  return user.displayName?.trim() || user.username || user.email
}
