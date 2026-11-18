"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Code2,
  FileCode2,
  KeyRound,
  Loader2,
  Lock,
  MessagesSquare,
  MonitorPlay,
  Moon,
  Radio,
  ShieldCheck,
  Sparkles,
  Sun,
} from "lucide-react";
import { toast } from "sonner";
import { HeroPreview } from "@/components/landing/HeroPreview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useTheme } from "@/components/providers/theme-provider";
import type { CreateRoomResponse, RoomInfoResponse } from "@/lib/api-types";
import { apiUrl } from "@/lib/api-client";
import { clientInstallationId } from "@/lib/client-id";
import { isValidSessionKey, normalizeSessionKey } from "@/utils/sessionKey";

const NAME_KEY = "codesync:name";
const FEATURES = [
  {
    icon: Code2,
    title: "A real editor",
    body: "Monaco with IntelliSense, multi-cursor, minimap and your keybindings — not a text box.",
  },
  {
    icon: Radio,
    title: "Live shared cursors",
    body: "Yjs CRDT keeps every keystroke convergent, even through flaky connections.",
  },
  {
    icon: ShieldCheck,
    title: "Host in control",
    body: "Waiting room, per-person edit and speak grants, lock, mute and end session.",
  },
  {
    icon: MonitorPlay,
    title: "Screen share + camera",
    body: "WebRTC mesh up to 8 people with coturn relay for restrictive networks.",
  },
  {
    icon: FileCode2,
    title: "Host your disk",
    body: "The host can open a local folder; guests edit the real files, writes are saved back.",
  },
  {
    icon: MessagesSquare,
    title: "Chat that stays",
    body: "Messages, reactions, raised hands and push-to-talk next to the code.",
  },
];

