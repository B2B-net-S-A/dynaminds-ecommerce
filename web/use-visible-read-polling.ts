import { useCallback, useEffect, useRef } from 'react';
import { createReadPolling } from './read-polling';

/** Latest callbacks do not restart timers; context changes cancel publication and scheduling. */
export function useVisibleReadPolling(
  context: string,
  read: (current: () => boolean) => Promise<void>,
  onError: (error: unknown) => void,
  enabled = true,
) {
  const readRef = useRef(read), errorRef = useRef(onError), contextRef = useRef(context);
  readRef.current = read;
  errorRef.current = onError;
  contextRef.current = context;
  const controller = useRef<ReturnType<typeof createReadPolling> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const polling = createReadPolling(
      current => {
        if (contextRef.current !== context) return Promise.resolve();
        return readRef.current(() => current() && contextRef.current === context);
      },
      {
        now: () => Date.now(),
        visible: () => document.visibilityState !== 'hidden',
        setTimer: (callback, delay) => window.setTimeout(callback, delay),
        clearTimer: timer => window.clearTimeout(timer as number),
        subscribeVisibility: callback => {
          document.addEventListener('visibilitychange', callback);
          return () => document.removeEventListener('visibilitychange', callback);
        },
      },
      error => { if (contextRef.current === context) errorRef.current(error); },
    );
    controller.current = polling;
    polling.start();
    return () => {
      polling.cancel();
      if (controller.current === polling) controller.current = null;
    };
  }, [context, enabled]);
  return useCallback(() => controller.current?.run() ?? Promise.resolve(), []);
}
