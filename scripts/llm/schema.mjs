// Output contract for the model (structured outputs). There is deliberately no field for a
// release decision: the review can only describe risks, checks and coverage gaps.
const str = { type: 'string' };
const strings = { type: 'array', items: str };
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

export const reviewSchema = obj({
  summary: str,
  riskLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
  risks: { type: 'array', items: obj({
    title: str,
    category: { type: 'string', enum: ['business', 'data', 'compatibility', 'release', 'operational', 'security', 'performance'] },
    severity: { type: 'string', enum: ['low', 'medium', 'high'] },
    evidence: str,
    files: strings,
  }) },
  checkPlan: { type: 'array', items: obj({
    kind: { type: 'string', enum: ['business', 'technical'] },
    title: str,
    steps: strings,
    requirements: strings,
    existingTests: { type: 'array', items: obj({ file: str, name: str }) },
  }) },
  requirements: { type: 'array', items: obj({
    id: str,
    status: { type: 'string', enum: ['covered', 'partial', 'not_covered'] },
    tests: { type: 'array', items: obj({ file: str, name: str }) },
    rationale: str,
  }) },
  uncoveredScenarios: { type: 'array', items: obj({ title: str, why: str, requirements: strings }) },
  suggestions: { type: 'array', items: obj({
    kind: { type: 'string', enum: ['test', 'code', 'config', 'docs'] },
    title: str,
    details: str,
    files: strings,
  }) },
});
