// Old application version vs. the candidate's migrations (expand/contract compatibility).
// The release in --namespace runs the OLD image. The candidate image applies its migrations
// as a Job while old pods serve traffic; old pods must keep working, survive a restart (their
// own init-container migration against the newer schema) and still read earlier orders.
// A negative control applies a deliberately breaking change to prove the smoke detects it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, THRESHOLDS, args, check, kjson, kubectl, now, scenario } from './lib.mjs';

const opts = args();
const ns = opts.namespace ?? 'rg-compat';
const release = opts.release ?? 'releaseguard';
const candidateImage = opts['candidate-image'] ?? 'releaseguard:local';
const limits = THRESHOLDS.migrationCompat;
const smokeSource = readFileSync(resolve(ROOT, 'scripts/scenarios/in-pod-smoke.cjs'), 'utf8');

const smoke = (ids = []) => {
  const out = kubectl(ns, ['exec', '-i', `deploy/${release}`, '-c', 'api', '--', 'node', '-', ...ids],
    { input: smokeSource, allowFailure: true, timeoutMs: (limits.smokeTimeoutSeconds + 30) * 1000 });
  const line = out.stdout.trim().split('\n').at(-1) ?? '';
  try { return JSON.parse(line); } catch { return { passed: false, error: (out.stderr || line).slice(-500) }; }
};
const psql = sql => kubectl(ns, ['exec', `statefulset/${release}-postgres`, '--', 'psql', '-U', 'releaseguard', '-d', 'releaseguard', '-v', 'ON_ERROR_STOP=1', '-tAc', sql]).stdout.trim();
const applied = () => psql('SELECT name FROM schema_migrations ORDER BY name').split('\n').filter(Boolean);
const imageOf = () => kjson(ns, ['get', 'deployment', release]).spec.template.spec.containers.find(c => c.name === 'api').image;

await scenario('migration-compat', { ...limits, candidateImage }, async report => {
  kubectl(ns, ['rollout', 'status', `deployment/${release}`, '--timeout=300s']);
  const oldImage = imageOf();
  report.measured.oldImage = oldImage;
  report.measured.candidateImage = candidateImage;
  report.measured.sameImage = oldImage === candidateImage;

  const baseline = smoke();
  check(report, 'old version passes business smoke before migration', 'passed', baseline, baseline.passed);
  const before = applied();

  const job = `${release}-candidate-migrate`;
  kubectl(ns, ['delete', 'job', job, '--ignore-not-found']);
  kubectl(ns, ['apply', '-f', '-'], { input: JSON.stringify({
    apiVersion: 'batch/v1', kind: 'Job', metadata: { name: job },
    spec: { backoffLimit: 0, template: {
      metadata: { labels: { 'releaseguard/client': release, 'sidecar.istio.io/inject': 'false' } },
      spec: { restartPolicy: 'Never', automountServiceAccountToken: false,
        securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
        containers: [{ name: 'migrate', image: candidateImage, imagePullPolicy: 'IfNotPresent', command: ['node', 'dist/migrate.js'],
          envFrom: [{ secretRef: { name: 'releaseguard-secrets' } }],
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } } }] } } },
  }) });
  report.timeline.push({ at: now(), event: 'candidate migration job started' });
  const waited = kubectl(ns, ['wait', '--for=condition=complete', `job/${job}`, `--timeout=${limits.migrationJobTimeoutSeconds}s`], { allowFailure: true });
  report.evidence.migrationJobLog = kubectl(ns, ['logs', `job/${job}`], { allowFailure: true }).stdout.slice(-4000);
  check(report, 'candidate migrations applied while old version serves traffic', 'Job complete', waited.status === 0 ? 'complete' : waited.stderr.trim(), waited.status === 0);
  const after = applied();
  report.measured.migrationsBefore = before.length;
  report.measured.newMigrations = after.filter(n => !before.includes(n));
  if (!report.measured.newMigrations.length) report.measured.note = 'The candidate adds no migrations relative to the old version; the check then covers runner idempotency only.';

  const running = smoke(baseline.orderId ? [baseline.orderId] : []);
  check(report, 'running old pods work on the migrated schema', 'passed, earlier order readable', running, running.passed);

  kubectl(ns, ['rollout', 'restart', `deployment/${release}`]);
  const restarted = kubectl(ns, ['rollout', 'status', `deployment/${release}`, '--timeout=300s'], { allowFailure: true });
  check(report, 'old version restarts (its migration runner accepts the newer schema)', 'rollout complete', restarted.status === 0 ? 'complete' : restarted.stderr.trim(), restarted.status === 0);
  const afterRestart = smoke([baseline.orderId, running.orderId].filter(Boolean));
  check(report, 'restarted old version passes business smoke', 'passed', afterRestart, afterRestart.passed);

  // Negative control: an incompatible (contract) change must be caught by the same smoke.
  psql('ALTER TABLE orders RENAME COLUMN product_id TO product_ref');
  report.timeline.push({ at: now(), event: 'negative control: product_id renamed' });
  let broken;
  try { broken = smoke(); } finally { psql('ALTER TABLE orders RENAME COLUMN product_ref TO product_id'); }
  report.timeline.push({ at: now(), event: 'negative control reverted' });
  check(report, 'negative control: breaking rename is detected', 'smoke fails', broken, !broken.passed);
  const recovered = smoke();
  check(report, 'schema restored after negative control', 'passed', recovered, recovered.passed);
});
