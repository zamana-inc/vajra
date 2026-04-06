"use client";

import { Fragment, useMemo, type ReactNode } from "react";

type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3; content: string }
  | { type: "paragraph"; lines: string[] }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; content: string }
  | { type: "table"; rows: string[][] };

const HEADING_STYLES: Record<1 | 2 | 3, string> = {
  1: "mb-3 text-[18px] font-semibold tracking-tight text-[var(--d-text-primary)]",
  2: "mb-3 text-[16px] font-semibold text-[var(--d-text-primary)]",
  3: "mb-2 text-[14px] font-semibold text-[var(--d-text-primary)]",
};

function isTableSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseMarkdown(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  const paragraph: string[] = [];
  let listState: { ordered: boolean; items: string[] } | null = null;
  let codeFenceLines: string[] | null = null;
  let tableRows: string[][] | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }
    blocks.push({ type: "paragraph", lines: [...paragraph] });
    paragraph.length = 0;
  };

  const flushList = () => {
    if (!listState || listState.items.length === 0) {
      listState = null;
      return;
    }
    blocks.push({ type: "list", ordered: listState.ordered, items: [...listState.items] });
    listState = null;
  };

  const flushTable = () => {
    if (!tableRows || tableRows.length === 0) {
      tableRows = null;
      return;
    }
    blocks.push({ type: "table", rows: [...tableRows] });
    tableRows = null;
  };

  for (const line of lines) {
    if (codeFenceLines !== null) {
      if (/^```/.test(line)) {
        blocks.push({ type: "code", content: codeFenceLines.join("\n") });
        codeFenceLines = null;
      } else {
        codeFenceLines.push(line);
      }
      continue;
    }

    if (/^```/.test(line)) {
      flushParagraph();
      flushList();
      flushTable();
      codeFenceLines = [];
      continue;
    }

    const tableMatch = line.match(/^\|(.+)\|$/);
    if (tableMatch) {
      flushParagraph();
      flushList();
      const cells = tableMatch[1].split("|").map((cell) => cell.trim());
      tableRows ??= [];
      if (!isTableSeparator(cells)) {
        tableRows.push(cells);
      }
      continue;
    }

    flushTable();

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      blocks.push({
        type: "heading",
        level: headingMatch[1].length as 1 | 2 | 3,
        content: headingMatch[2].trim(),
      });
      continue;
    }

    const unorderedMatch = line.match(/^- (.+)$/);
    if (unorderedMatch) {
      flushParagraph();
      if (!listState || listState.ordered) {
        flushList();
        listState = { ordered: false, items: [] };
      }
      listState.items.push(unorderedMatch[1]);
      continue;
    }

    const orderedMatch = line.match(/^\d+\.\s+(.+)$/);
    if (orderedMatch) {
      flushParagraph();
      if (!listState || !listState.ordered) {
        flushList();
        listState = { ordered: true, items: [] };
      }
      listState.items.push(orderedMatch[1]);
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      flushList();
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  flushTable();

  if (codeFenceLines !== null) {
    blocks.push({ type: "code", content: codeFenceLines.join("\n") });
  }

  return blocks;
}

function renderInline(text: string): ReactNode[] {
  return text
    .split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g)
    .filter(Boolean)
    .map((segment, index) => {
      if (segment.startsWith("`") && segment.endsWith("`")) {
        return (
          <code
            key={`code-${index}`}
            className="rounded bg-[var(--d-bg-hover)] px-1 py-0.5 font-mono text-[12px] text-[var(--d-text-primary)]"
          >
            {segment.slice(1, -1)}
          </code>
        );
      }

      if (segment.startsWith("**") && segment.endsWith("**")) {
        return (
          <strong key={`strong-${index}`} className="font-semibold text-[var(--d-text-primary)]">
            {renderInline(segment.slice(2, -2))}
          </strong>
        );
      }

      if (segment.startsWith("*") && segment.endsWith("*")) {
        return (
          <em key={`em-${index}`} className="italic">
            {renderInline(segment.slice(1, -1))}
          </em>
        );
      }

      return <Fragment key={`text-${index}`}>{segment}</Fragment>;
    });
}

function renderLines(lines: string[]): ReactNode[] {
  return lines.map((line, index) => (
    <Fragment key={`line-${index}`}>
      {index > 0 ? <br /> : null}
      {renderInline(line)}
    </Fragment>
  ));
}

export function SimpleMarkdown({ content }: { content: string }) {
  const blocks = useMemo(() => parseMarkdown(content), [content]);

  return (
    <div className="space-y-4 text-[13px] leading-relaxed text-[var(--d-text-secondary)]">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          const HeadingTag = `h${block.level + 1}` as "h2" | "h3" | "h4";
          return (
            <HeadingTag key={`heading-${index}`} className={HEADING_STYLES[block.level]}>
              {renderInline(block.content)}
            </HeadingTag>
          );
        }

        if (block.type === "paragraph") {
          return (
            <p key={`paragraph-${index}`} className="text-[13px] leading-relaxed text-[var(--d-text-secondary)]">
              {renderLines(block.lines)}
            </p>
          );
        }

        if (block.type === "list") {
          const ListTag = block.ordered ? "ol" : "ul";
          return (
            <ListTag
              key={`list-${index}`}
              className={`space-y-1 pl-5 text-[13px] text-[var(--d-text-secondary)] ${
                block.ordered ? "list-decimal" : "list-disc"
              }`}
            >
              {block.items.map((item, itemIndex) => (
                <li key={`item-${itemIndex}`}>{renderInline(item)}</li>
              ))}
            </ListTag>
          );
        }

        if (block.type === "code") {
          return (
            <pre
              key={`code-${index}`}
              className="overflow-x-auto rounded-lg bg-[var(--d-bg-hover)] px-4 py-3 text-[12px] leading-6 text-[var(--d-text-primary)]"
            >
              <code className="whitespace-pre font-mono">{block.content}</code>
            </pre>
          );
        }

        return (
          <div
            key={`table-${index}`}
            className="overflow-x-auto rounded-lg border border-[var(--d-border)] bg-[var(--d-bg-surface)]"
          >
            <table className="min-w-full border-collapse text-left text-[12px]">
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={`row-${rowIndex}`} className="border-b border-[var(--d-border)] last:border-0">
                    {row.map((cell, cellIndex) => (
                      <td
                        key={`cell-${cellIndex}`}
                        className="px-3 py-2 align-top text-[var(--d-text-secondary)]"
                      >
                        {renderInline(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
