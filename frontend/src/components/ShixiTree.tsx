import { useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { fetchShixi, type ShixiNode, type ShixiPayload } from "../lib/api";

type NodeKind = "EMPEROR" | "MAIN" | "TRANSIT" | "BRANCH";

type Annotated = Omit<ShixiNode, "children"> & {
  _id: string;
  _kind: NodeKind;
  _hasEmperorBelow: boolean;
  _depth: number;
  children: Annotated[];
};

function classify(node: ShixiNode, mainOrTransitBelow: boolean): NodeKind {
  if (node.emperor) return "EMPEROR";
  if (typeof node.rank === "number") return "MAIN";
  if (node.flags?.includes("追封") && mainOrTransitBelow) return "TRANSIT";
  return "BRANCH";
}

function annotate(raw: ShixiNode, path: string, depth: number): Annotated {
  const kids = (raw.children ?? []).map((c, i) => annotate(c, `${path}/${i}`, depth + 1));
  // mainOrTransitBelow: any descendant is MAIN/TRANSIT (used to decide if 追封 should count as TRANSIT)
  const anyMainBelow = kids.some(
    (k) => k._kind === "MAIN" || k._kind === "TRANSIT" || typeof k.rank === "number",
  );
  const kind = classify(raw, anyMainBelow);
  const hasEmperorBelow = kids.some((k) => k._kind === "EMPEROR" || k._hasEmperorBelow);
  const id = `${path}:${raw.name ?? raw.title ?? "x"}:${raw.rank ?? ""}`;
  return {
    ...raw,
    _id: id,
    _kind: kind,
    _hasEmperorBelow: hasEmperorBelow,
    _depth: depth,
    children: kids,
  };
}

/**
 * Recursively expand a chunk starting at `node`.
 * Rule:
 *   - Add this node and all its MAIN/TRANSIT descendants in a continuous chain.
 *   - Stop descent on a child if the child is EMPEROR (already on main trunk)
 *     or if it's a BRANCH (leave collapsed as a separate expand entry).
 *   - For a single MAIN-line child, always recurse (avoid single-传 clicking).
 */
function chunkExpand(node: Annotated, set: Set<string>) {
  set.add(node._id);
  for (const c of node.children) {
    if (c._kind === "EMPEROR") continue; // emperor leg shown on main trunk, do not re-expand
    if (c._kind === "MAIN" || c._kind === "TRANSIT") {
      chunkExpand(c, set);
    }
    // BRANCH children: keep collapsed (user can click to open)
  }
}

/** Default visible set is empty.
 *  Each NodeBox falls back to "emperor-line children only" when its id is
 *  not in the set, so the entire emperor chain renders automatically and
 *  every other branch starts folded.
 */
function defaultExpansion(_root: Annotated, _auxRoots: Annotated[]): Set<string> {
  return new Set<string>();
}

function countSubtree(n: Annotated): number {
  let c = 1;
  for (const k of n.children) c += countSubtree(k);
  return c;
}

function NodeBox({
  node,
  expanded,
  onToggle,
}: {
  node: Annotated;
  expanded: Set<string>;
  onToggle: (n: Annotated) => void;
}) {
  const isOpen = expanded.has(node._id);
  const hasKids = node.children.length > 0;
  const hasEmperorBelow = node._hasEmperorBelow;
  const isEmperor = node._kind === "EMPEROR";

  // Decide which children render in this pass.
  // - isOpen: render all
  // - !isOpen + has emperor below: render only the emperor-line children
  // - !isOpen + no emperor below: render nothing (fully folded)
  let visibleChildren: Annotated[] = [];
  if (isOpen) {
    visibleChildren = node.children;
  } else if (hasEmperorBelow || isEmperor) {
    visibleChildren = node.children.filter(
      (c) => c._kind === "EMPEROR" || c._hasEmperorBelow,
    );
  }

  const hiddenCount = node.children.length - visibleChildren.length;
  const subSize = useMemo(() => countSubtree(node) - 1, [node]);

  const klass =
    node._kind === "EMPEROR"
      ? "dt-emperor"
      : node._kind === "MAIN"
      ? "dt-main"
      : node._kind === "TRANSIT"
      ? "dt-transit"
      : "dt-branch-leaf";

  const label = node.name || node.title || "?";
  const titleLine = node.title && node.title !== label ? node.title : "";
  const emperor = node.emperor;
  const fate = node.fate;
  const subline = emperor ?? titleLine;

  // Count badge logic:
  //   - if fully folded leaf (nothing shown): show "▾ N" with N = subtree size
  //   - if partial (emperor-line only, others hidden): show "▾ +M" hidden count
  //   - if fully open: no badge
  let countBadge: string | null = null;
  if (!isOpen) {
    if (visibleChildren.length === 0 && hasKids) {
      countBadge = `▾ ${subSize}`;
    } else if (hiddenCount > 0) {
      countBadge = `+${hiddenCount} 子`;
    }
  }

  return (
    <div className="dt-branch">
      <div className="dt-node-wrap">
        <button
          type="button"
          className={`dt-node ${klass} ${isOpen ? "is-open" : ""}`}
          onClick={() => hasKids && onToggle(node)}
          title={node.note || (node.fu ? `${node.fu}府` : "")}
        >
          <span className="dt-label">
            {hasKids && (
              <span className={`dt-chev ${isOpen ? "is-open" : ""}`}>
                <ChevronRight size={10} />
              </span>
            )}
            {label}
            {fate && <span className="dt-fate">{fate}</span>}
          </span>
          {subline && <span className="dt-reign">{subline}</span>}
          {countBadge && <span className="dt-collapsed-count">{countBadge}</span>}
        </button>
      </div>
      {visibleChildren.length > 0 && (
        <>
          <div className="dt-vline" />
          <div className="dt-children">
            {visibleChildren.map((c) => (
              <NodeBox key={c._id} node={c} expanded={expanded} onToggle={onToggle} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function ShixiTree() {
  const [data, setData] = useState<ShixiPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let alive = true;
    fetchShixi()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, []);

  const trees = useMemo(() => {
    if (!data) return null;
    return { main: annotate(data.root, "r", 0) };
  }, [data]);

  // Default expand: emperor trunk only (others fold per render rule)
  useEffect(() => {
    if (!trees) return;
    setExpanded(defaultExpansion(trees.main, []));
  }, [trees]);

  const onToggle = (node: Annotated) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(node._id)) {
        // Collapse: remove this node and all descendants from the set
        const dropAll = (n: Annotated) => {
          next.delete(n._id);
          n.children.forEach(dropAll);
        };
        dropAll(node);
      } else if (node._hasEmperorBelow || node._kind === "EMPEROR") {
        // Emperor-line node: open just this one level so all siblings show
        next.add(node._id);
      } else {
        // Fu-branch node: chunk-expand main lineage to avoid single-传 clicks
        chunkExpand(node, next);
      }
      return next;
    });
  };

  const collapseAll = () => {
    if (!trees) return;
    setExpanded(defaultExpansion(trees.main, []));
  };

  const expandAll = () => {
    if (!trees) return;
    const next = new Set<string>();
    const walk = (n: Annotated) => {
      next.add(n._id);
      n.children.forEach(walk);
    };
    walk(trees.main);
    setExpanded(next);
  };

  // Search: expand ancestors of any matching node
  useEffect(() => {
    if (!trees || !filter.trim()) return;
    const q = filter.trim();
    setExpanded((prev) => {
      const next = new Set(prev);
      const walk = (n: Annotated, ancestors: string[]): boolean => {
        const matched =
          (n.name && n.name.includes(q)) ||
          (n.title && n.title.includes(q)) ||
          (n.fu && n.fu.includes(q)) ||
          (n.emperor && n.emperor.includes(q));
        let childMatched = false;
        for (const c of n.children) {
          if (walk(c, [...ancestors, n._id])) childMatched = true;
        }
        if (matched || childMatched) {
          ancestors.forEach((a) => next.add(a));
          next.add(n._id);
          return true;
        }
        return false;
      };
      walk(trees.main, []);
      return next;
    });
  }, [filter, trees]);

  if (error) return <div className="shixi-status">加载失败：{error}</div>;
  if (!trees) return <div className="shixi-status">加载中…</div>;

  return (
    <div className="shixi-tree-root">
      <div className="shixi-controls">
        <input
          type="search"
          className="shixi-search"
          placeholder="搜索人名 / 封号 / 府国（如 朱由检 / 福王 / 唐）"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="shixi-buttons">
          <button type="button" className="ghost-button compact-button" onClick={collapseAll}>
            仅展开帝系
          </button>
          <button type="button" className="ghost-button compact-button" onClick={expandAll}>
            全展开 (370 节点)
          </button>
        </div>
        <div className="shixi-legend">
          <span className="lg-emperor">皇帝</span>
          <span className="lg-main">府亲王</span>
          <span className="lg-transit">追封过渡</span>
          <span className="lg-branch">郡王/旁支</span>
          <span className="lg-fate">末代结局</span>
        </div>
      </div>
      <div className="dynasty-tree-container shixi-canvas">
        <div className="dynasty-tree-scroll">
          <div className="dt-root">
            <NodeBox node={trees.main} expanded={expanded} onToggle={onToggle} />
          </div>
        </div>
      </div>
    </div>
  );
}
