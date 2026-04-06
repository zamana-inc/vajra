import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { parseDotGraph } from "../src/dot-parser";
import { buildTraversalGraph } from "../src/pipeline-graph";
import { orderedDisplayStageNodes, validateLinearStageOrder } from "../src/stage-order";

test("parseDotGraph returns ordered stage nodes for a linear pipeline", () => {
  const graph = parseDotGraph(`
    digraph Example {
      start [shape=Mdiamond];
      exit [shape=Msquare];
      plan [label="Plan", agent="claude"];
      review_plan [label="Review Plan", agent="codex"];
      start -> plan -> review_plan -> exit;
    }
  `);

  const nodes = orderedDisplayStageNodes(graph);
  assert.deepEqual(nodes.map((node) => node.id), ["plan", "review_plan"]);
});

test("validateLinearStageOrder rejects branching graphs in linear display mode", () => {
  const graph = parseDotGraph(`
    digraph Example {
      start [shape=Mdiamond];
      exit [shape=Msquare];
      plan [label="Plan", agent="claude"];
      code [label="Code", agent="codex"];
      review [label="Review", agent="claude"];
      start -> plan;
      start -> code;
      plan -> review -> exit;
      code -> review;
    }
  `);

  const errors = validateLinearStageOrder(graph);
  assert.ok(errors.length > 0);
});

test("validateLinearStageOrder rejects graphs without explicit start and exit nodes", () => {
  const graph = parseDotGraph(`
    digraph Example {
      plan [label="Plan", agent="claude"];
      review_plan [label="Review Plan", agent="codex"];
      plan -> review_plan;
    }
  `);

  const errors = validateLinearStageOrder(graph);
  assert.ok(errors.some((error) => error.includes("start node")));
  assert.ok(errors.some((error) => error.includes("exit node")));
});

test("parseDotGraph recognizes tool nodes in the linear subset", () => {
  const graph = parseDotGraph(`
    digraph Example {
      start [shape=Mdiamond];
      exit [shape=Msquare];
      notify [type="tool", command="echo hi"];
      start -> notify -> exit;
    }
  `);

  const nodes = orderedDisplayStageNodes(graph);
  assert.equal(nodes[0]?.type, "tool");
});

test("parseDotGraph accepts fan_out and fan_in node types for future workflows", () => {
  const graph = parseDotGraph(`
    digraph Example {
      start [shape=Mdiamond];
      exit [shape=Msquare];
      brainstorm [type="fan_out", collection="ideas"];
      choose [type="fan_in", collection="ideas", agent="selector"];
      start -> brainstorm -> choose -> exit;
    }
  `);

  assert.equal(graph.nodes.get("brainstorm")?.type, "fan_out");
  assert.equal(graph.nodes.get("choose")?.type, "fan_in");
});

test("buildTraversalGraph rejects duplicate on_label edges from the same node", () => {
  const graph = parseDotGraph(`
    digraph Example {
      start [shape=Mdiamond];
      success [shape=Msquare];
      reject [shape=Msquare];
      review [agent="reviewer"];
      start -> review;
      review -> success [on_label="lgtm"];
      review -> reject [on_label="lgtm"];
    }
  `);

  assert.throws(() => buildTraversalGraph(graph), /duplicate on_label lgtm/);
});

test("buildTraversalGraph rejects unknown on_exhaustion targets", () => {
  const graph = parseDotGraph(`
    digraph Example {
      start [shape=Mdiamond];
      exit [shape=Msquare];
      plan [agent="planner", max_visits="2", on_exhaustion="escalate"];
      start -> plan -> exit;
    }
  `);

  assert.throws(() => buildTraversalGraph(graph), /unknown on_exhaustion target escalate/);
});

test("parseDotGraph preserves comment markers inside quoted strings while skipping real comments", () => {
  const graph = parseDotGraph(`
    digraph Example {
      start [shape=Mdiamond];
      exit [shape=Msquare];
      // Real comment should be ignored.
      plan [
        label="Plan // keep this",
        command="printf 'https://example.com /* keep this too */'"
      ];
      /* Another real comment. */
      start -> plan -> exit;
    }
  `);

  assert.equal(graph.nodes.get("plan")?.attrs.label, "Plan // keep this");
  assert.equal(
    graph.nodes.get("plan")?.attrs.command,
    "printf 'https://example.com /* keep this too */'",
  );
});

test("default pipeline keeps behavior out of DOT stages and references named agents", async () => {
  const source = await readFile(new URL("../../pipelines/default.dot", import.meta.url), "utf8");
  const graph = parseDotGraph(source);
  const preparePr = graph.nodes.get("prepare_pr");

  assert.ok(preparePr);
  assert.equal(preparePr.type, "agent");
  assert.equal(preparePr.attrs.agent, "pr-preparer");
  assert.equal(preparePr.attrs.artifact_path, ".vajra/run/pr-body.md");
  assert.equal(preparePr.attrs.prompt, undefined);
  assert.equal(preparePr.attrs.model, undefined);
});
