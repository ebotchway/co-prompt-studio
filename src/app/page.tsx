"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  BrainCircuit,
  Users,
  GitCompareArrows,
  ArrowRight,
  Zap,
} from "lucide-react";

export default function Home() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function createRoom() {
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Unable to create room");
      }

      router.push(`/room/${result.room.code}`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unknown error"
      );
      setLoading(false);
    }
  }

  function joinRoom() {
    if (!/^[0-9]{4}$/.test(code)) {
      setError("Please enter a valid four-digit room code.");
      return;
    }

    router.push(`/room/${code}`);
  }

  return (
    <main className="min-h-screen bg-[#080b16] text-white">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-7">
        <div className="flex items-center gap-3 text-xl font-bold">
          <div className="rounded-xl bg-violet-600 p-2">
            <BrainCircuit size={23} />
          </div>
          Co-Prompt <span className="text-violet-400">Studio</span>
        </div>

        <span className="text-xs text-slate-400">
          TRMI × LovHack 2026
        </span>
      </nav>

      <section className="mx-auto max-w-5xl px-6 pb-24 pt-20 text-center">
        <div className="mb-8 inline-flex rounded-full border border-violet-500/30 bg-violet-500/10 px-5 py-2 text-sm text-violet-300">
          Multiplayer Everything — AI Engineering Together
        </div>

        <h1 className="text-5xl font-extrabold tracking-tight md:text-7xl">
          Better prompts.
          <br />
          <span className="text-violet-400">Built together.</span>
        </h1>

        <p className="mx-auto mt-8 max-w-2xl text-lg leading-8 text-slate-400">
          Create shared prompt-engineering rooms, edit competing
          prompts with teammates, run AI experiments, and compare
          the results side by side.
        </p>

        <div className="mx-auto mt-12 max-w-md rounded-2xl border border-slate-700 bg-[#12182b] p-6 shadow-2xl">
          <button
            onClick={createRoom}
            disabled={loading}
            className="flex w-full items-center justify-center gap-3 rounded-xl bg-violet-600 px-6 py-4 font-semibold hover:bg-violet-500 disabled:opacity-50"
          >
            <Zap size={20} />
            {loading ? "Creating..." : "Create Collaboration Room"}
            <ArrowRight size={18} />
          </button>

          <p className="my-6 text-sm text-slate-500">
            OR JOIN AN EXISTING ROOM
          </p>

          <div className="flex gap-3">
            <input
              value={code}
              onChange={(event) =>
                setCode(
                  event.target.value.replace(/\D/g, "").slice(0, 4)
                )
              }
              placeholder="4-digit code"
              inputMode="numeric"
              maxLength={4}
              className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-white outline-none focus:border-violet-500"
            />

            <button
              onClick={joinRoom}
              className="rounded-xl border border-violet-500 px-5 py-3 font-semibold text-violet-300 hover:bg-violet-500/10"
            >
              Join
            </button>
          </div>

          {error && (
            <p className="mt-4 text-sm text-rose-400">{error}</p>
          )}
        </div>

        <div className="mt-20 grid gap-5 text-left md:grid-cols-3">
          {[
            {
              icon: Users,
              title: "Live Collaboration",
              detail:
                "Work on shared prompts with teammates in real time.",
            },
            {
              icon: Zap,
              title: "Parallel AI Runs",
              detail:
                "Test two competing prompts against the same model.",
            },
            {
              icon: GitCompareArrows,
              title: "Output Comparison",
              detail:
                "Compare generated text, latency, and token usage.",
            },
          ].map((feature) => (
            <div
              key={feature.title}
              className="rounded-2xl border border-slate-800 bg-[#12182b] p-6"
            >
              <feature.icon
                className="mb-5 text-violet-400"
                size={28}
              />
              <h3 className="text-lg font-semibold">
                {feature.title}
              </h3>
              <p className="mt-3 text-sm leading-6 text-slate-400">
                {feature.detail}
              </p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
