export type ComparisonResult = {
  text: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model: string;
  error?: string;
};

export type ComparisonResponse = {
  result_a: ComparisonResult;
  result_b: ComparisonResult;
  executedAt: string;
};
