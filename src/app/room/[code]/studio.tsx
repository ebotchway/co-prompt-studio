"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { RealtimeChannel } from "@supabase/supabase-js";
import {
  ArrowLeft, BrainCircuit, Check, Copy,
  LoaderCircle, Users, Wifi, WifiOff,
} from "lucide-react";
import { createBrowserClient } from "@/lib/supabase-browser";
import type {
  EditableField, RoomEdit, StudioRoom,
} from "@/lib/room-types";

type SaveState = "saved" | "saving" | "error";

export default function Studio({ code }: { code: string }) {
  const [room, setRoom] = useState<StudioRoom | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [online, setOnline] = useState(0);
  const [typing, setTyping] = useState("");
  const [copied, setCopied] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");

  const client = useRef<ReturnType<typeof createBrowserClient> | null>(null);
  const channel = useRef<RealtimeChannel | null>(null);
  const identity = useRef("");
  const timers = useRef<
    Partial<Record<EditableField, ReturnType<typeof setTimeout>>>
  >({});
  const focused = useRef<EditableField | null>(null);
  const latest = useRef<StudioRoom | null>(null);

  const loadRoom = useCallback(async () => {
    try {
      const response = await fetch(`/api/rooms/${code}`, {
        cache: "no-store",
      });

      const json = await response.json();

      if (!response.ok) {
        throw new Error(json.error || "Room unavailable");
      }

      latest.current = json.room as StudioRoom;
      setRoom(json.room as StudioRoom);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load room");
    } finally {
      setLoading(false);
    }
  }, [code]);

  useEffect(() => {
    let active = true;

    fetch(`/api/rooms/${code}`, { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json();

        if (!response.ok) {
          throw new Error(json.error || "Room unavailable");
        }

        return json.room as StudioRoom;
      })
      .then((data) => {
        if (!active) return;

        latest.current = data;
        setRoom(data);
      })
      .catch((err: unknown) => {
        if (!active) return;

        setError(
          err instanceof Error ? err.message : "Unable to load room"
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [code]);

  useEffect(() => {
    if (!/^[0-9]{4}$/.test(code)) return;

    const supabase = createBrowserClient();
    client.current = supabase;

    const me = `Guest-${crypto.randomUUID().slice(0, 6)}`;
    identity.current = me;

    // Public channel for a controlled hackathon demo only.
    const roomChannel = supabase.channel(`coprompt-room-${code}`, {
      config: {
        private: false,
        presence: { key: me },
      },
    });

    roomChannel.on(
      "broadcast",
      { event: "edit" },
      ({ payload }) => {
        const edit = payload as RoomEdit;
        if (edit.sender === identity.current) return;

        // Do not overwrite a textarea being edited locally.
        if (focused.current !== edit.field) {
          setRoom((current) => {
            if (!current) return current;
            const next = { ...current, [edit.field]: edit.value };
            latest.current = next;
            return next;
          });
        }

        setTyping(`${edit.sender} is editing`);
      }
    );

    roomChannel.on(
      "presence",
      { event: "sync" },
      () => {
        setOnline(Object.keys(roomChannel.presenceState()).length);
      }
    );

    roomChannel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        setConnected(true);
        await roomChannel.track({
          name: me,
          joined_at: new Date().toISOString(),
        });

        // Catch updates saved before this browser joined.
        void loadRoom();
      } else if (
        status === "CHANNEL_ERROR" ||
        status === "TIMED_OUT" ||
        status === "CLOSED"
      ) {
        setConnected(false);
      }
    });

    channel.current = roomChannel;

    return () => {
      channel.current = null;
      client.current = null;
      void supabase.removeChannel(roomChannel);
    };
  }, [code, loadRoom]);

  useEffect(() => {
    const activeTimers = timers.current;
    return () => {
      Object.values(activeTimers).forEach(clearTimeout);
    };
  }, []);

  async function saveField(field: EditableField, value: string | number) {
    setSaveState("saving");

    try {
      const response = await fetch(`/api/rooms/${code}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });

      if (!response.ok) {
        throw new Error(`Unable to save ${field}`);
      }

      setSaveState("saved");
    } catch {
      setSaveState("error");
      setError(`Save failed for ${field}. Please retry your edit.`);
    }
  }

  function updateField(field: EditableField, value: string | number) {
    setError("");
    setSaveState("saving");

    setRoom((current) => {
      if (!current) return current;
      const next = { ...current, [field]: value };
      latest.current = next;
      return next;
    });

    void channel.current?.send({
      type: "broadcast",
      event: "edit",
      payload: {
        sender: identity.current,
        field,
        value,
      } satisfies RoomEdit,
    });

    clearTimeout(timers.current[field]);

    timers.current[field] = setTimeout(() => {
      void saveField(field, value);
      delete timers.current[field];
    }, 600);
  }

  function flushField(field: EditableField) {
    focused.current = null;

    const pending = timers.current[field];

    if (pending) {
      clearTimeout(pending);
      delete timers.current[field];

      const value = latest.current?.[field];
      if (value !== undefined) void saveField(field, value);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Unable to copy link. Copy it from the address bar.");
    }
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center gap-3 bg-[#080b16] text-white">
        <LoaderCircle className="animate-spin text-violet-400" />
        Loading collaboration room...
      </main>
    );
  }

  if (!room) {
    return (
      <main className="min-h-screen bg-[#080b16] p-10 text-white">
        <h1 className="text-2xl font-bold">Room not found</h1>
        <p className="mt-3 text-rose-400">{error}</p>
        <Link href="/" className="mt-6 inline-block text-violet-400">
          Return to home
        </Link>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#080b16] px-5 pb-16 text-white">
      <header className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 border-b border-slate-800 py-6">
        <div className="flex items-center gap-4">
          <Link href="/" aria-label="Go home" className="text-slate-400 hover:text-white">
            <ArrowLeft size={21} />
          </Link>
          <BrainCircuit className="text-violet-400" size={28} />
          <div>
            <h1 className="text-lg font-bold">Co-Prompt Studio</h1>
            <p className="text-xs text-slate-400">
              Multiplayer Prompt Engineering
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-xs">
            {connected
              ? <Wifi size={15} className="text-emerald-400" />
              : <WifiOff size={15} className="text-amber-400" />}
            {connected ? "Live connected" : "Disconnected"}
          </span>
          <span className="flex items-center gap-2 text-sm text-slate-300">
            <Users size={17} /> {online} online
          </span>
          <button
            onClick={copyLink}
            className="flex items-center gap-2 rounded-xl border border-slate-700 px-4 py-2 text-sm hover:bg-slate-800"
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
            Room {code}
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-7xl pt-8">
        <div className="mb-7 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-3xl font-bold">Shared Prompt Workspace</h2>
            <p className="mt-2 text-sm text-slate-400">
              Experiment together. Changes sync between connected browsers.
            </p>
          </div>
          <span className="text-xs text-slate-400">
            {saveState === "saving" ? "Saving..." :
             saveState === "saved" ? "Changes saved" :
             "Save failed"}
          </span>
        </div>

        {error && (
          <div className="mb-5 rounded-xl border border-rose-800 bg-rose-950/40 p-4 text-sm text-rose-300">
            {error}
          </div>
        )}

        <section className="grid gap-5 lg:grid-cols-2">
          <Editor
            title="Shared System Instructions"
            value={room.system_prompt}
            field="system_prompt"
            onChange={updateField}
            onFocus={(field) => { focused.current = field; }}
            onBlur={flushField}
            small
          />
          <Editor
            title="Shared Test Input"
            value={room.test_input}
            field="test_input"
            onChange={updateField}
            onFocus={(field) => { focused.current = field; }}
            onBlur={flushField}
            small
          />
        </section>

        <div className="my-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-800 bg-[#12182b] p-5">
          <p className="text-sm text-slate-400">
            Model execution will be added in Phase 3.
          </p>
          <label className="flex items-center gap-4 text-sm">
            Temperature: {room.temperature.toFixed(1)}
            <input
              type="range"
              min="0"
              max="2"
              step="0.1"
              value={room.temperature}
              onChange={(event) =>
                updateField("temperature", Number(event.target.value))
              }
              className="accent-violet-500"
            />
          </label>
        </div>

        <section className="grid gap-5 lg:grid-cols-2">
          <Editor
            title="Prompt Architect A"
            value={room.prompt_a}
            field="prompt_a"
            onChange={updateField}
            onFocus={(field) => { focused.current = field; }}
            onBlur={flushField}
          />
          <Editor
            title="Prompt Architect B"
            value={room.prompt_b}
            field="prompt_b"
            onChange={updateField}
            onFocus={(field) => { focused.current = field; }}
            onBlur={flushField}
          />
        </section>

        <div className="mt-5 text-sm text-violet-300" aria-live="polite">
          {typing}
        </div>
      </div>
    </main>
  );
}

function Editor({
  title, value, field, onChange, onFocus, onBlur, small = false,
}: {
  title: string;
  value: string;
  field: EditableField;
  onChange: (field: EditableField, value: string) => void;
  onFocus: (field: EditableField) => void;
  onBlur: (field: EditableField) => void;
  small?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-[#12182b] p-5">
      <h3 className="mb-4 text-lg font-semibold">{title}</h3>
      <textarea
        value={value}
        maxLength={12000}
        onChange={(event) => onChange(field, event.target.value)}
        onFocus={() => onFocus(field)}
        onBlur={() => onBlur(field)}
        spellCheck={false}
        className={`w-full rounded-xl border border-slate-700 bg-[#090d1b] p-4 font-mono text-sm leading-7 outline-none focus:border-violet-500 ${
          small ? "h-32" : "h-72"
        }`}
      />
      <p className="mt-2 text-right text-xs text-slate-500">
        {value.length.toLocaleString()} characters
      </p>
    </div>
  );
}
