'use client'

// Whole seconds since a piece of work started, ticking while it runs - for the
// "still working, 6s" lines that tell the owner the screen has not frozen.
//
// `runKey` names the run: a new key starts the count again from nought.
import { useEffect, useState } from 'react'

type Clock = { runKey: number | string; startedAt: number; now: number }

export function useElapsedSeconds(active: boolean, runKey: number | string): number | null {
  const [clock, setClock] = useState<Clock | null>(null)

  useEffect(() => {
    if (!active) return
    const tick = () => setClock((previous) => {
      const time = Date.now()
      return previous && previous.runKey === runKey ? { ...previous, now: time } : { runKey, startedAt: time, now: time }
    })
    const first = setTimeout(tick, 0)
    const timer = setInterval(tick, 500)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [active, runKey])

  if (!active) return null
  if (!clock || clock.runKey !== runKey) return 0
  return Math.max(0, Math.floor((clock.now - clock.startedAt) / 1000))
}
