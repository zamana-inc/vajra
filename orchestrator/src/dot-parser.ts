import { PipelineGraph, GraphEdge, GraphNode } from "./types";

type Token = {
  kind: "word" | "string" | "symbol";
  value: string;
};

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (source.startsWith("//", index)) {
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (source.startsWith("/*", index)) {
      index += 2;
      while (index < source.length && !source.startsWith("*/", index)) {
        index += 1;
      }
      index = Math.min(index + 2, source.length);
      continue;
    }

    if (source.startsWith("->", index)) {
      tokens.push({ kind: "symbol", value: "->" });
      index += 2;
      continue;
    }

    if ("{}[]=,;".includes(char)) {
      tokens.push({ kind: "symbol", value: char });
      index += 1;
      continue;
    }

    if (char === "\"") {
      let value = "";
      index += 1;

      while (index < source.length) {
        const current = source[index];

        if (current === "\\") {
          const next = source[index + 1];
          if (next === "n") {
            value += "\n";
          } else if (next === "t") {
            value += "\t";
          } else {
            value += next;
          }
          index += 2;
          continue;
        }

        if (current === "\"") {
          index += 1;
          break;
        }

        value += current;
        index += 1;
      }

      tokens.push({ kind: "string", value });
      continue;
    }

    let value = "";
    while (index < source.length) {
      const current = source[index];
      if (/\s/.test(current) || "{}[]=,;".includes(current) || source.startsWith("->", index)) {
        break;
      }
      value += current;
      index += 1;
    }

    if (!value) {
      throw new Error(`unexpected token near index ${index}`);
    }

    tokens.push({ kind: "word", value });
  }

  return tokens;
}

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): PipelineGraph {
    this.expectWord("digraph");
    const graphId = this.expectKind("word").value;
    this.expectSymbol("{");

    const graphAttrs: Record<string, string> = {};
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];

    while (!this.peekSymbol("}")) {
      if (this.peekWord("graph")) {
        this.consume();
        Object.assign(graphAttrs, this.parseAttrBlock());
        this.optionalSymbol(";");
        continue;
      }

      const first = this.expectKind("word").value;

      if (this.peekSymbol("=")) {
        this.consume();
        graphAttrs[first] = this.parseValue();
        this.optionalSymbol(";");
        continue;
      }

      if (this.peekSymbol("->")) {
        const chain = [first];
        while (this.peekSymbol("->")) {
          this.consume();
          chain.push(this.expectKind("word").value);
        }

        const attrs = this.peekSymbol("[") ? this.parseAttrBlock() : {};
        this.optionalSymbol(";");

        for (let index = 0; index < chain.length - 1; index += 1) {
          edges.push({
            from: chain[index],
            to: chain[index + 1],
            attrs: { ...attrs },
          });
        }

        chain.forEach((id) => this.ensureNode(nodes, id));
        continue;
      }

      const attrs = this.peekSymbol("[") ? this.parseAttrBlock() : {};
      this.optionalSymbol(";");
      const existing = nodes.get(first) ?? this.makeNode(first);
      existing.attrs = { ...existing.attrs, ...attrs };
      existing.type = this.resolveNodeType(existing.attrs);
      nodes.set(first, existing);
    }

    this.expectSymbol("}");

    return {
      id: graphId,
      graphAttrs,
      nodes,
      edges,
    };
  }

  private makeNode(id: string): GraphNode {
    return { id, attrs: {}, type: "agent" };
  }

  private ensureNode(nodes: Map<string, GraphNode>, id: string): void {
    if (!nodes.has(id)) {
      nodes.set(id, this.makeNode(id));
    }
  }

  private resolveNodeType(attrs: Record<string, string>): GraphNode["type"] {
    if (attrs.type === "start" || attrs.shape === "Mdiamond") {
      return "start";
    }

    if (attrs.type === "exit" || attrs.shape === "Msquare") {
      return "exit";
    }

    if (attrs.type === "tool") {
      return "tool";
    }

    if (attrs.type === "fan_out" || attrs.type === "fan_in") {
      return attrs.type;
    }

    if (attrs.type && attrs.type !== "agent") {
      throw new Error(`unsupported node type for v1: ${attrs.type}`);
    }

    return "agent";
  }

  private parseAttrBlock(): Record<string, string> {
    const attrs: Record<string, string> = {};
    this.expectSymbol("[");

    while (!this.peekSymbol("]")) {
      const key = this.expectKind("word").value;
      this.expectSymbol("=");
      attrs[key] = this.parseValue();

      if (this.peekSymbol(",")) {
        this.consume();
      } else {
        break;
      }
    }

    this.expectSymbol("]");
    return attrs;
  }

  private parseValue(): string {
    const token = this.consume();
    if (!token || (token.kind !== "word" && token.kind !== "string")) {
      throw new Error("expected a value");
    }
    return token.value;
  }

  private expectKind(kind: Token["kind"]): Token {
    const token = this.consume();
    if (!token || token.kind !== kind) {
      throw new Error(`expected token kind ${kind}`);
    }
    return token;
  }

  private expectWord(value: string): void {
    const token = this.expectKind("word");
    if (token.value !== value) {
      throw new Error(`expected word ${value}`);
    }
  }

  private expectSymbol(value: string): void {
    const token = this.consume();
    if (!token || token.kind !== "symbol" || token.value !== value) {
      throw new Error(`expected symbol ${value}`);
    }
  }

  private peekWord(value: string): boolean {
    const token = this.tokens[this.index];
    return !!token && token.kind === "word" && token.value === value;
  }

  private peekSymbol(value: string): boolean {
    const token = this.tokens[this.index];
    return !!token && token.kind === "symbol" && token.value === value;
  }

  private optionalSymbol(value: string): boolean {
    if (!this.peekSymbol(value)) {
      return false;
    }
    this.consume();
    return true;
  }

  private consume(): Token | undefined {
    const token = this.tokens[this.index];
    this.index += 1;
    return token;
  }
}

export function parseDotGraph(source: string): PipelineGraph {
  return new Parser(tokenize(source)).parse();
}
