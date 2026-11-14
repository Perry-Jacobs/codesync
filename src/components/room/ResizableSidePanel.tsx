"use client";

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

interface ResizableSidePanelProps {
  side: "left" | "right";
  width: number;
  minWidth: number;
  maxWidth: number;
  onWidthChange(width: number): void;
  children: ReactNode;
  className?: string;
}

interface DragState {
  pointerId: number;
  startX: number;
  startWidth: number;
}

export function ResizableSidePanel({
  side,
  width,
  minWidth,
  maxWidth,
  onWidthChange,
  children,
  className,
}: ResizableSidePanelProps) {
  const [dragging, setDragging] = useState(false);
  const dragState = useRef<DragState | null>(null);
  const safeMaxWidth = Math.max(minWidth, maxWidth);

  useEffect(() => {
    if (!dragging) return;

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [dragging]);

  const clampWidth = (nextWidth: number): number =>
    Math.min(Math.max(nextWidth, minWidth), safeMaxWidth);

  const handlePointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: clampWidth(width),
    };
    setDragging(true);
  };

  const handlePointerMove = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    const state = dragState.current;
    if (!state || state.pointerId !== event.pointerId) return;

    const movement = event.clientX - state.startX;
    const nextWidth =
      side === "left"
        ? state.startWidth + movement
        : state.startWidth - movement;
    onWidthChange(clampWidth(nextWidth));
  };

  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (dragState.current?.pointerId !== event.pointerId) return;
    dragState.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
  ): void => {
    const step = event.shiftKey ? 40 : 12;
    let nextWidth = width;

    if (event.key === "ArrowLeft") {
      nextWidth = side === "left" ? width - step : width + step;
    } else if (event.key === "ArrowRight") {
      nextWidth = side === "left" ? width + step : width - step;
    } else if (event.key === "Home") {
      nextWidth = minWidth;
    } else if (event.key === "End") {
      nextWidth = safeMaxWidth;
    } else {
      return;
    }

    event.preventDefault();
    onWidthChange(clampWidth(nextWidth));
  };

  return (
    <div
      className={cn("relative flex shrink-0", className)}
      style={{ width: clampWidth(width) }}
    >
      <div className="h-full min-h-0 w-full overflow-hidden bg-card">
        {children}
      </div>
      <button
        type="button"
        role="separator"
        aria-label={`Resize ${side} panel`}
        aria-orientation="vertical"
        aria-valuemin={minWidth}
        aria-valuemax={safeMaxWidth}
        aria-valuenow={Math.round(clampWidth(width))}
        title="Drag to resize · use arrow keys for precise sizing"
        className={cn(
          "group absolute inset-y-0 z-20 w-3 touch-none outline-none",
          side === "left" ? "-right-1.5" : "-left-1.5",
          dragging && "cursor-col-resize",
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onKeyDown={handleKeyDown}
      >
        <span
          className={cn(
            "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-[width,background-color,box-shadow] duration-150",
            "group-hover:w-0.5 group-hover:bg-primary group-hover:shadow-[0_0_8px_hsl(var(--primary)/0.45)]",
            "group-focus-visible:w-0.5 group-focus-visible:bg-primary group-focus-visible:shadow-[0_0_8px_hsl(var(--primary)/0.65)]",
            dragging &&
              "w-0.5 bg-primary shadow-[0_0_10px_hsl(var(--primary)/0.65)]",
          )}
        />
      </button>
    </div>
  );
}
