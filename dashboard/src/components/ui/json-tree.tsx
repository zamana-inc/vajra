"use client";

/**
 * Collapsible JSON tree viewer.
 * Renders objects/arrays as expandable nodes with syntax coloring.
 * Leaf values (strings, numbers, booleans, null) are rendered inline.
 * Automatically collapses large nodes on first render.
 */

import { useState, useMemo, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Auto-collapse arrays/objects with more than this many entries */
const AUTO_COLLAPSE_THRESHOLD = 6;
/** Auto-collapse strings longer than this */
const STRING_TRUNCATE = 200;
/** Max nesting depth before everything collapses */
const MAX_AUTO_EXPAND_DEPTH = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nodeSize(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (isRecord(v)) return Object.keys(v).length;
  return 0;
}

function shouldAutoExpand(v: unknown, depth: number): boolean {
  if (depth >= MAX_AUTO_EXPAND_DEPTH) return false;
  const size = nodeSize(v);
  if (size === 0) return true;
  return size <= AUTO_COLLAPSE_THRESHOLD;
}

/** Summary line for a collapsed node */
function collapsedSummary(v: unknown): string {
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    // Try to describe contents
    const firstType = typeof v[0];
    if (v.every((x) => typeof x === firstType)) {
      if (isRecord(v[0])) {
        const keys = Object.keys(v[0]);
        const preview = keys.slice(0, 3).join(", ");
        return `[${v.length}] {${preview}${keys.length > 3 ? ", …" : ""}}`;
      }
      return `[${v.length} ${firstType}s]`;
    }
    return `[${v.length} items]`;
  }
  if (isRecord(v)) {
    const keys = Object.keys(v);
    if (keys.length === 0) return "{}";
    const preview = keys.slice(0, 4).join(", ");
    return `{${preview}${keys.length > 4 ? ", …" : ""}}`;
  }
  return String(v);
}

// ---------------------------------------------------------------------------
// Value renderers
// ---------------------------------------------------------------------------

function StringValue({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = value.length > STRING_TRUNCATE;

  // URL detection
  const isUrl = /^https?:\/\//.test(value);
  if (isUrl) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[#007aff] hover:underline break-all"
      >
        "{value}"
      </a>
    );
  }

  // Multi-line strings
  if (value.includes("\n")) {
    return (
      <span className="text-[#a6e3a1]">
        <span className="select-none text-[#585b70]">"</span>
        <span className="whitespace-pre-wrap break-words">{isLong && !expanded ? value.slice(0, STRING_TRUNCATE) + "…" : value}</span>
        <span className="select-none text-[#585b70]">"</span>
        {isLong && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="ml-1 text-[10px] text-[#007aff] hover:underline"
          >
            {expanded ? "less" : `+${(value.length - STRING_TRUNCATE).toLocaleString()}`}
          </button>
        )}
      </span>
    );
  }

  return (
    <span className="text-[#a6e3a1] break-all">
      "{isLong && !expanded ? value.slice(0, STRING_TRUNCATE) + "…" : value}"
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="ml-1 text-[10px] text-[#007aff] hover:underline"
        >
          {expanded ? "less" : `+${(value.length - STRING_TRUNCATE).toLocaleString()}`}
        </button>
      )}
    </span>
  );
}

function LeafValue({ value }: { value: unknown }) {
  if (typeof value === "string") return <StringValue value={value} />;
  if (typeof value === "number") return <span className="text-[#fab387]">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="text-[#f9e2af]">{String(value)}</span>;
  if (value === null) return <span className="text-[#6c7086] italic">null</span>;
  return <span className="text-[#cdd6f4]">{String(value)}</span>;
}

// ---------------------------------------------------------------------------
// Tree node
// ---------------------------------------------------------------------------

function TreeNode({ label, value, depth }: {
  label: ReactNode;
  value: unknown;
  depth: number;
}) {
  const isExpandable = Array.isArray(value) || isRecord(value);
  const [open, setOpen] = useState(() =>
    isExpandable ? shouldAutoExpand(value, depth) : true
  );

  if (!isExpandable) {
    return (
      <div className="flex items-baseline gap-0 leading-[1.6]" style={{ paddingLeft: depth > 0 ? 16 : 0 }}>
        {label}
        <LeafValue value={value} />
      </div>
    );
  }

  const size = nodeSize(value);
  const isEmpty = size === 0;
  const isArray = Array.isArray(value);

  if (isEmpty) {
    return (
      <div className="leading-[1.6]" style={{ paddingLeft: depth > 0 ? 16 : 0 }}>
        {label}
        <span className="text-[#6c7086]">{isArray ? "[]" : "{}"}</span>
      </div>
    );
  }

  return (
    <div style={{ paddingLeft: depth > 0 ? 16 : 0 }}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-baseline gap-0 leading-[1.6] hover:bg-white/5 -ml-1 pl-1 rounded"
      >
        <span className="select-none text-[10px] text-[#6c7086] w-3 shrink-0 inline-block text-center">
          {open ? "▾" : "▸"}
        </span>
        {label}
        {!open && (
          <span className="text-[#6c7086] ml-0.5 text-[10px]">
            {collapsedSummary(value)}
          </span>
        )}
      </button>

      {open && (
        <div>
          {isArray
            ? (value as unknown[]).map((item, i) => (
                <TreeNode
                  key={i}
                  label={
                    <span className="text-[#6c7086] select-none mr-1 text-[10px]">{i}</span>
                  }
                  value={item}
                  depth={depth + 1}
                />
              ))
            : Object.entries(value as Record<string, unknown>).map(([key, val]) => (
                <TreeNode
                  key={key}
                  label={
                    <span className="mr-0.5">
                      <span className="text-[#89b4fa]">{key}</span>
                      <span className="text-[#6c7086]">: </span>
                    </span>
                  }
                  value={val}
                  depth={depth + 1}
                />
              ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface JsonTreeProps {
  /** JSON string or already-parsed value */
  data: string | unknown;
  /** Additional CSS class */
  className?: string;
}

export function JsonTree({ data, className }: JsonTreeProps) {
  const parsed = useMemo(() => {
    if (typeof data !== "string") return data;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }, [data]);

  if (parsed === null && typeof data === "string") {
    // Not valid JSON — render as plain text
    return (
      <pre className={`whitespace-pre-wrap break-words text-[11px] font-mono text-[#cdd6f4] ${className ?? ""}`}>
        {data}
      </pre>
    );
  }

  return (
    <div className={`rounded-lg bg-[#1e1e2e] p-3 text-[11px] font-mono text-[#cdd6f4] overflow-auto ${className ?? ""}`}>
      <TreeNode label={null} value={parsed} depth={0} />
    </div>
  );
}
