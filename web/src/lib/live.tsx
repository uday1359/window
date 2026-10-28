import { createContext, ReactNode, useContext, useEffect, useRef, useState } from 'react';

export interface LiveEvent {
  type: string;
  at?: string;
  [key: string]: unknown;
}

type Listener = (e: LiveEvent) => void;

interface LiveState {
  connected: boolean;
  subscribe: (fn: Listener) => () => void;
}

const LiveContext = createContext<LiveState>({ connected: false, subscribe: () => () => undefined });

const MAX_BACKOFF_MS = 15_000;

/** One authenticated WebSocket per tab, reconnecting with backoff; the cookie authenticates it. */
export function LiveProvider({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<Listener>());

  useEffect(() => {
    if (!enabled) return;
    let socket: WebSocket | null = null;
    let stopped = false;
    let backoff = 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${scheme}://${window.location.host}/ws/events`);
      socket.onopen = () => {
        backoff = 1000;
        setConnected(true);
      };
      socket.onmessage = (msg) => {
        try {
          const event = JSON.parse(String(msg.data)) as LiveEvent;
          listeners.current.forEach((fn) => fn(event));
        } catch {
          /* ignore malformed frames */
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (stopped) return;
        timer = setTimeout(connect, backoff);
        backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
      };
    };
    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      socket?.close();
    };
  }, [enabled]);

  const subscribe = (fn: Listener) => {
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  };

  return <LiveContext.Provider value={{ connected, subscribe }}>{children}</LiveContext.Provider>;
}

export function useLiveStatus(): boolean {
  return useContext(LiveContext).connected;
}

/** Calls `onEvent` for live events whose type matches (prefix match, e.g. "task."). */
export function useLiveEvents(prefixes: string[], onEvent: Listener): void {
  const { subscribe } = useContext(LiveContext);
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const key = prefixes.join('|');
  useEffect(() => subscribe((e) => {
    if (key.split('|').some((p) => e.type.startsWith(p))) handler.current(e);
  }), [subscribe, key]);
}
