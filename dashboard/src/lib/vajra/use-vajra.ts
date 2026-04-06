"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { VajraEventMessage } from "./types";
import { requestVajraJson, type VajraParams } from "./request";

interface VajraState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

interface VajraMutationState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export function useVajra<T>(
  endpoint: string | null,
  params?: VajraParams,
): VajraState<T> & { refetch: () => Promise<void> } {
  const [state, setState] = useState<VajraState<T>>({
    data: null,
    loading: endpoint !== null,
    error: null,
  });
  const paramsKey = JSON.stringify(params ?? {});

  const fetchData = useCallback(async () => {
    if (endpoint === null) {
      return;
    }

    setState((current) => ({
      ...current,
      loading: true,
      error: null,
    }));

    try {
      setState({
        data: await requestVajraJson<T>(endpoint, { params }),
        loading: false,
        error: null,
      });
    } catch (error) {
      setState({
        data: null,
        loading: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }, [endpoint, paramsKey]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return {
    ...state,
    refetch: fetchData,
  };
}

export function useVajraMutation<TBody, TResult>(
  endpoint: string,
  method: "PUT" | "POST" | "DELETE" = "PUT",
): VajraMutationState<TResult> & { mutate: (body?: TBody) => Promise<TResult> } {
  const [state, setState] = useState<VajraMutationState<TResult>>({
    data: null,
    loading: false,
    error: null,
  });

  const mutate = useCallback(async (body?: TBody) => {
    setState((current) => ({
      ...current,
      loading: true,
      error: null,
    }));

    try {
      const data = await requestVajraJson<TResult>(endpoint, {
        method,
        body,
      });
      setState({
        data,
        loading: false,
        error: null,
      });
      return data;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setState({
        data: null,
        loading: false,
        error: message,
      });
      throw error;
    }
  }, [endpoint, method]);

  return {
    ...state,
    mutate,
  };
}

export function useVajraEventStream(opts: {
  enabled?: boolean;
  onEvent?: (event: VajraEventMessage) => void;
  onOpen?: () => void;
  onError?: (error: Event) => void;
}): void {
  const onEventRef = useRef(opts.onEvent);
  const onOpenRef = useRef(opts.onOpen);
  const onErrorRef = useRef(opts.onError);
  const lastEventIdRef = useRef<string | null>(null);

  onEventRef.current = opts.onEvent;
  onOpenRef.current = opts.onOpen;
  onErrorRef.current = opts.onError;

  useEffect(() => {
    if (opts.enabled === false) {
      return;
    }

    const streamUrl = lastEventIdRef.current
      ? `/api/vajra/events?after=${encodeURIComponent(lastEventIdRef.current)}`
      : "/api/vajra/events";
    const stream = new EventSource(streamUrl);
    stream.onopen = () => {
      onOpenRef.current?.();
    };
    stream.onerror = (error) => {
      onErrorRef.current?.(error);
    };
    stream.onmessage = (message) => {
      try {
        if (message.lastEventId) {
          lastEventIdRef.current = message.lastEventId;
        }
        const parsed = JSON.parse(message.data) as VajraEventMessage;
        onEventRef.current?.(parsed);
      } catch {
        // Ignore malformed SSE payloads so the stream can stay open.
      }
    };

    return () => {
      stream.close();
    };
  }, [opts.enabled]);
}
