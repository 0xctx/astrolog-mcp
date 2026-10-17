import type { McpServer } from "@modelcontextprotocol/server";
import pLimit from "p-limit";
import { DEFAULT_ENGINE_LIMITS, type EngineLimits } from "./limits.js";
import { CHART_TOOL_NAME, registerChartTool } from "./tools/chart.js";
import { COMPOSITE_TOOL_NAME, registerCompositeTool } from "./tools/composite.js";
import { DAILY_TOOL_NAME, registerDailyTool } from "./tools/daily.js";
import type { ToolDeps } from "./tools/deps.js";
import { HARMONIC_TOOL_NAME, registerHarmonicTool } from "./tools/harmonic.js";
import { TRANSIT_TOOL_NAME, registerTransitTool } from "./tools/transit.js";

// Every tool this server offers, registered on a server instance. It does not know about HTTP or
// stdio, so each transport gets the same tools by calling register on its own McpServer.
export interface Registry {
  register(server: McpServer): void;
}

// The names of every tool the registry registers, sorted. Transport tests compare the list a
// client sees against it, so a new tool needs its name added here as well as its register call.
export function toolNames(): string[] {
  return [CHART_TOOL_NAME, TRANSIT_TOOL_NAME, COMPOSITE_TOOL_NAME, HARMONIC_TOOL_NAME, DAILY_TOOL_NAME].sort();
}

// The engine slots are shared by every server this registry registers, so the in-flight cap
// holds across concurrent HTTP requests. The waiting room size travels in the deps, where the
// tools that queue an engine call read it.
export function createRegistry(deps: ToolDeps, limits: EngineLimits = DEFAULT_ENGINE_LIMITS): Registry {
  const limit = pLimit(limits.engineConcurrency);
  const shared: ToolDeps = { ...deps, engineQueue: limits.engineQueue };
  return {
    register(server) {
      registerChartTool(server, shared, limit);
      registerTransitTool(server, shared, limit);
      registerCompositeTool(server, shared, limit);
      registerHarmonicTool(server, shared, limit);
      registerDailyTool(server, shared, limit);
    },
  };
}
