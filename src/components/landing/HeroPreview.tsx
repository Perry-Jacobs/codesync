'use client';

import { motion } from 'framer-motion';
import { FileCode2, Users } from 'lucide-react';

/** Decorative editor window in the landing hero. */
export function HeroPreview() {
  return (
    <motion.section
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.12 }}
      className="mx-auto mt-16 max-w-4xl overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
    >
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-rose-500/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/80" />
        <span className="ml-3 truncate text-xs text-muted-foreground">
          zk-9fX2kQ7mT1pLr4Vw8uW · src/index.ts
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-[10px] font-medium text-emerald-400">
          <Users className="h-3 w-3" /> 4 live
        </span>
      </div>
      <div className="grid gap-0 sm:grid-cols-[190px_1fr]">
        <div className="hidden border-r border-border p-3 text-xs sm:block">
          {['src', 'src/index.ts', 'src/utils.ts', 'styles.css', 'README.md'].map((entry, i) => (
            <div
              key={entry}
              className={`flex items-center gap-2 rounded px-2 py-1.5 ${
                i === 1 ? 'bg-primary/15 text-primary' : 'text-muted-foreground'
              }`}
            >
              <FileCode2 className="h-3.5 w-3.5" />
              <span className="truncate">{entry}</span>
            </div>
          ))}
        </div>
        <div className="relative overflow-hidden p-5 font-mono text-[12px] leading-6 text-muted-foreground">
          <div>
            <span className="text-[#c792ea]">export function</span>{' '}
            <span className="text-[#d2a8ff]">greet</span>(name: string) {'{'}
          </div>
          <div className="pl-5">
            <span className="text-[#c792ea]">return</span>{' '}
            <span className="text-[#a5d6ff]">`Hello ${'{'}name{'}'}`</span>;
          </div>
          <div>{'}'}</div>
          <div className="mt-3 flex items-center gap-2 text-[11px]">
            <span className="rounded bg-[#4ea1ff] px-1.5 py-0.5 font-sans font-semibold text-[#0b1220]">
              Maya
            </span>
            <span className="h-4 w-0.5 bg-[#4ea1ff]" />
            <span className="text-muted-foreground">typing…</span>
          </div>
          <div className="mt-4 flex items-center gap-1.5">
            <span className="rounded bg-[#f2a33c] px-1.5 py-0.5 font-sans text-[10px] font-semibold text-[#0b1220]">
              Sam
            </span>
            <span className="text-muted-foreground">selecting the function body</span>
          </div>
        </div>
      </div>
    </motion.section>
  );
}
