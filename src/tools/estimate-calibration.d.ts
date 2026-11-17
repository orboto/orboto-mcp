/** Mirrors AgentEstimateCalibration of @orboto/shared-schema (ORB-3100); the MCP package ships without it, apps/api/src/test/ticket-estimate-mcp-drift.test.ts pins the copy in both directions. */
export interface EstimateCalibrationPopulation {
  estimateBy: 'agent' | 'human';
  workBy: 'agent';
  compares: string;
  count: number;
  multiplier: number | null;
  confidence: 'high' | 'medium' | 'low' | 'insufficient';
}

export interface AgentEstimateCalibration {
  projectId: string;
  windowDays: number;
  populations: EstimateCalibrationPopulation[];
  summary: string;
}