export function LandingPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { theme, toggle } = useTheme();

  const [startOpen, setStartOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [manualAdmit, setManualAdmit] = useState(false);
  const [joinKey, setJoinKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [joinBusy, setJoinBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem(NAME_KEY);
    if (stored) setName(stored);
  }, []);

  useEffect(() => {
    if (searchParams.get("invalidKey") === "1") {
      toast.error("That session key is not valid");
    }
  }, [searchParams]);

  const createRoom = async (): Promise<void> => {
    const hostName = name.trim();
    if (!hostName) {
      setFormError("Tell people what to call you");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const response = await fetch(apiUrl("/api/rooms"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codesync-client-id": clientInstallationId(),
        },
        cache: "no-store",
        body: JSON.stringify({
          hostName,
          title: title.trim() || undefined,
          admitMode: manualAdmit ? "manual" : "auto",
        }),
      });
      const payload = (await response.json()) as
        CreateRoomResponse | { error: string };
      if (!response.ok || "error" in payload) {
        setFormError(
          "error" in payload ? payload.error : "Could not create the session",
        );
        return;
      }
      window.localStorage.setItem(NAME_KEY, hostName);
      window.localStorage.setItem(
        `codesync:host:${payload.roomKey}`,
        payload.hostToken,
      );
      router.push(`/room/${payload.roomKey}`);
    } catch {
      setFormError("Network error — is the server running?");
    } finally {
      setBusy(false);
    }
  };

  const joinRoom = async (): Promise<void> => {
    const raw = joinKey.trim();
    const candidate = normalizeSessionKey(
      raw.split("/").filter(Boolean).pop() ?? raw,
    );
    if (!isValidSessionKey(candidate)) {
      setJoinError("Keys look like zk-xxxxxxxxxxxxxxxxxx");
      return;
    }
    setJoinBusy(true);
    setJoinError(null);
    try {
      const response = await fetch(
        apiUrl(`/api/rooms/${encodeURIComponent(candidate)}`),
        {
          cache: "no-store",
        },
      );
      const payload = (await response.json()) as
        RoomInfoResponse | { error: string };
      if (!response.ok || "error" in payload) {
        setJoinError(
          "error" in payload ? payload.error : "Could not find that session",
        );
        return;
      }
      router.push(`/join/${candidate}`);
    } catch {
      setJoinError("Network error — is the server running?");
    } finally {
      setJoinBusy(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0 grid-backdrop opacity-40" />
      <div className="pointer-events-none absolute left-1/2 top-[-18rem] h-[36rem] w-[36rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />

      <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Code2 className="h-4 w-4" />
          </span>
          <span className="text-sm font-semibold tracking-tight">CodeSync</span>
          <Badge variant="outline" className="ml-1 hidden sm:inline-flex">
            beta
          </Badge>
        </Link>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? (
              <Sun className="h-4 w-4" />
            ) : (
              <Moon className="h-4 w-4" />
            )}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setJoinOpen(true)}>
            <KeyRound className="h-4 w-4" /> Join with key
          </Button>
          <Button
            size="sm"
            onClick={() => setStartOpen(true)}
            className="hidden sm:inline-flex"
          >
            Start a session
          </Button>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-6xl px-6 pb-24">
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45 }}
          className="mx-auto max-w-3xl pt-14 text-center sm:pt-20"
        >
          <Badge className="mb-5 gap-1.5 px-3 py-1 text-[10px]">
            <Sparkles className="h-3 w-3" /> Google Docs meets VS Code
          </Badge>
          <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
            Code together.
            <span className="bg-gradient-to-r from-primary via-sky-400 to-emerald-400 bg-clip-text text-transparent">
              {" "}
              Talk it through.
            </span>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-balance text-sm leading-relaxed text-muted-foreground sm:text-base">
            Share one key. Everyone lands in the same editor with live cursors,
            voice, video and screen share — while the host keeps full control of
            who can do what.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button size="lg" onClick={() => setStartOpen(true)}>
              Start a session <ArrowRight className="h-4 w-4" />
            </Button>
            <Button
              size="lg"
              variant="outline"
              onClick={() => setJoinOpen(true)}
            >
              <KeyRound className="h-4 w-4" /> I have a key
            </Button>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            No account. No install. Up to 8 people per room.
          </p>
        </motion.section>

        <HeroPreview />

        <section className="mt-20 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <div
              key={feature.title}
              className="rounded-xl border border-border bg-card/60 p-5 transition-colors hover:border-primary/40"
            >
              <feature.icon className="h-5 w-5 text-primary" />
              <h3 className="mt-3 text-sm font-semibold">{feature.title}</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                {feature.body}
              </p>
            </div>
          ))}
        </section>

        <section className="mt-20 grid gap-4 rounded-2xl border border-border bg-card/50 p-6 sm:grid-cols-3">
          {[
            {
              step: "01",
              label: "Start a room",
              copy: "Name it, pick auto or manual admission.",
            },
            {
              step: "02",
              label: "Share the key",
              copy: "One 21-character key. Paste or copy the link.",
            },
            {
              step: "03",
              label: "Ship together",
              copy: "Edit, talk, share screens, save to the host disk.",
            },
          ].map((item) => (
            <div key={item.step} className="flex gap-3">
              <span className="font-mono text-xs text-primary">
                {item.step}
              </span>
              <div>
                <p className="text-sm font-medium">{item.label}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {item.copy}
                </p>
              </div>
            </div>
          ))}
        </section>
      </main>

      <footer className="relative z-10 border-t border-border bg-background">
        <div className="mx-auto grid max-w-6xl gap-10 px-6 py-12 md:grid-cols-[1.6fr_1fr]">
          <div>
            <Link href="/" className="inline-flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-sky-400 to-indigo-500 text-zinc-950 shadow-sm">
                <Code2 className="h-4 w-4" />
              </span>
              <span className="text-[15px] font-semibold tracking-tight">
                CodeSync
              </span>
            </Link>
            <p className="mt-4 max-w-xs text-sm leading-6 text-muted-foreground">
              A real-time coding workspace for shared editing, chat, video, and
              screen share.
            </p>
          </div>

          <div>
            <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Workspace
            </h2>
            <ul className="mt-4 space-y-2.5">
              <li>
                <button
                  type="button"
                  onClick={() => setStartOpen(true)}
                  className="text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  Start a session
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => setJoinOpen(true)}
                  className="text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  Join with a key
                </button>
              </li>
              <li>
                <a
                  href="https://github.com/Perry-Jacobs/codesync"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  GitHub
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="border-t border-border">
          <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <p>Created by Perry Jacobs</p>
            <p>Built with Next.js, Yjs, WebRTC, and Cloudflare.</p>
          </div>
        </div>
      </footer>

      <Dialog open={startOpen} onOpenChange={setStartOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start a live session</DialogTitle>
            <DialogDescription>
              You become the host. Guests can join with the key or the invite
              link.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="host-name">Your name</Label>
              <Input
                id="host-name"
                autoFocus
                maxLength={48}
                placeholder="Maya"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="room-title">Session title</Label>
              <Input
                id="room-title"
                maxLength={80}
                placeholder="Pairing on the auth service"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <div>
                <p className="text-sm font-medium">Manual waiting room</p>
                <p className="text-xs text-muted-foreground">
                  You admit each guest before they can see the room.
                </p>
              </div>
              <Switch checked={manualAdmit} onCheckedChange={setManualAdmit} />
            </div>
            {formError ? (
              <p className="text-xs text-destructive">{formError}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setStartOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button onClick={() => void createRoom()} disabled={busy}>
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Lock className="h-4 w-4" />
              )}
              Create session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={joinOpen} onOpenChange={setJoinOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Join with a key</DialogTitle>
            <DialogDescription>
              Paste the session key or the full invite link you received.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="join-key">Session key</Label>
            <Input
              id="join-key"
              autoFocus
              spellCheck={false}
              placeholder="zk-9fX2kQ7mT1pLr4Vw8uW"
              value={joinKey}
              onChange={(event) => setJoinKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void joinRoom();
              }}
            />
            {joinError ? (
              <p className="text-xs text-destructive">{joinError}</p>
            ) : null}
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Check className="h-3 w-3 text-emerald-400" />
              Keys are case-sensitive and 21 characters long.
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setJoinOpen(false)}
              disabled={joinBusy}
            >
              Cancel
            </Button>
            <Button onClick={() => void joinRoom()} disabled={joinBusy}>
              {joinBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowRight className="h-4 w-4" />
              )}
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
